/**
 * dsh-plugin-onebot 的浏览器半边（client plugin）：在 设置 → 插件 → Configurable
 * 里注册一张配置卡片，让 http / ws / notify 全部配置项可以在 GUI 里点击修改。
 *
 * UI 结构与样式对齐 dsh-plugin-template 的 src/client.ts 与 harness 内置卡片
 * （PluginCard / ValueField）：可折叠卡片头、字段上下堆叠（标签行 + 控件 + 提示）、
 * 每段"已覆盖"徽标与重置、右下角 放弃/保存。颜色全部走主题变量 --dsw-alias-*。
 *
 * 工作方式：
 * - host 半边（src/index.ts）用 installSettingsSection 把配置注册成 settings 命名空间
 *   `dsh-plugin-onebot`（cordis.yml 配置是 composition base 层）；
 * - 本文件在 `settings.plugin.item` 插槽注册卡片，通过 `settingsScope` 服务绑定该
 *   命名空间，读取解析值、展示表单、把用户改动写进用户设置文档（revision 防并发）；
 * - host 半边通过 thunk 实时读取命名空间解析值，因此保存后 notify/http 改动立即生效，
 *   WS 连接参数在下次启动时生效。
 *
 * 加载契约：与 host 半边同包，经 package.json 的 `dsh.client` 声明 +
 * `exports["./client"]` 被 dsh 的 client-modules 发现，浏览器加载构建产物
 * lib/client.js（CJS + __ModuleLoader__.load 握手，见 tsdown.config.ts）。
 * 注意：client 半边只在插件以"包名"安装进 profile 时才会加载；`--patch` overlay
 * 用绝对源码路径挂载的插件行不会加载 client 半边。
 *
 * 依赖纪律：运行时只 import react（浏览器平台模块表提供），其余一律走 ctx 服务，
 * 不直接 import 任何 @deepseek-ai 客户端包。
 * @module dsh-plugin-onebot/client
 */

import React from 'react'
import type { Context } from '@deepseek-ai/cordis'

// ---- 最小结构类型（运行时实例来自 ctx 服务）----

/** 一个 settings 命名空间在浏览器侧的同步快照（SettingsScopeSnapshot 的结构子集）。 */
interface SettingsSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  /** 最近一次 schema 解析后的值（schema 默认 → base → 用户层）；首个接受值之前为 undefined。 */
  value: unknown
  /** 原始用户层（已存储）；字段在此出现即视为"用户覆盖"。 */
  user: unknown
  /** Host 文档是否可写（memory 模式永远不可写）。 */
  writable: boolean
}

/** 浏览器侧 settings scope 的最小面（dsh-client-runtime SettingsScope 的结构子集）。 */
interface SettingsScopeLike {
  getSnapshot(): SettingsSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** settingsScope 服务的最小面（dsh-client-ui-settings SettingsScopeBinder）。 */
interface SettingsScopeBinderLike {
  bind(spec: { namespace: string }): SettingsScopeLike
}

/** 本文件只注入一个 <style>；tsconfig 没有 dom lib，这里声明用到的 DOM 形状。 */
declare const document: {
  createElement(tag: 'style'): { dataset: Record<string, string>; textContent: string }
  head: { appendChild(node: { dataset: Record<string, string>; textContent: string }): void }
}

// ---- 字段与分组声明 ----

type SectionName = 'http' | 'ws' | 'notify'
type FieldKind = 'text' | 'number' | 'checkbox' | 'select'

interface FieldSpec {
  section: SectionName
  key: string
  kind: FieldKind
  label: string
  hint: string
  /** select 的可选项。 */
  options?: readonly { value: string; label: string }[]
  /** 数字解析失败时的提示。 */
  invalidLabel?: string
  /** 密码输入框（token）。 */
  secret?: boolean
  /** 多行文本。 */
  textarea?: boolean
}

interface SectionSpec {
  name: SectionName
  label: string
  hint: string
}

const SECTIONS: readonly SectionSpec[] = [
  { name: 'http', label: 'HTTP 连接（执行行为）', hint: 'OneBot HTTP API 地址与鉴权，实际发送通知走这里。' },
  { name: 'ws', label: 'WS 长连接', hint: '接收事件/探活；改动在下次启动时生效。' },
  { name: 'notify', label: '通知设置', hint: '任务完成后的自动通知行为。' },
]

const FIELDS: readonly FieldSpec[] = [
  // HTTP
  { section: 'http', key: 'url', kind: 'text', label: 'HTTP API 地址', hint: '例如 http://127.0.0.1:3000' },
  { section: 'http', key: 'token', kind: 'text', label: 'HTTP token', hint: 'Authorization: Bearer；留空则不携带', secret: true },
  { section: 'http', key: 'timeoutMs', kind: 'number', label: '请求超时（毫秒）', hint: '单次 HTTP 请求超时', invalidLabel: '必须是非负整数' },

  // WS
  {
    section: 'ws', key: 'mode', kind: 'select', label: '连接模式',
    hint: 'server：插件作为 WS 服务端等 NapCat 反向 WS 接入；client：主动连 NapCat 正向 WS；off：关闭长连接',
    options: [
      { value: 'server', label: 'server（插件做 WS 服务端）' },
      { value: 'client', label: 'client（连 NapCat 正向 WS）' },
      { value: 'off', label: 'off（关闭长连接）' },
    ],
  },
  { section: 'ws', key: 'host', kind: 'text', label: '主机', hint: 'server：监听地址（0.0.0.0 表示所有网卡）；client：NapCat 地址' },
  { section: 'ws', key: 'port', kind: 'number', label: '端口', hint: 'server：监听端口；client：NapCat 端口', invalidLabel: '必须是非负整数' },
  { section: 'ws', key: 'path', kind: 'text', label: '路径', hint: '例如 /ws' },
  { section: 'ws', key: 'token', kind: 'text', label: 'WS token', hint: 'server：校验接入方；client：作为 Authorization 头发送', secret: true },
  { section: 'ws', key: 'reconnectInterval', kind: 'number', label: '重连间隔（毫秒）', hint: '仅 client 模式断线重连', invalidLabel: '必须是非负整数' },

  // notify
  {
    section: 'notify', key: 'notifyOn', kind: 'select', label: '通知时机',
    hint: 'idle：整个任务完成通知一次；turn：每个完成/出错的回合结束时通知',
    options: [
      { value: 'idle', label: 'idle（任务完成通知一次）' },
      { value: 'turn', label: 'turn（每回合通知）' },
    ],
  },
  { section: 'notify', key: 'template', kind: 'text', label: '消息模板', hint: '占位符：{sessionId} {summary} {status} {time}', textarea: true },
  { section: 'notify', key: 'maxLength', kind: 'number', label: '消息最大长度', hint: '渲染后超出截断', invalidLabel: '必须是非负整数' },
  { section: 'notify', key: 'retries', kind: 'number', label: '发送重试次数', hint: 'HTTP 失败重试（指数退避）', invalidLabel: '必须是非负整数' },
  { section: 'notify', key: 'retryDelayMs', kind: 'number', label: '重试基础延迟（毫秒）', hint: '指数退避基础间隔', invalidLabel: '必须是非负整数' },
  { section: 'notify', key: 'onError', kind: 'checkbox', label: '出错也通知', hint: '回合 reason 为 error 时也发送通知' },
  { section: 'notify', key: 'includeSubagents', kind: 'checkbox', label: '包含子 agent', hint: '默认只通知顶层 agent，避免重复通知' },
  { section: 'notify', key: 'verbose', kind: 'checkbox', label: '调试日志', hint: '打印连接与通知日志' },
]

/** 通知目标行。 */
interface TargetRow {
  type: 'private' | 'group'
  id: string
}

// ---- 暂存表单模型 ----

interface CardShell {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}

/** 暂存表单：编辑只进草稿，Save 是唯一写入点；字段按所属 section 整体写入/清除。 */
class ConfigForm {
  /** 每个 section 的草稿对象（基于 resolved 克隆后修改，保存时整段 set）。 */
  private readonly staged = new Map<SectionName, Record<string, unknown>>()
  /** 文本/数字字段的原始输入，保证解析失败时输入不丢失。 */
  private readonly raw = new Map<string, string>()
  /** 解析失败的字段标记（`${section}.${key}`）。 */
  private readonly invalidFields = new Set<string>()
  /** 保存时 unset 回退 composition base 层的 section。 */
  private readonly resetSections = new Set<SectionName>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  constructor(private readonly scope: SettingsScopeLike) {
    scope.subscribe(() => this.publish())
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  shell(): CardShell {
    const snapshot = this.scope.getSnapshot()
    const targets = this.targets()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.staged.size > 0 || this.resetSections.size > 0,
      invalid: this.invalidFields.size > 0 || targets.some((target) => target.id.trim() === ''),
      saving: this.saving,
      failed: this.failed,
    }
  }

  /** 当前生效的 section 值（草稿优先，否则 resolved）。 */
  section(section: SectionName): Record<string, unknown> {
    return this.staged.get(section) ?? this.resolvedSection(section)
  }

  /** 文本/数字/select 字段的显示值（保留未解析的原始输入）。 */
  textValue(section: SectionName, key: string): string {
    const marker = this.marker(section, key)
    const raw = this.raw.get(marker)
    if (raw !== undefined) return raw
    return this.format(this.section(section)[key])
  }

  /** checkbox 字段的显示值。 */
  boolValue(section: SectionName, key: string): boolean {
    return this.section(section)[key] === true
  }

  /** 数字字段当前输入是否无效。 */
  numberInvalid(section: SectionName, key: string): boolean {
    const spec = this.spec(section, key)
    return spec.kind === 'number' && !/^\d+$/.test(this.textValue(section, key))
  }

  /** 编辑文本/数字/select 字段。 */
  edit(section: SectionName, key: string, text: string): void {
    const marker = this.marker(section, key)
    const spec = this.spec(section, key)
    const next = { ...this.section(section) }
    this.raw.set(marker, text)
    if (spec.kind === 'number') {
      if (text === '' || !/^\d+$/.test(text)) {
        this.invalidFields.add(marker)
      } else {
        this.invalidFields.delete(marker)
        next[key] = Number(text)
      }
    } else {
      next[key] = text
    }
    this.staged.set(section, next)
    this.failed = false
    this.publish()
  }

  /** 切换 checkbox 字段。 */
  toggle(section: SectionName, key: string, value: boolean): void {
    const next = { ...this.section(section) }
    next[key] = value
    this.staged.set(section, next)
    this.failed = false
    this.publish()
  }

  /** 该 section 是否被用户覆盖（在用户层存在即视为覆盖）。 */
  overridden(section: SectionName): boolean {
    const user = this.scope.getSnapshot().user
    return typeof user === 'object' && user !== null && Object.prototype.hasOwnProperty.call(user, section)
  }

  /** 重置一个 section：丢弃草稿，保存时 unset 回退 composition base 层。 */
  resetSection(section: SectionName): void {
    this.staged.delete(section)
    this.resetSections.add(section)
    for (const marker of [...this.raw.keys()]) {
      if (marker.startsWith(`${section}.`)) this.raw.delete(marker)
    }
    this.failed = false
    this.publish()
  }

  /** 当前生效的通知目标列表。 */
  targets(): TargetRow[] {
    const value = this.section('notify').targets
    if (!Array.isArray(value)) return []
    return value.map((row) => {
      const record = typeof row === 'object' && row !== null ? row as Record<string, unknown> : {}
      return {
        type: record.type === 'group' ? 'group' : 'private',
        id: typeof record.id === 'string' ? record.id : '',
      }
    })
  }

  editTarget(index: number, key: 'type' | 'id', value: string): void {
    const next = { ...this.section('notify') }
    next.targets = this.targets().map((row, i) => (i === index ? { ...row, [key]: value } : row))
    this.staged.set('notify', next)
    this.failed = false
    this.publish()
  }

  addTarget(): void {
    const next = { ...this.section('notify') }
    next.targets = [...this.targets(), { type: 'private', id: '' }]
    this.staged.set('notify', next)
    this.failed = false
    this.publish()
  }

  removeTarget(index: number): void {
    const next = { ...this.section('notify') }
    next.targets = this.targets().filter((_, i) => i !== index)
    this.staged.set('notify', next)
    this.failed = false
    this.publish()
  }

  /** 丢弃所有暂存编辑。 */
  discard(): void {
    if (this.staged.size === 0 && this.resetSections.size === 0 && !this.failed) return
    this.staged.clear()
    this.resetSections.clear()
    this.raw.clear()
    this.invalidFields.clear()
    this.failed = false
    this.publish()
  }

  /** 写入每一个暂存 section（reset 的 unset，staged 的 set）。 */
  async save(): Promise<void> {
    if (this.saving || this.invalidFields.size > 0 || this.targets().some((target) => target.id.trim() === '')) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const section of this.resetSections) {
      try {
        await this.scope.unset(section)
      } catch {
        landed = false
      }
    }
    for (const [section, value] of this.staged) {
      try {
        await this.scope.set(section, value)
      } catch {
        landed = false
      }
    }
    this.staged.clear()
    this.resetSections.clear()
    this.raw.clear()
    this.invalidFields.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private marker(section: SectionName, key: string): string {
    return `${section}.${key}`
  }

  private resolvedSection(section: SectionName): Record<string, unknown> {
    const value = this.scope.getSnapshot().value
    const root = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
    const sectionValue = root[section]
    return typeof sectionValue === 'object' && sectionValue !== null && !Array.isArray(sectionValue)
      ? sectionValue as Record<string, unknown>
      : {}
  }

  private spec(section: SectionName, key: string): FieldSpec {
    const spec = FIELDS.find((candidate) => candidate.section === section && candidate.key === key)
    if (spec === undefined) throw new Error(`card has no field ${section}.${key}`)
    return spec
  }

  private format(value: unknown): string {
    if (typeof value === 'number' || typeof value === 'string') return String(value)
    return ''
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

// ---- 卡片 UI（结构与样式对齐 dsh-plugin-template 的卡片）----

/** 本插件的 settings 命名空间（与 host 半边 ONEBOT_SETTINGS_NAMESPACE 一致）。 */
const NAMESPACE = 'dsh-plugin-onebot'

/** 依赖的服务：slots 就绪后本插件才会加载。 */
export const inject = ['slots']

/**
 * 客户端插件主体：绑定命名空间、构建暂存表单、注册配置卡片到 `settings.plugin.item` 插槽。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: Context): void {
  const slots = ctx.get('slots')
  if (slots === undefined) return

  let form: ConfigForm | undefined
  const settingsScope: SettingsScopeBinderLike | undefined = ctx.get('settingsScope')
  if (settingsScope === undefined) {
    console.warn(`[${NAMESPACE}] settingsScope service absent; the config card is disabled`)
  } else {
    form = new ConfigForm(settingsScope.bind({ namespace: NAMESPACE }))
  }

  injectStyles()

  slots.inject('settings.plugin.item', () => slots.register(
    { name: 'settings.plugin.item', id: NAMESPACE, order: 30, label: NAMESPACE },
    () => React.createElement(ConfigCard, { form }),
  ))
}

/** 配置卡片：可折叠头 + 字段列表 + 保存/放弃。命名空间不可用时渲染为空（同内置卡片）。 */
function ConfigCard({ form }: { form: ConfigForm | undefined }): React.ReactElement | null {
  const [, forceRender] = React.useReducer((count: number) => count + 1, 0)
  React.useEffect(() => (form === undefined ? undefined : form.subscribe(forceRender)), [form])
  if (form === undefined) return null

  const shell = form.shell()
  if (!shell.available) return null

  const [open, setOpen] = React.useState(false)
  const blocked = !shell.dirty || shell.invalid || shell.saving

  return React.createElement(
    'li',
    { className: open ? 'dshob-card dshob-card-open' : 'dshob-card' },
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'dshob-header',
        'aria-expanded': open,
        onClick: () => setOpen(!open),
      },
      React.createElement(
        'span',
        { className: 'dshob-head-text' },
        React.createElement('span', { className: 'dshob-name' }, 'dsh-plugin-onebot'),
        React.createElement('span', { className: 'dshob-description' }, 'OneBot 任务完成通知：HTTP 行为 + WS 长连接'),
      ),
      shell.dirty ? React.createElement('span', { className: 'dshob-pending' }, '未保存') : null,
      React.createElement('span', { className: open ? 'dshob-chevron dshob-chevron-open' : 'dshob-chevron' }),
    ),
    open
      ? React.createElement(
        'div',
        { className: 'dshob-body' },
        !shell.writable
          ? React.createElement('p', { className: 'dshob-read-only', role: 'status' }, '当前设置文档只读（memory 模式或只读 provider）')
          : null,
        SECTIONS.map((section) => renderSection(form, section, shell)),
        React.createElement(
          'div',
          { className: 'dshob-footer' },
          shell.failed
            ? React.createElement('p', { className: 'dshob-failed', role: 'status' }, '保存失败，草稿已保留，请修正后重试')
            : null,
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dshob-discard',
              disabled: !shell.dirty || shell.saving,
              onClick: () => form.discard(),
            },
            '放弃',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dshob-save',
              disabled: blocked,
              onClick: () => { void form.save() },
            },
            shell.saving ? '保存中…' : '保存',
          ),
        ),
      )
      : null,
  )
}

/** 一个分组的渲染：分组头（标题 + 已覆盖徽标 + 重置）+ 该组的字段行。 */
function renderSection(
  form: ConfigForm,
  section: SectionSpec,
  shell: CardShell,
): React.ReactElement {
  const children: React.ReactNode[] = [
    React.createElement(
      'div',
      { className: 'dshob-group-head' },
      React.createElement(
        'div',
        { className: 'dshob-group-text' },
        React.createElement('span', { className: 'dshob-group-label' }, section.label),
        React.createElement('span', { className: 'dshob-group-hint' }, section.hint),
      ),
      form.overridden(section.name)
        ? React.createElement(
          'span',
          { className: 'dshob-badges' },
          React.createElement('span', { className: 'dshob-badge' }, '已覆盖'),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dshob-reset',
              disabled: !shell.writable,
              onClick: () => form.resetSection(section.name),
            },
            '重置',
          ),
        )
        : null,
    ),
  ]
  for (const field of FIELDS) {
    if (field.section !== section.name) continue
    children.push(renderField(form, field, shell))
  }
  if (section.name === 'notify') children.push(renderTargets(form, shell))
  return React.createElement('section', { className: 'dshob-group' }, ...children)
}

/** 单个字段行：标签 + 控件 + 提示（与模板 dtpl-field 相同的堆叠结构）。 */
function renderField(form: ConfigForm, spec: FieldSpec, shell: CardShell): React.ReactElement {
  const id = `dshob-${spec.section}-${spec.key}`
  const invalid = form.numberInvalid(spec.section, spec.key)
  const disabled = !shell.writable

  let control: React.ReactNode
  if (spec.kind === 'checkbox') {
    control = React.createElement('input', {
      id,
      type: 'checkbox',
      className: 'dshob-checkbox',
      disabled,
      checked: form.boolValue(spec.section, spec.key),
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        form.toggle(spec.section, spec.key, (event.target as unknown as { checked: boolean }).checked),
    })
  } else if (spec.kind === 'select') {
    control = React.createElement(
      'select',
      {
        id,
        className: 'dshob-input',
        disabled,
        value: form.textValue(spec.section, spec.key),
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          form.edit(spec.section, spec.key, (event.target as unknown as { value: string }).value),
      },
      (spec.options ?? []).map((option) =>
        React.createElement('option', { key: option.value, value: option.value }, option.label)),
    )
  } else if (spec.textarea) {
    control = React.createElement('textarea', {
      id,
      className: 'dshob-input dshob-textarea',
      rows: 3,
      disabled,
      value: form.textValue(spec.section, spec.key),
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        form.edit(spec.section, spec.key, (event.target as unknown as { value: string }).value),
    })
  } else {
    control = React.createElement('input', {
      id,
      type: spec.secret ? 'password' : 'text',
      className: invalid ? 'dshob-input dshob-input-invalid' : 'dshob-input',
      ...(spec.kind === 'number' ? { inputMode: 'numeric' as const } : {}),
      ...(invalid ? { 'aria-invalid': true } : {}),
      disabled,
      value: form.textValue(spec.section, spec.key),
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        form.edit(spec.section, spec.key, (event.target as unknown as { value: string }).value),
    })
  }

  return React.createElement(
    'div',
    { className: 'dshob-field' },
    React.createElement(
      'div',
      { className: 'dshob-field-head' },
      React.createElement('label', { className: 'dshob-label', htmlFor: id }, spec.label),
    ),
    control,
    React.createElement(
      'p',
      { className: invalid ? 'dshob-invalid' : 'dshob-hint' },
      invalid ? spec.invalidLabel ?? '无效的值' : spec.hint,
    ),
  )
}

/** 通知目标列表编辑器：类型 + QQ/群号 + 删除，底部添加。 */
function renderTargets(form: ConfigForm, shell: CardShell): React.ReactElement {
  const targets = form.targets()
  const disabled = !shell.writable
  const rows = targets.map((target, index) =>
    React.createElement(
      'div',
      { className: 'dshob-target-row', key: index },
      React.createElement(
        'select',
        {
          className: 'dshob-input dshob-target-type',
          disabled,
          value: target.type,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
            form.editTarget(index, 'type', (event.target as unknown as { value: string }).value === 'group' ? 'group' : 'private'),
        },
        React.createElement('option', { value: 'private' }, '私聊'),
        React.createElement('option', { value: 'group' }, '群聊'),
      ),
      React.createElement('input', {
        type: 'text',
        className: 'dshob-input dshob-target-id',
        placeholder: 'QQ 号 / 群号',
        disabled,
        value: target.id,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          form.editTarget(index, 'id', (event.target as unknown as { value: string }).value),
      }),
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'dshob-target-remove',
          disabled,
          onClick: () => form.removeTarget(index),
        },
        '删除',
      ),
    ),
  )
  return React.createElement(
    'div',
    { className: 'dshob-field dshob-targets' },
    React.createElement(
      'div',
      { className: 'dshob-field-head' },
      React.createElement('span', { className: 'dshob-label' }, '通知目标'),
    ),
    rows,
    targets.some((target) => target.id.trim() === '')
      ? React.createElement('p', { className: 'dshob-invalid', role: 'status' }, '每个目标的 QQ 号/群号不能为空')
      : null,
    React.createElement('p', { className: 'dshob-hint' }, '任务完成时通知这些私聊/群组；留空则只依赖 notify_onebot 工具显式指定目标。'),
    React.createElement(
      'button',
      { type: 'button', className: 'dshob-target-add', disabled, onClick: () => form.addTarget() },
      '+ 添加目标',
    ),
  )
}

// ---- 样式：对齐 dsh-plugin-template 卡片（class 前缀 dshob-，颜色全走主题变量）----

let stylesInjected = false

function injectStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  const tag = document.createElement('style')
  tag.dataset.dshob = 'true'
  tag.dataset.pluginCss = `${NAMESPACE}/card`
  tag.textContent = `
.dshob-card {
  list-style: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color .16s, background .16s;
}
.dshob-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.dshob-card-open { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-dimmed); }
.dshob-header {
  width: 100%; appearance: none; border: 0; background: none; font: inherit;
  color: inherit; text-align: left; cursor: pointer;
  display: flex; align-items: center; gap: 12px;
  padding: 14px 16px; border-radius: 12px;
}
.dshob-header:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshob-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dshob-name { font-size: 15px; font-weight: 600; line-height: 1.4; color: var(--dsw-alias-label-primary); }
.dshob-description { font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshob-chevron {
  flex: none; color: var(--dsw-alias-label-tertiary); transition: transform .16s;
  width: 8px; height: 8px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg); margin: -3px 4px 0 0;
}
.dshob-chevron-open { transform: rotate(225deg); }
.dshob-body { border-top: 1px solid var(--dsw-alias-border-l2); margin: 0 16px; padding-bottom: 8px; }
.dshob-read-only { margin: 12px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshob-pending {
  flex: none; border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px;
  font-weight: 500; white-space: nowrap;
  background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary);
}
.dshob-footer {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 12px 0 4px; border-top: 1px solid var(--dsw-alias-border-l2);
}
.dshob-failed { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.dshob-discard, .dshob-save {
  appearance: none; border: 1px solid transparent; border-radius: 8px;
  padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
}
.dshob-discard { border-color: var(--dsw-alias-border-l2); background: none; color: var(--dsw-alias-label-secondary); }
.dshob-discard:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
.dshob-save { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.dshob-discard:disabled, .dshob-save:disabled { opacity: 0.4; cursor: default; }
.dshob-discard:focus-visible, .dshob-save:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshob-group { padding: 4px 0 0; }
.dshob-group-head {
  display: flex; align-items: center; gap: 8px;
  padding: 14px 0 4px; border-top: 1px solid var(--dsw-alias-border-l2);
}
.dshob-group:first-child .dshob-group-head { border-top: 0; }
.dshob-group-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dshob-group-label { font-size: 13px; font-weight: 600; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dshob-group-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshob-badges { display: inline-flex; align-items: center; gap: 8px; }
.dshob-badge {
  border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; white-space: nowrap; font-weight: 500;
  background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary);
}
.dshob-reset { border: none; background: none; padding: 0; font: inherit; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dshob-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.dshob-reset:disabled { cursor: default; }
.dshob-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.dshob-field + .dshob-field { border-top: 1px solid var(--dsw-alias-border-l2); }
.dshob-field-head { display: flex; align-items: center; gap: 8px; }
.dshob-label { flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dshob-input {
  height: 34px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dshob-input:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dshob-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.dshob-input-invalid { border-color: var(--dsw-alias-state-error-primary); }
.dshob-textarea { height: auto; min-height: 68px; padding: 8px 12px; resize: vertical; }
.dshob-checkbox { width: 16px; height: 16px; accent-color: var(--dsw-alias-brand-primary); }
.dshob-invalid { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.dshob-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dshob-targets { gap: 8px; }
.dshob-target-row { display: flex; gap: 8px; align-items: center; }
.dshob-target-type { width: 110px; flex: none; }
.dshob-target-id { flex: 1; min-width: 0; }
.dshob-target-remove {
  flex: none; border: none; background: none; padding: 0 4px; font: inherit;
  font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.dshob-target-remove:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
.dshob-target-remove:disabled { cursor: default; }
.dshob-target-add {
  align-self: flex-start; appearance: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  padding: 5px 14px; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  background: none; color: var(--dsw-alias-label-secondary);
}
.dshob-target-add:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
.dshob-target-add:disabled { opacity: 0.4; cursor: default; }
`
  document.head.appendChild(tag)
}
