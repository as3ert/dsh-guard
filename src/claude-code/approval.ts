/**
 * Rule-change approval by a code the user types, without a popup.
 *
 * 1. `cc-guard apply` (run by Claude through Bash) drafts, tests and replays
 *    the change and stores it as a pending entry in the state directory; it
 *    prints the entry id, never a code.
 * 2. The PostToolUse hook of that Bash call creates a random code, keeps only
 *    a salted SHA-256 of it in the entry and shows the code to the user as
 *    `systemMessage`, which Claude does not receive.
 * 3. The UserPromptSubmit hook accepts a prompt that is exactly
 *    `guard approve <code>`, finds the entry by the hash, re-drafts the change,
 *    checks that the target file is unchanged and writes it.
 *
 * Claude cannot type a prompt, and the self-protection rule blocks any tool
 * call that carries the phrase (scheduled tasks, messages to other sessions,
 * subagent prompts, scripts). Entries expire after 30 minutes.
 * @module
 */
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { GuardAuthoring } from '../core/authoring.ts'
import type { DraftRequest, DraftResult } from '../core/authoring.ts'
import type { GuardCore } from '../core/core.ts'

/** Lifetime of a pending entry. */
export const PENDING_TTL_MS = 30 * 60 * 1000
/** A code is only issued for an entry this fresh (the hook runs right after `apply`). */
export const ISSUE_WINDOW_MS = 5 * 60 * 1000
/** A prompt that approves: the whole trimmed prompt. */
export const APPROVE_PROMPT = /^guard\s+approve\s+([a-z0-9]{6})$/i
/** The line `cc-guard apply` prints for a stored entry. */
export const PENDING_MARKER = /\bcc-guard pending change ([0-9a-f]{12})\b/

/** One stored change awaiting approval. */
export interface PendingEntry {
  readonly id: string
  readonly created: number
  readonly request: DraftRequest
  readonly cwd: string
  readonly file: string
  /** SHA-256 of the drafted file content. */
  readonly fileTextHash: string
  /** One-line description for the user. */
  readonly summary: string
  readonly salt?: string
  readonly codeHash?: string
  readonly issued?: number
}

/** SHA-256 hex of a text. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function pendingDir(stateDir: string): string {
  return join(stateDir, 'pending')
}

function entryFile(stateDir: string, id: string): string {
  return join(pendingDir(stateDir), `${id}.json`)
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

function readEntry(file: string): PendingEntry | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as PendingEntry
    return typeof value.id === 'string' && typeof value.created === 'number' ? value : undefined
  } catch {
    return undefined
  }
}

/** Every live entry; expired and unreadable ones are deleted. */
export function listPending(stateDir: string, now = Date.now()): PendingEntry[] {
  let names: string[]
  try {
    names = readdirSync(pendingDir(stateDir)).filter(name => /^[0-9a-f]{12}\.json$/.test(name))
  } catch {
    return []
  }
  const live: PendingEntry[] = []
  for (const name of names) {
    const file = join(pendingDir(stateDir), name)
    const entry = readEntry(file)
    if (entry === undefined || now - entry.created > PENDING_TTL_MS) {
      try {
        unlinkSync(file)
      } catch {
        // already gone
      }
      continue
    }
    live.push(entry)
  }
  return live
}

/**
 * Store a drafted change as pending.
 * @returns the entry id.
 */
export function createPending(stateDir: string, request: DraftRequest, cwd: string, draft: DraftResult, summary: string, now = Date.now()): string {
  const id = randomBytes(6).toString('hex')
  const entry: PendingEntry = { id, created: now, request, cwd, file: draft.file, fileTextHash: sha256(draft.fileText ?? ''), summary }
  writeJson(entryFile(stateDir, id), entry)
  return id
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

/** A random six-character code. */
export function newCode(): string {
  let code = ''
  for (let i = 0; i < 6; i++) code += ALPHABET[randomInt(ALPHABET.length)]
  return code
}

function codeHash(salt: string, code: string): string {
  return sha256(`${salt}:${code.toLowerCase()}`)
}

/**
 * Issue the code of a fresh entry that has none yet.
 * @returns the code, or the reason why none was issued.
 */
export function issueCode(stateDir: string, id: string, now = Date.now()): { code?: string, entry?: PendingEntry, reason?: string } {
  const file = entryFile(stateDir, id)
  const entry = readEntry(file)
  if (entry === undefined) return { reason: 'no such pending change' }
  if (entry.codeHash !== undefined) return { reason: 'a code was already issued for this change' }
  if (now - entry.created > ISSUE_WINDOW_MS) return { reason: 'the pending change is too old; run cc-guard apply again' }
  const code = newCode()
  const salt = randomBytes(8).toString('hex')
  const updated: PendingEntry = { ...entry, salt, codeHash: codeHash(salt, code), issued: now }
  writeJson(file, updated)
  return { code, entry: updated }
}

/** The live entry a typed code belongs to. */
export function findByCode(stateDir: string, code: string, now = Date.now()): PendingEntry | undefined {
  return listPending(stateDir, now).find(entry => entry.salt !== undefined && entry.codeHash === codeHash(entry.salt, code))
}

/** Delete an entry. */
export function removePending(stateDir: string, id: string): void {
  try {
    unlinkSync(entryFile(stateDir, id))
  } catch {
    // already gone
  }
}

/**
 * Write an approved change: re-draft it, require the same file content as at
 * `apply` time, then write through {@link GuardAuthoring.apply}.
 * @returns whether it was written, and the message for the user and Claude.
 */
export async function applyApproved(core: GuardCore, entry: PendingEntry): Promise<{ applied: boolean, message: string }> {
  const authoring = new GuardAuthoring(core)
  const draft = await authoring.draft(entry.request, entry.cwd)
  if (!draft.ok) return { applied: false, message: `Not applied: the change no longer drafts cleanly: ${draft.problems.join('; ')}` }
  if (sha256(draft.fileText ?? '') !== entry.fileTextHash || draft.file !== entry.file) {
    return { applied: false, message: `Not applied: ${draft.file} changed since cc-guard apply; run cc-guard propose and cc-guard apply again.` }
  }
  const result = await authoring.apply(entry.request, entry.cwd, async () => ({ calls: [], sessions: 0 }), async () => 'allowed-once', 'prompt')
  await core.log.flush()
  return { applied: result.applied, message: result.message }
}
