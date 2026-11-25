/**
 * Past tool calls from Claude Code transcripts, for replaying a draft rule.
 * Read-only. The JSONL format is internal to Claude Code, so the reader is
 * tolerant: it takes `tool_use` blocks from `assistant` lines and
 * `tool_result` blocks from `user` lines, skips every line it cannot parse
 * or does not know, and reports what it skipped instead of failing.
 *
 * Layout observed with Claude Code 2.1.332: `<config>/projects/<key>/<session>.jsonl`,
 * where `<key>` is the session directory with every character other than a
 * letter or digit replaced by `-`, and subagent transcripts in
 * `<key>/<session>/subagents/agent-*.jsonl`.
 * @module
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { HistoricCall, HistorySource } from '../core/history.ts'

/** Options of {@link transcriptHistory}. */
export interface TranscriptOptions {
  /** `projects/` directory of the Claude Code configuration. */
  readonly projectsDir: string
  /** Only transcripts of this session directory; undefined reads every project. */
  readonly project?: string
  /** Newest session files read at most. */
  readonly maxSessions?: number
  /** Largest transcript file read, in bytes. */
  readonly maxFileBytes?: number
}

/** Project key of a session directory, as Claude Code names its folder. */
export function projectKey(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** Transcript files of one project folder with their modification times, subagent files included. */
function projectFiles(dir: string): { file: string, mtime: number }[] {
  const out: { file: string, mtime: number }[] = []
  const add = (file: string): void => {
    try {
      out.push({ file, mtime: statSync(file).mtimeMs })
    } catch {
      // vanished
    }
  }
  for (const name of listDir(dir)) {
    const path = join(dir, name)
    if (name.endsWith('.jsonl')) add(path)
    else if (isDir(join(path, 'subagents'))) {
      for (const sub of listDir(join(path, 'subagents'))) if (sub.endsWith('.jsonl')) add(join(path, 'subagents', sub))
    }
  }
  return out
}

/** Plain text of a tool_result content. */
function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts = content.map(block => (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
    ? String((block as { text?: unknown }).text ?? '')
    : '')).filter(text => text !== '')
  return parts.length > 0 ? parts.join('\n') : undefined
}

interface ParsedFile { calls: HistoricCall[], badLines: number }

/** Parse one transcript file. */
export function parseTranscript(text: string, fallbackSession: string): ParsedFile {
  const calls = new Map<string, HistoricCall>()
  const order: string[] = []
  const outputs = new Map<string, string>()
  let badLines = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      badLines += 1
      continue
    }
    if (typeof record !== 'object' || record === null) continue
    const message = record.message as { content?: unknown } | undefined
    const content = Array.isArray(message?.content) ? message.content as Record<string, unknown>[] : []
    const session = typeof record.sessionId === 'string' ? record.sessionId : fallbackSession
    const cwd = typeof record.cwd === 'string' ? record.cwd : undefined
    const parsedTime = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
    const time = Number.isFinite(parsedTime) ? parsedTime : 0
    if (record.type === 'assistant') {
      for (const block of content) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue
        const input = typeof block.input === 'object' && block.input !== null && !Array.isArray(block.input) ? block.input as Record<string, unknown> : {}
        if (!calls.has(block.id)) order.push(block.id)
        calls.set(block.id, { tool: block.name, input, ...cwd !== undefined ? { cwd } : {}, sessionId: session, callId: block.id, time })
      }
    } else if (record.type === 'user') {
      for (const block of content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        const output = resultText(block.content)
        if (output !== undefined) outputs.set(block.tool_use_id, output)
      }
    }
  }
  const out = order.map(id => {
    const call = calls.get(id) as HistoricCall
    const output = outputs.get(id)
    return output === undefined ? call : { ...call, output }
  })
  return { calls: out, badLines }
}

/**
 * A history source over Claude Code transcripts: newest sessions first, at
 * most `limit` calls, newest call first.
 */
export function transcriptHistory(options: TranscriptOptions): HistorySource {
  const maxSessions = options.maxSessions ?? 200
  const maxBytes = options.maxFileBytes ?? 50 * 1024 * 1024
  return async limit => {
    if (!isDir(options.projectsDir)) return { calls: [], sessions: 0, note: `history unavailable: ${options.projectsDir} does not exist` }
    const dirs = options.project !== undefined
      ? [join(options.projectsDir, projectKey(options.project))]
      : listDir(options.projectsDir).map(name => join(options.projectsDir, name)).filter(isDir)
    const files = dirs.flatMap(projectFiles).sort((a, b) => b.mtime - a.mtime)
    const calls: HistoricCall[] = []
    let sessions = 0
    let badLines = 0
    let skipped = 0
    for (const { file } of files.slice(0, maxSessions)) {
      if (calls.length >= limit) break
      let text: string
      try {
        if (statSync(file).size > maxBytes) {
          skipped += 1
          continue
        }
        text = readFileSync(file, 'utf8')
      } catch {
        skipped += 1
        continue
      }
      sessions += 1
      const parsed = parseTranscript(text, basename(file, '.jsonl'))
      badLines += parsed.badLines
      calls.push(...parsed.calls)
    }
    calls.sort((a, b) => b.time - a.time)
    const notes: string[] = []
    if (options.project !== undefined && files.length === 0) notes.push(`no transcripts for ${options.project}; use --all-projects to read every project`)
    if (badLines > 0) notes.push(`${badLines} transcript line(s) could not be parsed`)
    if (skipped > 0) notes.push(`${skipped} transcript file(s) skipped (unreadable or larger than ${maxBytes} bytes)`)
    if (files.length > maxSessions && calls.length < limit) notes.push(`only the newest ${maxSessions} transcript files were read`)
    return { calls: calls.slice(0, limit), sessions, ...notes.length > 0 ? { note: notes.join('; ') } : {} }
  }
}
