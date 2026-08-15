/**
 * dsh-plugin-onebot 主插件：DeepSeek Harness 任务完成后，通过 OneBot
 * （NapCat / go-cqhttp / Lagrange 等）通知指定 QQ 用户或群组。
 *
 * - 连接：WS 长连接（默认 server 模式，插件作为 WS 服务端等 NapCat 反向 WS 接入，
 *   也可 client 模式主动连接，或 off 关闭）；HTTP 调用 OneBot API 执行发送行为。
 * - 触发：默认监听 agent/status（agent 转为 idle = 整个任务完成）通知一次；
 *   可切换 notifyOn: 'turn' 监听 session/event 的 turn/end 逐回合通知。
 * - 工具：注册 notify_onebot，让模型在任务过程中/结尾主动给指定用户或群发消息。
 * - 配置页：通过 dsh-settings 注册设置命名空间，Web UI「设置 → 插件」页面可直接
 *   编辑配置，保存后写入 settings.yaml 并即时生效（WS 连接参数重启后生效）。
 *
 * 加载契约：模块具名导出 apply(ctx, config)；框架在依赖（inject）就绪后调用 apply，
 * 卸载时自动回收所有通过 ctx 注册的监听器与 effect。
 * @module dsh-plugin-onebot
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Session } from '@deepseek-ai/dsh-session'
import { OneBotService } from './service'
import { renderTemplate, summarizeSession, truncate, type CompletionStatus } from './notify'
import type { HttpConfig, NotifyConfig, OneBotTarget, WsConfig } from './types'

export type { HttpConfig, NotifyConfig, OneBotTarget, WsConfig } from './types'
export { renderTemplate, summarizeSession, truncate, extractAssistantText, type CompletionStatus } from './notify'
export { OneBotService } from './service'
export type { OneBotServiceConfig, OneBotResponse, OneBotEvent, OneBotHttpError, OneBotActionError } from './service'

/** 插件显示名（诊断日志中使用）。 */
export const name = 'dsh-plugin-onebot'

/** 依赖的服务：tools 就绪后本插件才会加载。 */
export const inject = ['tools']

/** 插件配置：部署时通过 cordis.yml 或 Web UI 设置页覆盖。 */
export interface Config {
  http: HttpConfig
  ws: WsConfig
  notify: NotifyConfig
}

/** 设置命名空间：Web UI「设置 → 插件」页面按此注册配置表单。 */
export const ONEBOT_SETTINGS_NAMESPACE = settingsNamespace('dsh-plugin-onebot')

/** Schemastery 配置 schema：校验 + 默认值，配置非法时加载响亮失败。 */
export const Config: Schema<Config> = Schema.object({
  http: Schema.object({
    url: Schema.string()
      .description('OneBot HTTP API 根地址（NapCat 默认 http://127.0.0.1:3000）')
      .default('http://127.0.0.1:3000'),
    token: Schema.string()
      .description('HTTP API 访问令牌（Authorization: Bearer），留空则不携带')
      .role('secret')
      .default(''),
    timeoutMs: Schema.natural().description('单次请求超时（毫秒）').default(10_000),
  }),
  ws: Schema.object({
    mode: Schema.union(['server', 'client', 'off'])
      .description('server：插件作为 WS 服务端等 NapCat 反向 WS 接入；client：主动连接 NapCat 正向 WS；off：关闭长连接')
      .default('server'),
    host: Schema.string()
      .description('server 模式监听地址（0.0.0.0 表示所有网卡）；client 模式为 NapCat 地址')
      .default('0.0.0.0'),
    port: Schema.natural().description('server 模式监听端口；client 模式为 NapCat 端口').default(8080),
    path: Schema.string().description('WS 路径').default('/ws'),
    token: Schema.string()
      .description('WS 鉴权令牌（server 模式校验接入方；client 模式作为 Authorization 头发送），留空则不鉴权')
      .role('secret')
      .default(''),
    reconnectInterval: Schema.natural().description('断线重连间隔（毫秒），仅 client 模式').default(3000),
  }),
  notify: Schema.object({
    notifyOn: Schema.union(['idle', 'turn'])
      .description('idle：整个任务完成通知一次；turn：每个完成/出错的回合结束时通知')
      .default('idle'),
    onError: Schema.boolean().description('出错（回合 reason 为 error）时也通知').default(true),
    includeSubagents: Schema.boolean()
      .description('是否包含子 agent（subagent）的完成事件；默认只通知顶层 agent')
      .default(false),
    targets: Schema.array(Schema.object({
      type: Schema.union(['private', 'group']).description('private = QQ 号，group = 群号').default('private'),
      id: Schema.string().default(''),
    })).description('默认通知目标列表').default([]),
    template: Schema.string()
      .description('消息模板，占位符：{sessionId} {summary} {status} {time}')
      .default('【任务完成】\n会话: {sessionId}\n状态: {status}\n\n{summary}'),
    maxLength: Schema.natural().description('渲染后消息最大长度，超出截断').default(2000),
    retries: Schema.natural().description('HTTP 发送失败重试次数（指数退避）').default(3),
    retryDelayMs: Schema.natural().description('重试基础延迟（毫秒）').default(1000),
    verbose: Schema.boolean().description('是否打印调试日志').default(false),
  }),
})

/** 是否跳过子 agent 会话（origin 为 subagent 或 delegationDepth > 0）。 */
function isSubagent(session: Session): boolean {
  return session.header.origin === 'subagent' || (session.header.delegationDepth ?? 0) > 0
}

/** 取会话最后一条 turn/end 的原因；没有则返回 undefined。 */
function lastTurnEndReason(session: Session): CompletionStatus | undefined {
  const events = session.events
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event && event.type === 'turn/end') return event.data.reason.kind
  }
  return undefined
}

/** 按配置渲染一条完成通知。 */
function renderNotification(config: Config, session: Session, reason: CompletionStatus, time: number): string {
  return truncate(renderTemplate(config.notify.template, {
    sessionId: session.id,
    status: reason,
    summary: summarizeSession(session) || '（无文本输出）',
    time,
  }), config.notify.maxLength)
}

/** 向所有默认目标发送一条通知（逐个目标容错，失败仅记录）。 */
async function sendNotifications(onebot: OneBotService, config: Config, message: string): Promise<void> {
  if (config.notify.targets.length === 0) {
    if (config.notify.verbose) console.log(`[${name}] no targets configured, skip notification`)
    return
  }
  for (const target of config.notify.targets) {
    try {
      await onebot.sendMsg(target, message)
      if (config.notify.verbose) console.log(`[${name}] notified ${target.type}:${target.id}`)
    } catch (error) {
      console.error(`[${name}] failed to notify ${target.type}:${target.id}: ${(error as Error).message}`)
    }
  }
}

/** 插件主体：所有注册都是 effect，随插件卸载自动回收。 */
export function apply(ctx: Context, config: Config): void {
  // 1) 配置源：Web UI 设置页（settings 服务）优先，否则用 cordis.yml 组合配置。
  //    运行时全部按 current() 现读，因此 notify/http 改动即时生效；WS 连接参数
  //    （server/client 的监听/连接地址）在下次启动时生效。
  let current: () => Config = () => config
  installSettingsSection(ctx, ONEBOT_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
  })

  // 2) OneBot 服务（HTTP 行为 + WS 长连接），配置通过访问器实时读取。
  const onebot = new OneBotService(ctx, () => current())
  ctx.effect(() => {
    onebot.start()
    return () => onebot.stop()
  })

  // 3) 任务完成自动通知。
  //    idle 模式：只在 agent 真正运行过（running→idle）后通知，避免启动即 idle 误报。
  const ran = new Set<object>()
  ctx.on('agent/status', ({ agent, status }) => {
    const cfg = current()
    if (cfg.notify.notifyOn !== 'idle') return
    if (status === 'running') {
      ran.add(agent)
      return
    }
    if (!ran.delete(agent)) return
    const session = agent.session
    const reason = lastTurnEndReason(session)
    if (reason !== 'completed' && !(cfg.notify.onError && reason === 'error')) return
    if (!cfg.notify.includeSubagents && isSubagent(session)) return
    void sendNotifications(onebot, cfg, renderNotification(cfg, session, reason, Date.now()))
  })

  //    turn 模式：每个完成/出错的回合结束都通知。
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const cfg = current()
    if (cfg.notify.notifyOn !== 'turn') return
    const reason = event.data.reason.kind
    if (reason !== 'completed' && !(cfg.notify.onError && reason === 'error')) return
    if (!cfg.notify.includeSubagents && isSubagent(session)) return
    void sendNotifications(onebot, cfg, renderNotification(cfg, session, reason, event.time))
  })

  // 4) 模型可主动调用的通知工具。
  ctx.tools.register(defineTool({
    name: 'notify_onebot',
    description: 'Send a message to a OneBot user or group (QQ). Use when the task completes and the result should be pushed to a specific person or group, or when the user asks to message them. Message supports CQ codes like [CQ:at,qq=123].',
    parameters: {
      message: { type: 'string', required: true, description: 'The message content to send (supports CQ codes).' },
      targetType: {
        type: 'string',
        enum: ['private', 'group'],
        description: 'Target type. Omit together with targetId to use the configured default targets.',
      },
      targetId: {
        type: 'string',
        description: 'QQ number (private) or group number (group). Pair with targetType.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const cfg = current()
      const targets: OneBotTarget[] =
        args.targetType !== undefined && args.targetId !== undefined
          ? [{ type: args.targetType, id: args.targetId }]
          : cfg.notify.targets
      if (targets.length === 0) return '未配置任何通知目标'
      const results: string[] = []
      for (const target of targets) {
        try {
          const res = await onebot.sendMsg(target, args.message)
          results.push(`${target.type}:${target.id} → ok(retcode=${res.retcode})`)
        } catch (error) {
          results.push(`${target.type}:${target.id} → 失败: ${(error as Error).message}`)
        }
      }
      return results.join('\n')
    },
  }))
}
