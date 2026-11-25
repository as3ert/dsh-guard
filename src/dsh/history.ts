/**
 * Past tool calls from dsh session logs, for replaying a draft rule.
 * Uses `ctx.sessionQuery`: `listSessions()` (newest first) and
 * `readSession(id)`, whose events carry the `tool/call` and `tool/result`
 * payloads. `listEvents(id)` returns records without payloads and is not
 * enough for replay.
 * @module
 */
import type { HistoricCall, HistorySource } from '../core/history.ts'

/** The subset of the session-query service used here. */
export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<{ header: { id: string, cwd?: string } }[]>
  readSession(sessionId: string): Promise<{ session: { cwd?: string }, events: { type: string, time: number, data: unknown }[] }>
}

interface CallData { callId: string, name: string, arguments: string }
interface ResultData { message?: { toolCallId?: string, content?: unknown } }

/** Plain text of a tool result message content. */
function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  return content.map(block => (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
    ? String((block as { text?: unknown }).text ?? '')
    : '')).filter(text => text !== '').join('\n')
}

/** Parse a logged arguments string into the input record. */
function parseArguments(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
    return { arguments: value }
  } catch {
    return { arguments: text }
  }
}

/**
 * Build a history source over a session-query service.
 * @param query - `ctx.sessionQuery`.
 * @param maxSessions - upper bound on sessions read per replay.
 */
export function sessionHistory(query: SessionQueryLike, maxSessions = 200): HistorySource {
  return async limit => {
    const records = await query.listSessions()
    const calls: HistoricCall[] = []
    let sessions = 0
    let failed = 0
    for (const record of records.slice(0, maxSessions)) {
      if (calls.length >= limit) break
      let log
      try {
        log = await query.readSession(record.header.id)
      } catch {
        failed += 1
        continue
      }
      sessions += 1
      const cwd = log.session.cwd ?? record.header.cwd
      const outputs = new Map<string, string>()
      for (const event of log.events) {
        if (event.type !== 'tool/result') continue
        const message = (event.data as ResultData).message
        const text = resultText(message?.content)
        if (message?.toolCallId !== undefined && text !== undefined) outputs.set(message.toolCallId, text)
      }
      const own: HistoricCall[] = []
      for (const event of log.events) {
        if (event.type !== 'tool/call') continue
        const data = event.data as CallData
        const output = outputs.get(data.callId)
        own.push({
          tool: data.name,
          input: parseArguments(data.arguments),
          ...output !== undefined ? { output } : {},
          ...cwd !== undefined ? { cwd } : {},
          sessionId: record.header.id,
          callId: data.callId,
          time: event.time,
        })
      }
      own.reverse()
      calls.push(...own.slice(0, limit - calls.length))
    }
    calls.sort((a, b) => b.time - a.time)
    const notes: string[] = []
    if (failed > 0) notes.push(`${failed} session log(s) could not be read`)
    if (records.length > maxSessions && calls.length < limit) notes.push(`only the newest ${maxSessions} sessions were read`)
    return { calls: calls.slice(0, limit), sessions, ...notes.length > 0 ? { note: notes.join('; ') } : {} }
  }
}
