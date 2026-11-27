#!/usr/bin/env node
/**
 * Claude Code hook entry: `node hook.js <event>` with the hook input on
 * stdin, one JSON object on stdout, exit code 0.
 *
 * | event | Claude Code event | does |
 * |---|---|---|
 * | `pre` | PreToolUse | block and ask hits become `deny` with the reason (ask: get the user's agreement in the chat, then repeat the shell command with `# guard: allow <reason>`); warn hits become `additionalContext`; never `allow` |
 * | `post` | PostToolUse | warn hits become `additionalContext`; redact hits mask every string leaf of `tool_response` (and the persisted file of a large output) through `updatedToolOutput`; a post_tool block replaces the output; issues the approval code of a pending rule change |
 * | `post-failure` | PostToolUseFailure | warn hits become `additionalContext`; output of failed calls cannot be rewritten, so redact hits become a notice |
 * | `prompt` | UserPromptSubmit | `guard approve <code>` writes the pending rule change |
 * | `session-start` | SessionStart | reports rule-file problems to the user and the rule count to Claude |
 *
 * An internal error never passes silently: with `failMode: open` the call
 * goes ahead with a `systemMessage` to the user and a notice to Claude; with
 * `failMode: closed` a PreToolUse call is denied.
 * @module
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { GuardCore } from '../core/core.ts'
import { redact } from '../core/engine.ts'
import { onlyBuiltin, isObserve } from '../core/authoring.ts'
import { viewOf } from '../core/tools.ts'
import { APPROVE_PROMPT, PENDING_MARKER, applyApproved, findByCode, issueCode, removePending } from './approval.ts'
import { readConfig } from './config.ts'
import type { ClaudeCodeConfig } from './config.ts'
import { callOf, maskResponse, outputText, replaceResponse, sameShape } from './mapping.ts'
import type { HookInput } from './mapping.ts'
import { claudeCodeAdapter } from './protect.ts'

/** Hook output object as Claude Code reads it. */
export type HookOutput = Record<string, unknown>

/** Events this entry handles. */
export const EVENTS = ['pre', 'post', 'post-failure', 'prompt', 'session-start'] as const
export type HookEvent = typeof EVENTS[number]

/** Largest persisted output file the post hook reads and masks. */
const MAX_PERSISTED_BYTES = 20 * 1024 * 1024

/** A guard core for one hook process. */
export function hookCore(config: ClaudeCodeConfig, issues: string[] = []): GuardCore {
  return new GuardCore(config.options, (_level, message) => issues.push(message), claudeCodeAdapter(config))
}

function context(event: string, texts: readonly string[], extra: Record<string, unknown> = {}): HookOutput | undefined {
  const additional = texts.filter(text => text !== '').join('\n')
  if (additional === '' && Object.keys(extra).length === 0) return undefined
  return { hookSpecificOutput: { hookEventName: event, ...extra, ...additional !== '' ? { additionalContext: additional } : {} } }
}

async function onPre(input: HookInput, config: ClaudeCodeConfig): Promise<HookOutput | undefined> {
  const core = hookCore(config)
  const outcome = await core.pre(callOf(input), input.tool_use_id, input.session_id)
  await core.log.flush()
  if (outcome.kind === 'deny' || outcome.kind === 'ask') {
    return context('PreToolUse', outcome.warnings, { permissionDecision: 'deny', permissionDecisionReason: outcome.reason ?? 'Blocked by cc-guard.' })
  }
  return context('PreToolUse', outcome.warnings)
}

/** The persisted file of a large output, when it lies in a Claude Code tool-results folder. */
function persistedFile(response: unknown): string | undefined {
  const path = typeof response === 'object' && response !== null ? (response as { persistedOutputPath?: unknown }).persistedOutputPath : undefined
  if (typeof path !== 'string' || !/[\\/]tool-results[\\/][^\\/]+$/.test(path)) return undefined
  try {
    return statSync(path).size <= MAX_PERSISTED_BYTES ? path : undefined
  } catch {
    return undefined
  }
}

async function onPost(input: HookInput, config: ClaudeCodeConfig): Promise<HookOutput | undefined> {
  const core = hookCore(config)
  const response = input.tool_response
  const text = outputText(response)
  const persisted = persistedFile(response)
  let fileText: string | undefined
  try {
    if (persisted !== undefined) fileText = readFileSync(persisted, 'utf8')
  } catch {
    fileText = undefined
  }
  const call = callOf(input, fileText === undefined ? text : `${text}\n${fileText}`)
  const outcome = await core.post(call, input.tool_use_id, input.session_id)
  const out: HookOutput = {}
  const extra: Record<string, unknown> = {}
  const notes = [...outcome.warnings]
  if (outcome.kind === 'block') {
    const message = outcome.feedback ?? 'Blocked by cc-guard.'
    extra.updatedToolOutput = replaceResponse(response, message)
    out.decision = 'block'
    out.reason = message
    if (persisted !== undefined && fileText !== undefined) writeFileSync(persisted, `${message}\n`, 'utf8')
  } else if (outcome.redactHits.length > 0) {
    const masked = maskResponse(response, outcome.redactHits)
    const ids = outcome.redactHits.map(hit => hit.rule.id).join(', ')
    if (masked.count > 0) {
      if (sameShape(response, masked.value)) {
        extra.updatedToolOutput = masked.value
      } else {
        out.decision = 'block'
        out.reason = `cc-guard: the output matched redact rule(s) ${ids} but could not be masked; treat the matching text as secret and do not repeat, store or use it.`
        core.note(call, ids, 'redact-failed', input.tool_use_id, input.session_id !== undefined ? { session: input.session_id } : {})
      }
    }
    if (persisted !== undefined && fileText !== undefined) {
      const file = redact(fileText, outcome.redactHits)
      if (file.count > 0) {
        writeFileSync(persisted, file.text, 'utf8')
        core.note(call, ids, 'redact-persisted', input.tool_use_id, input.session_id !== undefined ? { session: input.session_id } : {})
      }
    }
  }
  if (viewOf(call).canonical === 'shell') {
    const marker = PENDING_MARKER.exec(text)
    if (marker !== null) {
      const issued = issueCode(config.stateDir, marker[1])
      if (issued.code !== undefined && issued.entry !== undefined) {
        out.systemMessage = `cc-guard asks for approval: ${issued.entry.summary.replace(/^cc-guard: /, '')}\nTo apply this rule change, type exactly:  guard approve ${issued.code}\n(The code is valid for 30 minutes; ignore it to reject the change.)`
        notes.push('cc-guard: the approval code for this pending rule change was shown to the user, not to you. Ask the user to type the line shown below the tool call if they agree; you cannot approve it yourself.')
        core.note(call, '-', 'authoring-pending', input.tool_use_id, { ...input.session_id !== undefined ? { session: input.session_id } : {}, reason: issued.entry.summary })
      }
    }
  }
  await core.log.flush()
  const hook = context('PostToolUse', notes, extra)
  return Object.keys(out).length === 0 && hook === undefined ? undefined : { ...out, ...hook ?? {} }
}

async function onPostFailure(input: HookInput, config: ClaudeCodeConfig): Promise<HookOutput | undefined> {
  const core = hookCore(config)
  const call = callOf(input, typeof input.error === 'string' ? input.error : '')
  const outcome = await core.post(call, input.tool_use_id, input.session_id)
  const notes = [...outcome.warnings]
  const hits = [...outcome.redactHits, ...outcome.kind === 'block' ? (outcome.verdict?.hits ?? []).filter(hit => hit.rule.action === 'block') : []]
  if (hits.length > 0) {
    const ids = hits.map(hit => hit.rule.id).join(', ')
    notes.push(`cc-guard: the error output of this call matched rule(s) ${ids}, but Claude Code cannot rewrite the output of failed calls; treat the matching text as secret and do not repeat, store or use it.`)
    core.note(call, ids, 'redact-failed', input.tool_use_id, input.session_id !== undefined ? { session: input.session_id } : {})
  }
  await core.log.flush()
  return context('PostToolUseFailure', notes)
}

async function onPrompt(input: HookInput, config: ClaudeCodeConfig): Promise<HookOutput | undefined> {
  const match = APPROVE_PROMPT.exec((input.prompt ?? '').trim())
  if (match === null) return undefined
  const entry = findByCode(config.stateDir, match[1])
  if (entry === undefined) {
    return {
      systemMessage: 'cc-guard: no pending rule change has this code (mistyped, already used, or older than 30 minutes); nothing was written.',
      ...context('UserPromptSubmit', ['cc-guard: the user typed an approval code that matches no pending rule change; nothing was written.']),
    }
  }
  const core = hookCore(config)
  const result = await applyApproved(core, entry)
  removePending(config.stateDir, entry.id)
  return {
    systemMessage: `cc-guard: ${result.message}`,
    ...context('UserPromptSubmit', [`cc-guard: the user approved the pending rule change (${entry.summary}). ${result.message}`]),
  }
}

async function onSessionStart(input: HookInput, config: ClaudeCodeConfig, env: NodeJS.ProcessEnv): Promise<HookOutput | undefined> {
  const issues: string[] = []
  const core = hookCore(config, issues)
  const set = await core.ruleSetFor(input.cwd ?? config.options.cwd)
  const problems = set.issues.filter(issue => issue.level !== 'notice')
  const rules = set.rules.filter(rule => !rule.sources.some(source => source.layer === 'builtin'))
  const notes: string[] = []
  const out: HookOutput = {}
  if (problems.length > 0) {
    const lines = problems.slice(0, 5).map(issue => `${issue.level}: ${issue.file}${issue.id !== undefined ? ` [${issue.id}]` : ''}: ${issue.message}`)
    out.systemMessage = `cc-guard: ${problems.length} problem(s) in the rule files; the affected rules are NOT in force:\n${lines.join('\n')}${problems.length > 5 ? `\n... ${problems.length - 5} more (run cc-guard lint)` : ''}`
    notes.push(`cc-guard: ${problems.length} rule file problem(s); affected rules are not in force. \`cc-guard lint\` lists them.`)
  }
  if (!onlyBuiltin(set.rules)) {
    const observe = rules.filter(isObserve).length
    notes.push(`cc-guard is active: ${rules.length} rule(s)${observe > 0 ? `, ${observe} in observe mode` : ''}. Rule changes go through the cc-guard:guard-authoring skill.`)
    if (rules.some(rule => rule.action === 'redact') && env.CLAUDE_CODE_DISABLE_FILE_MENTIONS !== '1') {
      notes.push('cc-guard: redact rules do not see files inserted with @ mentions (CLAUDE_CODE_DISABLE_FILE_MENTIONS is not set).')
    }
  }
  return { ...out, ...context('SessionStart', notes) ?? {} }
}

/**
 * Handle one hook event.
 * @param event - the event argument.
 * @param input - parsed hook input.
 * @param env - environment for the configuration.
 */
export async function handle(event: HookEvent, input: HookInput, env: NodeJS.ProcessEnv = process.env): Promise<HookOutput | undefined> {
  const config = readConfig(env, typeof input.cwd === 'string' ? input.cwd : process.cwd())
  switch (event) {
    case 'pre': return onPre(input, config)
    case 'post': return onPost(input, config)
    case 'post-failure': return onPostFailure(input, config)
    case 'prompt': return onPrompt(input, config)
    case 'session-start': return onSessionStart(input, config, env)
  }
}

const HOOK_NAMES: Record<HookEvent, string> = {
  'pre': 'PreToolUse', 'post': 'PostToolUse', 'post-failure': 'PostToolUseFailure', 'prompt': 'UserPromptSubmit', 'session-start': 'SessionStart',
}

/**
 * The answer to an internal error: never silent. `failMode: closed` denies a
 * PreToolUse call; otherwise the user gets a `systemMessage` and Claude a notice.
 */
export function failureOutput(event: string, error: unknown, failMode: 'open' | 'closed'): HookOutput {
  const message = (error as Error)?.message ?? String(error)
  const name = HOOK_NAMES[event as HookEvent] ?? event
  if (event === 'pre' && failMode === 'closed') {
    return { hookSpecificOutput: { hookEventName: name, permissionDecision: 'deny', permissionDecisionReason: `Blocked by cc-guard: internal error (failMode: closed): ${message}` } }
  }
  const unchecked = event === 'pre' || event === 'post' || event === 'post-failure'
  return {
    systemMessage: `cc-guard: internal error in the ${name} hook${unchecked ? '; this call was NOT checked' : ''}: ${message}`,
    ...event !== 'session-start' && event !== 'prompt' && HOOK_NAMES[event as HookEvent] !== undefined
      ? { hookSpecificOutput: { hookEventName: name, additionalContext: `cc-guard: internal error; this call was not checked by the guard (${message}).` } }
      : {},
  }
}

/** Record an internal error in the decision log, best effort. */
function logFailure(config: ClaudeCodeConfig | undefined, event: string, error: unknown): void {
  if (config === undefined || config.options.logPath === '') return
  try {
    mkdirSync(dirname(config.options.logPath), { recursive: true })
    appendFileSync(config.options.logPath, `${JSON.stringify({ time: new Date().toISOString(), harness: 'claude-code', rule: '-', verdict: `internal-error-${config.options.failMode}`, tool: event, summary: String((error as Error)?.message ?? error).slice(0, 160), cwd: process.cwd() })}\n`, 'utf8')
  } catch {
    // nothing else to do
  }
}

/** Run as the hook process. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const event = argv[0] as HookEvent
  let config: ClaudeCodeConfig | undefined
  let out: HookOutput | undefined
  try {
    config = readConfig()
    if (!(EVENTS as readonly string[]).includes(event)) throw new Error(`unknown hook event: ${String(event)}`)
    const text = readFileSync(0, 'utf8')
    const input = (text.trim() === '' ? {} : JSON.parse(text)) as HookInput
    out = await handle(event, input)
  } catch (error) {
    logFailure(config, event, error)
    out = failureOutput(event, error, config?.options.failMode ?? 'open')
  }
  process.stdout.write(JSON.stringify(out ?? {}))
}

if (import.meta.main) await main()
