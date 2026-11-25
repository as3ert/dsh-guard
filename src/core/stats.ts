/** Per-rule counts from the decision log. @module */
import { closeSync, openSync, readSync, statSync } from 'node:fs'

/** Counts and false-positive candidates of one rule. */
export interface RuleStats {
  /** Records per verdict (`block`, `warn`, `override`, `ask-allowed`, ...). */
  readonly verdicts: Record<string, number>
  /** Times the rule fired (block, ask, warn or redact). */
  hits: number
  /** Times an override comment let a call pass the rule. */
  overrides: number
  /** Last record time. */
  last?: string
  /** Recent calls that suggest a false positive: overridden calls, newest last (at most 20). */
  readonly falsePositives: { time: string, summary: string, reason: string }[]
}

const HIT_VERDICTS = new Set(['block', 'ask', 'warn', 'redact'])

/** Read the tail of a file, at most `maxBytes`, dropping a partial first line. */
function tail(path: string, maxBytes: number): string {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return ''
  }
  const start = Math.max(0, size - maxBytes)
  const buffer = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, buffer.length, start)
  } finally {
    closeSync(fd)
  }
  const text = buffer.toString('utf8')
  return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
}

/**
 * Aggregate the decision log per rule. Lines that do not parse are skipped.
 * @param path - JSONL log; a missing file gives an empty map.
 * @param maxBytes - only the newest part of a large log is read.
 */
export function readLogStats(path: string, maxBytes = 32 * 1024 * 1024): Map<string, RuleStats> {
  const stats = new Map<string, RuleStats>()
  if (path === '') return stats
  for (const line of tail(path, maxBytes).split('\n')) {
    if (line.trim() === '') continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const rule = typeof record.rule === 'string' ? record.rule : undefined
    const verdict = typeof record.verdict === 'string' ? record.verdict : undefined
    if (rule === undefined || rule === '-' || verdict === undefined) continue
    let entry = stats.get(rule)
    if (entry === undefined) {
      entry = { verdicts: {}, hits: 0, overrides: 0, falsePositives: [] }
      stats.set(rule, entry)
    }
    entry.verdicts[verdict] = (entry.verdicts[verdict] ?? 0) + 1
    if (HIT_VERDICTS.has(verdict)) entry.hits += 1
    if (typeof record.time === 'string') entry.last = record.time
    if (verdict === 'override') {
      entry.overrides += 1
      entry.falsePositives.push({ time: String(record.time ?? ''), summary: String(record.summary ?? ''), reason: String(record.reason ?? '') })
      if (entry.falsePositives.length > 20) entry.falsePositives.shift()
    }
  }
  return stats
}
