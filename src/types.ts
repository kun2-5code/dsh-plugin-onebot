/**
 * dsh-plugin-onebot 配置类型与共享类型。
 * @module dsh-plugin-onebot/types
 */

/** 通知目标：私聊或群聊。 */
export interface OneBotTarget {
  /** private = 私聊（QQ 号），group = 群聊（群号）。 */
  type: 'private' | 'group'
  /** QQ 号或群号，支持纯数字字符串或数字。 */
  id: string
}

/** OneBot HTTP API（执行行为）配置。 */
export interface HttpConfig {
  /** HTTP API 根地址，如 http://127.0.0.1:3000（NapCat 默认 3000）。 */
  url: string
  /** 访问令牌（Authorization: Bearer <token>），留空则不携带。 */
  token: string
  /** 单次请求超时（毫秒）。 */
  timeoutMs: number
}

/** OneBot WS 长连接（接收事件/探活）配置。 */
export interface WsConfig {
  /**
   * server：插件作为 WS 服务端，等待 NapCat「反向 WebSocket 客户端」接入（推荐）；
   * client：插件主动连接 NapCat「正向 WebSocket 服务端」；
   * off：关闭长连接（仍可用 HTTP 发通知）。
   */
  mode: 'server' | 'client' | 'off'
  /** server 模式监听地址（0.0.0.0 表示所有网卡）；client 模式为 NapCat 地址。 */
  host: string
  /** server 模式监听端口；client 模式为 NapCat 端口。 */
  port: number
  /** WS 路径，如 /ws。 */
  path: string
  /** WS 鉴权令牌（server 模式校验接入方；client 模式作为 Authorization 头发送），留空则不鉴权。 */
  token: string
  /** 断线重连间隔（毫秒），仅 client 模式使用。 */
  reconnectInterval: number
}

/** 任务完成通知行为配置。 */
export interface NotifyConfig {
  /** idle：agent 整体转为空闲（整个任务完成）时通知；turn：每个完成/出错的回合结束时通知。 */
  notifyOn: 'idle' | 'turn'
  /** 出错（回合 reason 为 error）时也通知。 */
  onError: boolean
  /** 是否包含子 agent（subagent）的完成事件；默认只通知顶层 agent，避免重复通知。 */
  includeSubagents: boolean
  /** 默认通知目标列表。 */
  targets: OneBotTarget[]
  /** 消息模板，占位符：{sessionId} {summary} {status} {time}。 */
  template: string
  /** 渲染后消息最大长度，超出截断。 */
  maxLength: number
  /** HTTP 发送失败重试次数（指数退避）。 */
  retries: number
  /** 重试基础延迟（毫秒）。 */
  retryDelayMs: number
  /** 是否打印调试日志。 */
  verbose: boolean
}
