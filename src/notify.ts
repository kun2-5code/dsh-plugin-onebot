/**
 * 通知内容构建：从会话提取摘要、按模板渲染、按最大长度截断。
 * 公开函数只依赖最小结构化类型，避免把 dsh 内部类型打进包的公开 API。
 * @module dsh-plugin-onebot/notify
 */

/** 文本块的最小结构（dsh ContentBlock 的结构子集）。 */
interface TextBlockLike {
  type: string
  text?: string
}

/** 消息的最小结构（dsh Message 的结构子集）。 */
interface MessageLike {
  role: string
  content: readonly TextBlockLike[]
}

/** 会话的最小结构（dsh Session 的结构子集）。 */
interface SessionLike {
  deriveMessages(): readonly MessageLike[]
}

/** 回合结束原因（与 SessionEventMap 的 turn/end reason.kind 对齐）。 */
export type CompletionStatus = 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted'

/** 一次任务完成通知的渲染输入。 */
export interface CompletionInfo {
  sessionId: string
  status: CompletionStatus
  summary: string
  time: number
}

/** 提取最后一条非空 assistant 纯文本（text 块），没有则返回空串。 */
export function extractAssistantText(messages: readonly MessageLike[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    const text = message.content
      .filter((block) => block.type === 'text' && block.text !== undefined)
      .map((block) => block.text as string)
      .join('')
      .trim()
    if (text) return text
  }
  return ''
}

/** 从会话派生历史中取最后一条 assistant 摘要。 */
export function summarizeSession(session: SessionLike): string {
  return extractAssistantText(session.deriveMessages())
}

/** 按最大长度截断（保留省略号）。 */
export function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1)}…`
}

/** 渲染模板：替换 {sessionId} {summary} {status} {time} 占位符。 */
export function renderTemplate(template: string, info: CompletionInfo): string {
  return template
    .replaceAll('{sessionId}', info.sessionId)
    .replaceAll('{summary}', info.summary)
    .replaceAll('{status}', info.status)
    .replaceAll('{time}', new Date(info.time).toLocaleString('zh-CN'))
}
