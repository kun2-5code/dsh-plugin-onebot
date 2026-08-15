/**
 * OneBotService：向 dsh 提供 OneBot 能力（注册为 ctx.onebot）。
 *
 * - HTTP 执行行为：调用 OneBot v11 HTTP API（send_private_msg / send_group_msg /
 *   send_msg 等），携带 Authorization: Bearer <token>，失败自动重试（指数退避）。
 * - WS 长连接：server 模式（默认）插件作为 WS 服务端等待 NapCat 反向 WS 接入；
 *   client 模式插件主动连接 NapCat 正向 WS；off 关闭。收到的事件（heartbeat、
 *   message 等）通过 onEvent 订阅分发，连接状态通过 onStatus 订阅分发。
 * @module dsh-plugin-onebot/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { HttpConfig, NotifyConfig, OneBotTarget, WsConfig } from './types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    onebot: OneBotService
  }
}

export type { OneBotTarget } from './types'

/** OneBotService 构造函数接受的配置（Config 的结构子集）。 */
export interface OneBotServiceConfig {
  http: HttpConfig
  ws: WsConfig
  notify: Pick<NotifyConfig, 'verbose' | 'retries' | 'retryDelayMs'>
}

/** OneBot v11 API 响应体。 */
export interface OneBotResponse {
  status: 'ok' | 'failed' | string
  retcode: number
  data: unknown
  message?: string
  echo?: unknown
}

/** OneBot 推送事件（v11 常见字段），未识别的字段原样保留。 */
export interface OneBotEvent {
  post_type: string
  [key: string]: unknown
}

/** HTTP 传输层失败（网络错误、非 2xx 状态码、超时）。 */
export class OneBotHttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'OneBotHttpError'
  }
}

/** OneBot API 业务失败（retcode != 0）。 */
export class OneBotActionError extends Error {
  constructor(message: string, readonly retcode: number) {
    super(message)
    this.name = 'OneBotActionError'
  }
}

/** 把纯数字字符串归一化为 number（QQ 号/群号在安全整数范围内）。 */
function normalizeId(id: string | number): string | number {
  return typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id
}

/** 延迟工具。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** WS server 模式下用于心跳探活的附加状态。 */
interface AliveSocket {
  isAlive?: boolean
}

/**
 * OneBot 客户端服务：HTTP 行为 + WS 长连接。
 * 直接 `new OneBotService(ctx, config)` 即注册到 ctx.onebot，随插件卸载自动移除；
 * 显式调用 start()/stop() 管理 WS 资源（由主插件通过 ctx.effect 托管）。
 */
export class OneBotService extends Service {
  /** WS 长连接是否已建立（server 模式有接入方 / client 模式已连上）。 */
  connected = false

  private wss: WebSocketServer | undefined
  private client: WebSocket | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private readonly eventHandlers = new Set<(event: OneBotEvent) => void>()
  private readonly statusHandlers = new Set<(connected: boolean) => void>()

  constructor(ctx: Context, private readonly config: OneBotServiceConfig) {
    super(ctx, 'onebot')
  }

  private get verbose(): boolean {
    return this.config.notify.verbose
  }

  private log(message: string): void {
    if (this.verbose) console.log(`[dsh-plugin-onebot] ${message}`)
  }

  /** server 模式下实际监听端口（port: 0 由系统分配）；未启动或非 server 模式返回 undefined。 */
  get wsPort(): number | undefined {
    const address = this.wss?.address()
    return typeof address === 'object' && address !== null ? address.port : undefined
  }

  /** 启动 WS 长连接（按 ws.mode 决定 server/client/off）；重复调用是 no-op。 */
  start(): void {
    if (this.wss !== undefined || this.client !== undefined) return
    this.stopped = false
    const mode = this.config.ws.mode
    if (mode === 'server') this.startServer()
    else if (mode === 'client') this.connectClient()
    else this.log('WS long-connection disabled (mode=off), HTTP actions only')
  }

  /** 停止并释放全部资源：WS 服务端/客户端、重连与心跳定时器。 */
  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    if (this.wss) {
      for (const socket of this.wss.clients) socket.terminate()
      this.wss.close()
      this.wss = undefined
    }
    if (this.client) {
      this.client.terminate()
      this.client = undefined
    }
    this.setConnected(false)
    this.log('stopped')
  }

  /** 订阅 OneBot 推送事件，返回取消订阅函数。 */
  onEvent(handler: (event: OneBotEvent) => void): () => void {
    this.eventHandlers.add(handler)
    return () => { this.eventHandlers.delete(handler) }
  }

  /** 订阅 WS 连接状态变化（true=已连接 / false=断开），返回取消订阅函数。 */
  onStatus(handler: (connected: boolean) => void): () => void {
    this.statusHandlers.add(handler)
    return () => { this.statusHandlers.delete(handler) }
  }

  /** 发送私聊消息。 */
  sendPrivateMsg(userId: string | number, message: string, autoEscape = false): Promise<OneBotResponse> {
    return this.call('send_private_msg', { user_id: normalizeId(userId), message, auto_escape: autoEscape })
  }

  /** 发送群聊消息。 */
  sendGroupMsg(groupId: string | number, message: string, autoEscape = false): Promise<OneBotResponse> {
    return this.call('send_group_msg', { group_id: normalizeId(groupId), message, auto_escape: autoEscape })
  }

  /** 按目标类型发送消息（私聊/群聊）。 */
  sendMsg(target: OneBotTarget, message: string, autoEscape = false): Promise<OneBotResponse> {
    return target.type === 'private'
      ? this.sendPrivateMsg(target.id, message, autoEscape)
      : this.sendGroupMsg(target.id, message, autoEscape)
  }

  /** 调用任意 OneBot v11 动作，失败按 notify.retries 指数退避重试。 */
  async call(action: string, params: Record<string, unknown>): Promise<OneBotResponse> {
    let lastError: unknown
    const retries = Math.max(0, this.config.notify.retries)
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.request(action, params)
      } catch (error) {
        lastError = error
        if (attempt < retries && !this.stopped) {
          await delay(this.config.notify.retryDelayMs * (2 ** attempt))
        }
      }
    }
    throw lastError
  }

  private async request(action: string, params: Record<string, unknown>): Promise<OneBotResponse> {
    const { url, token, timeoutMs } = this.config.http
    const endpoint = `${url.replace(/\/+$/, '')}/${action}`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    let res: Response
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new OneBotHttpError(`请求 OneBot ${action} 失败: ${(error as Error).message}`)
    }
    if (!res.ok) {
      throw new OneBotHttpError(`请求 OneBot ${action} 返回 HTTP ${res.status}`, res.status)
    }
    let body: OneBotResponse
    try {
      body = (await res.json()) as OneBotResponse
    } catch {
      throw new OneBotHttpError(`OneBot ${action} 响应不是合法 JSON`, res.status)
    }
    if (body.status !== 'ok' || body.retcode !== 0) {
      throw new OneBotActionError(
        `OneBot ${action} 失败: status=${body.status} retcode=${body.retcode}${body.message ? ` message=${body.message}` : ''}`,
        body.retcode,
      )
    }
    return body
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return
    this.connected = value
    for (const handler of this.statusHandlers) {
      try { handler(value) } catch { /* 监听器错误不影响连接状态分发 */ }
    }
  }

  // ---- WS server 模式 ----

  private startServer(): void {
    const { host, port, path, token } = this.config.ws
    const wss = new WebSocketServer({
      host,
      port,
      path,
      maxPayload: 1 << 20,
      verifyClient: (info, done) => {
        if (!token || this.authorizationMatches(info.req, token)) {
          done(true)
          return
        }
        this.log(`WS connection rejected: bad access token`)
        done(false, 401, 'Unauthorized')
      },
    })
    this.wss = wss

    wss.on('listening', () => {
      this.log(`WS server listening on ws://${host}:${port}${path}`)
    })
    wss.on('error', (error) => {
      this.log(`WS server error: ${error.message}`)
    })
    wss.on('connection', (socket) => {
      const alive = socket as unknown as AliveSocket
      alive.isAlive = true
      socket.on('pong', () => { alive.isAlive = true })
      socket.on('message', (data) => { this.handleMessage(data) })
      socket.on('error', (error) => { this.log(`WS socket error: ${error.message}`) })
      socket.on('close', () => {
        this.log('WS client disconnected')
        this.setConnected(this.wss !== undefined && this.wss.clients.size > 0)
      })
      this.log('WS client connected')
      this.setConnected(true)
    })

    // 心跳探活：每 30s ping 一次，未响应（isAlive 为 false）则断开。
    this.heartbeatTimer = setInterval(() => {
      if (!this.wss) return
      for (const socket of this.wss.clients) {
        const alive = socket as unknown as AliveSocket
        if (alive.isAlive === false) {
          socket.terminate()
          continue
        }
        alive.isAlive = false
        socket.ping()
      }
    }, 30_000)
  }

  // ---- WS client 模式 ----

  private connectClient(): void {
    if (this.stopped) return
    const { host, port, path, token } = this.config.ws
    const normalizedPath = path.startsWith('/') ? path : `/${path}`
    const url = `ws://${host}:${port}${normalizedPath}`
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const client = new WebSocket(url, { headers })
    this.client = client
    client.on('open', () => {
      this.log(`WS connected to ${url}`)
      this.setConnected(true)
    })
    client.on('message', (data) => { this.handleMessage(data) })
    client.on('error', (error) => { this.log(`WS client error: ${error.message}`) })
    client.on('close', () => {
      this.log(`WS disconnected from ${url}`)
      this.setConnected(false)
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connectClient()
    }, this.config.ws.reconnectInterval)
  }

  // ---- 共享 ----

  /** 校验 WS 接入方的鉴权：Authorization: Bearer <token> 或查询参数 access_token。 */
  private authorizationMatches(request: IncomingMessage, token: string): boolean {
    const header = request.headers['authorization']
    if (header === `Bearer ${token}`) return true
    const url = new URL(request.url ?? '/', 'http://localhost')
    return url.searchParams.get('access_token') === token
  }

  private handleMessage(data: RawData): void {
    let event: OneBotEvent
    try {
      event = JSON.parse(data.toString()) as OneBotEvent
    } catch {
      return // 忽略非 JSON 帧（如心跳 ping/pong 之外的控制帧）
    }
    if (event === null || typeof event !== 'object' || typeof event.post_type !== 'string') return
    for (const handler of this.eventHandlers) {
      try { handler(event) } catch { /* 监听器错误不影响事件分发 */ }
    }
  }
}

export default OneBotService
