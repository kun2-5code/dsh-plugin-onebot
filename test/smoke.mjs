// 冒烟测试：验证主插件注册 notify_onebot 工具、任务完成自动通知（agent/status idle）、
// OneBotService 的 HTTP 发送与 WS server 长连接（心跳事件接收）。
// 运行：node test/smoke.mjs（先 pnpm build）
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import WebSocket from 'ws'
import { name, inject, apply } from '../lib/index.js'
import { OneBotService, OneBotHttpError } from '../lib/service.js'
import { renderTemplate, truncate, extractAssistantText } from '../lib/index.js'

// ---------- 1) mock OneBot HTTP 服务 ----------
const received = []
const httpServer = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    received.push({
      action: req.url,
      headers: req.headers,
      body: JSON.parse(body || '{}'),
    })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 100 + received.length } }))
  })
})
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const httpPort = httpServer.address().port
const httpUrl = `http://127.0.0.1:${httpPort}`

// ---------- 2) 基础配置 ----------
const config = {
  http: { url: httpUrl, token: 'secret-token', timeoutMs: 5000 },
  ws: { mode: 'off', host: '127.0.0.1', port: 0, path: '/ws', token: '', reconnectInterval: 500 },
  notify: {
    notifyOn: 'idle',
    onError: true,
    includeSubagents: false,
    targets: [{ type: 'private', id: '10001' }, { type: 'group', id: '20002' }],
    template: '【任务完成】\n会话: {sessionId}\n状态: {status}\n\n{summary}',
    maxLength: 500,
    retries: 1,
    retryDelayMs: 10,
    verbose: false,
  },
}

// ---------- 3) 最小可用 ctx ----------
const listeners = new Map()
const registered = []
const effects = []
const ctx = {
  tools: { register(definition) { registered.push(definition) } },
  reflect: { provide() { return () => {} } },
  on(event, fn) {
    listeners.set(event, fn)
    return () => listeners.delete(event)
  },
  effect(fn) {
    const disposer = fn() ?? (() => {})
    effects.push(disposer)
    return disposer
  },
}

apply(ctx, config)

assert.equal(name, 'dsh-plugin-onebot')
assert.deepEqual(inject, ['tools'])

// ---------- 4) 工具注册 + 执行（指定目标） ----------
const tool = registered.find((t) => t.name === 'notify_onebot')
assert.ok(tool, 'notify_onebot tool should be registered')

const result = await tool.execute({
  message: 'hello 私聊',
  targetType: 'private',
  targetId: '30003',
})
assert.match(result, /private:30003 → ok\(retcode=0\)/)
assert.equal(received.at(-1).action, '/send_private_msg')
assert.equal(received.at(-1).body.user_id, 30003)
assert.equal(received.at(-1).body.message, 'hello 私聊')
assert.equal(received.at(-1).headers.authorization, 'Bearer secret-token')

// ---------- 5) 任务完成自动通知（idle 模式） ----------
const statusListener = listeners.get('agent/status')
assert.ok(statusListener, 'agent/status listener should be registered')

const fakeSession = {
  id: 'sess-1',
  header: { origin: undefined, delegationDepth: undefined },
  events: [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ],
  deriveMessages: () => [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: '任务完成啦' }] },
  ],
}
const fakeAgent = { id: 'sess-1', session: fakeSession }

// 只 idle 不 running：不应通知
statusListener({ agent: fakeAgent, status: 'idle' })
await new Promise((r) => setTimeout(r, 30))
const before = received.length

// running → idle：应通知两个默认目标
statusListener({ agent: fakeAgent, status: 'running' })
statusListener({ agent: fakeAgent, status: 'idle' })
await new Promise((r) => setTimeout(r, 50))

const sent = received.slice(before)
assert.equal(sent.length, 2, 'two default targets should be notified')
assert.equal(sent[0].action, '/send_private_msg')
assert.equal(sent[0].body.user_id, 10001)
assert.equal(sent[1].action, '/send_group_msg')
assert.equal(sent[1].body.group_id, 20002)
assert.match(sent[0].body.message, /【任务完成】/)
assert.match(sent[0].body.message, /会话: sess-1/)
assert.match(sent[0].body.message, /状态: completed/)
assert.match(sent[0].body.message, /任务完成啦/)

// 重复 idle（无 running）：不应重复通知
statusListener({ agent: fakeAgent, status: 'idle' })
await new Promise((r) => setTimeout(r, 30))
assert.equal(received.length, before + 2, 'no duplicate notification without running transition')

// ---------- 6) OneBotService 直接 HTTP 调用 ----------
const service = new OneBotService(ctx, config)
const res = await service.sendGroupMsg('40004', '群消息', true)
assert.equal(res.retcode, 0)
assert.equal(received.at(-1).action, '/send_group_msg')
assert.equal(received.at(-1).body.group_id, 40004)
assert.equal(received.at(-1).body.auto_escape, true)

// HTTP 错误应抛出 OneBotHttpError 并重试
const badService = new OneBotService(ctx, {
  ...config,
  http: { url: 'http://127.0.0.1:1', token: '', timeoutMs: 500 },
  notify: { ...config.notify, retries: 1, retryDelayMs: 5 },
})
let threw = false
try {
  await badService.sendGroupMsg('1', 'x')
} catch (error) {
  threw = true
  assert.ok(error instanceof OneBotHttpError, `expected OneBotHttpError, got ${error.constructor.name}`)
}
assert.ok(threw, 'HTTP failure should throw OneBotHttpError')

// ---------- 7) WS server 长连接 ----------
const wsConfig = {
  ...config,
  http: { ...config.http },
  ws: { mode: 'server', host: '127.0.0.1', port: 0, path: '/ws', token: '', reconnectInterval: 500 },
}
const wsService = new OneBotService(ctx, wsConfig)
const receivedEvents = []
wsService.onEvent((event) => receivedEvents.push(event))
wsService.start()

// 等待端口就绪
let wsPort
for (let i = 0; i < 50 && wsPort === undefined; i++) {
  wsPort = wsService.wsPort
  await new Promise((r) => setTimeout(r, 10))
}
assert.ok(wsPort !== undefined, 'WS server should bind a port')

const client = new WebSocket(`ws://127.0.0.1:${wsPort}/ws`)
await new Promise((resolve, reject) => {
  client.on('open', resolve)
  client.on('error', reject)
})
await new Promise((r) => setTimeout(r, 30))
assert.equal(wsService.connected, true, 'service should report connected after client joins')

client.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat', time: 123 }))
await new Promise((r) => setTimeout(r, 30))
assert.equal(receivedEvents.length, 1)
assert.equal(receivedEvents[0].meta_event_type, 'heartbeat')

wsService.stop()
assert.equal(wsService.connected, false)
client.close()

// ---------- 8) 通知辅助函数 ----------
assert.equal(truncate('123456', 5), '1234…')
assert.equal(truncate('123', 5), '123')
assert.match(
  renderTemplate('{sessionId}|{status}|{summary}', { sessionId: 's', status: 'completed', summary: 'ok', time: 0 }),
  /^s\|completed\|ok$/,
)
assert.equal(
  extractAssistantText([
    { role: 'user', content: [{ type: 'text', text: 'u' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool-call', id: '1', name: 'x', arguments: '{}' }] },
  ]),
  'a',
)

// ---------- 清理 ----------
for (const disposer of effects) disposer()
await new Promise((resolve) => httpServer.close(resolve))

console.log('smoke ok')
