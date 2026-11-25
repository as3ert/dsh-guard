/** Map raw dsh tool calls onto canonical tool names and fields. @module */
import type { CallView, ToolCall } from './types.ts'

/** Canonical tool names a rule may name in `tool:`. */
export const CANONICAL_TOOLS = ['shell', 'edit', 'write', 'read', 'fetch', 'search'] as const

const SHELL_TOOLS = new Set(['bash', 'pwsh', 'terminal_send', 'shell'])
const EDIT_TOOLS = new Set(['edit', 'apply_patch'])
const WRITE_TOOLS = new Set(['write'])
const READ_TOOLS = new Set(['read', 'read_image'])
const FETCH_TOOLS = new Set(['web_fetch', 'fetch'])
const SEARCH_TOOLS = new Set(['web_search', 'grep', 'glob', 'search'])

/**
 * Canonical name of a raw dsh tool call.
 * @param tool - raw tool name.
 * @param input - parsed arguments; `str_replace_editor` is split by its `command`.
 * @returns the canonical name, or the raw name when the tool is unknown.
 */
export function canonicalName(tool: string, input: Readonly<Record<string, unknown>>): string {
  if (SHELL_TOOLS.has(tool)) return 'shell'
  if (EDIT_TOOLS.has(tool)) return 'edit'
  if (WRITE_TOOLS.has(tool)) return 'write'
  if (READ_TOOLS.has(tool)) return 'read'
  if (FETCH_TOOLS.has(tool)) return 'fetch'
  if (SEARCH_TOOLS.has(tool)) return 'search'
  if (tool === 'str_replace_editor') {
    switch (input.command) {
      case 'view': return 'read'
      case 'create': return 'write'
      case 'str_replace':
      case 'insert': return 'edit'
      default: return tool
    }
  }
  return tool
}

/** Render one argument value as matchable text. */
function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(item => text(item) ?? '').join('\n')
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** Forward slashes, so one path regex works on every platform. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

/** File paths named in an apply_patch body. */
function patchPaths(patch: string): string | undefined {
  const paths: string[] = []
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(match[1].trim())
  for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) paths.push(match[1].trim())
  return paths.length > 0 ? paths.map(normalizePath).join('\n') : undefined
}

/**
 * Build the matcher view of a call: every raw argument as text plus the
 * canonical aliases (`command`, `workdir`, `path`, `old`, `new`, `content`,
 * `patch`, `url`, `query`, `output`).
 * @param call - raw call.
 * @returns the normalized view.
 */
export function viewOf(call: ToolCall): CallView {
  const input = call.input ?? {}
  const canonical = canonicalName(call.tool, input)
  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    const rendered = text(value)
    if (rendered !== undefined) fields[key] = rendered
  }
  const set = (key: string, ...candidates: unknown[]): void => {
    for (const candidate of candidates) {
      const rendered = text(candidate)
      if (rendered !== undefined) {
        fields[key] = rendered
        return
      }
    }
  }
  switch (canonical) {
    case 'shell':
      set('command', input.command, input.text, input.input, input.data)
      if (fields.workdir !== undefined) fields.workdir = normalizePath(fields.workdir)
      break
    case 'edit':
      if (call.tool === 'apply_patch') {
        set('patch', input.input, input.patch)
        const paths = fields.patch === undefined ? undefined : patchPaths(fields.patch)
        if (paths !== undefined) fields.path = paths
      } else {
        set('path', input.file_path, input.path)
        set('old', input.old_string, input.old_str)
        set('new', input.new_string, input.new_str)
      }
      break
    case 'write':
      set('path', input.file_path, input.path)
      set('content', input.content, input.file_text)
      break
    case 'read':
      set('path', input.file_path, input.path)
      break
    case 'fetch':
      set('url', input.url)
      break
    case 'search':
      set('query', input.queries, input.query, input.pattern)
      break
  }
  if (fields.path !== undefined) fields.path = normalizePath(fields.path)
  if (call.output !== undefined) fields.output = call.output
  if (call.cwd !== undefined) fields.cwd = normalizePath(call.cwd)
  return {
    tool: call.tool,
    canonical,
    fields,
    input,
    ...call.output !== undefined ? { output: call.output } : {},
    ...call.cwd !== undefined ? { cwd: call.cwd } : {},
  }
}

/**
 * Short human summary of a call for logs: the primary field, single line, capped.
 * @param view - normalized call.
 * @param max - maximum characters.
 */
export function summarize(view: CallView, max = 160): string {
  const primary = view.fields.command ?? view.fields.path ?? view.fields.url ?? view.fields.query
    ?? JSON.stringify(view.input)
  const line = primary.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
