/**
 * Claude Code hook input to engine calls, and shape-preserving rewrites of
 * structured tool output. Tool names and fields map through the shared
 * table in `core/tools.ts` (`Bash` and `PowerShell` to `shell`, `Edit`,
 * `MultiEdit` and `NotebookEdit` to `edit`, `Write` to `write`, `Read` to
 * `read`, `WebFetch` to `fetch`, `WebSearch`, `Grep` and `Glob` to
 * `search`); other tools (`Agent`, `Skill`, MCP tools) keep their raw name
 * and fields.
 * @module
 */
import { redact } from '../core/engine.ts'
import type { Hit, ToolCall } from '../core/types.ts'

/** The fields of a hook input this adapter reads. */
export interface HookInput {
  readonly hook_event_name?: string
  readonly session_id?: string
  readonly transcript_path?: string
  readonly cwd?: string
  readonly permission_mode?: string
  readonly agent_id?: string
  readonly agent_type?: string
  readonly tool_name?: string
  readonly tool_input?: unknown
  readonly tool_response?: unknown
  readonly tool_use_id?: string
  readonly error?: string
  readonly prompt?: string
  readonly source?: string
  readonly mcp_server?: { readonly name?: string, readonly source?: string }
}

/** Context fields a rule can match when the tool input has no field of that name. */
function contextOf(input: HookInput): Record<string, string> {
  const context: Record<string, string> = {}
  if (typeof input.agent_type === 'string') context.agent_type = input.agent_type
  if (typeof input.permission_mode === 'string') context.permission_mode = input.permission_mode
  if (typeof input.mcp_server?.source === 'string') context.mcp_source = input.mcp_server.source
  if (typeof input.mcp_server?.name === 'string') context.mcp_server = input.mcp_server.name
  return context
}

/**
 * The engine call of a tool event.
 * @param input - hook input.
 * @param output - result text for the post_tool phase.
 */
export function callOf(input: HookInput, output?: string): ToolCall {
  const raw = input.tool_input
  const toolInput = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : { input: raw }
  const context = contextOf(input)
  return {
    tool: typeof input.tool_name === 'string' ? input.tool_name : 'unknown',
    input: toolInput,
    ...output !== undefined ? { output } : {},
    ...typeof input.cwd === 'string' ? { cwd: input.cwd } : {},
    ...Object.keys(context).length > 0 ? { context } : {},
  }
}

/** Keys of tool responses that carry bookkeeping, not output the model reads. */
const BOOKKEEPING = new Set(['persistedOutputPath', 'outputFile'])

/**
 * Model-facing text of a structured tool response: every string leaf, in
 * order, one per line (a plain string response is returned as it is).
 * @param response - `tool_response` of a PostToolUse input.
 */
export function outputText(response: unknown): string {
  const parts: string[] = []
  const walk = (value: unknown, key?: string): void => {
    if (key !== undefined && BOOKKEEPING.has(key)) return
    if (typeof value === 'string') parts.push(value)
    else if (Array.isArray(value)) for (const item of value) walk(item)
    else if (typeof value === 'object' && value !== null) for (const [name, item] of Object.entries(value)) walk(item, name)
  }
  walk(response)
  return parts.join('\n')
}

/**
 * Copy of a value with every string leaf passed through `map`; keys, types
 * and array lengths stay as they are, so the copy has the tool's output shape.
 */
export function mapStrings(value: unknown, map: (text: string, key?: string) => string, key?: string): unknown {
  if (typeof value === 'string') return map(value, key)
  if (Array.isArray(value)) return value.map(item => mapStrings(item, map))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, mapStrings(item, map, name)]))
  }
  return value
}

/**
 * Whether two values have the same shape: the same keys, the same types and
 * the same array lengths at every level; string contents may differ.
 */
export function sameShape(a: unknown, b: unknown): boolean {
  if (typeof a !== typeof b) return false
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, index) => sameShape(item, b[index]))
  if (typeof a === 'object' && a !== null) {
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return false
    const keys = Object.keys(a)
    const other = Object.keys(b)
    return keys.length === other.length && keys.every(name => name in b && sameShape((a as Record<string, unknown>)[name], (b as Record<string, unknown>)[name]))
  }
  return typeof a === 'string' || a === b
}

/**
 * Mask redact matches in every string leaf of a response.
 * @param response - `tool_response`.
 * @param hits - redact hits.
 * @returns the masked copy and the number of replacements.
 */
export function maskResponse(response: unknown, hits: readonly Hit[]): { value: unknown, count: number } {
  let count = 0
  const value = mapStrings(response, (text, key) => {
    if (key !== undefined && BOOKKEEPING.has(key)) return text
    const out = redact(text, hits)
    count += out.count
    return out.text
  })
  return { value, count }
}

/**
 * Replace every model-facing string leaf of a response by one message, for a
 * post_tool block: the model sees only the message.
 */
export function replaceResponse(response: unknown, message: string): unknown {
  if (typeof response === 'string') return message
  // Built-in tools validate the shape, so enum-like leaves (`type`, `mode`) must stay; only content leaves change.
  let content = false
  mapStrings(response, (text, key) => {
    if (key !== undefined && CONTENT_KEYS.has(key)) content = true
    return text
  })
  let first = true
  return mapStrings(response, (text, key) => {
    if (key !== undefined && BOOKKEEPING.has(key)) return text
    if (content && (key === undefined || !CONTENT_KEYS.has(key))) return text
    const out = first ? message : ''
    first = false
    return out
  })
}

/** Keys whose string values are the output the model reads, in the built-in tools' responses. */
const CONTENT_KEYS = new Set(['stdout', 'stderr', 'content', 'result', 'text', 'output'])
