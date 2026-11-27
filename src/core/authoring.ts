/**
 * Conversational rule authoring: draft, test, replay and apply a rule change.
 * Every change is simulated through the real loader (layering and the
 * tighten-only rule included) before anything is written, and only
 * {@link GuardAuthoring.apply} writes, after an approval.
 * @module
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Document, isMap, isSeq, parseDocument } from 'yaml'
import type { YAMLSeq } from 'yaml'
import { RESERVED_PREFIX } from './builtin.ts'
import type { GuardCore } from './core.ts'
import { evaluate } from './engine.ts'
import { runExamples } from './examples.ts'
import type { ExampleFailure } from './examples.ts'
import type { History, HistoricCall, HistorySource } from './history.ts'
import { loadRules } from './loader.ts'
import { looksCatastrophic, tokenPrefixRemark, unboundedTokenPrefixes } from './regex.ts'
import { checkEntry } from './schema.ts'
import { CANONICAL_TOOLS, summarize, viewOf } from './tools.ts'
import type { Action, Issue, Rule, RuleSet } from './types.ts'

/** Layers the authoring tools write. */
export type AuthoringLayer = 'user' | 'project' | 'local'
/** Kind of change. */
export type Operation = 'add' | 'modify' | 'remove'
/** How a new rule is written: observe (`warn` with `promote_to`) or enforce (its own action). */
export type Mode = 'observe' | 'enforce'

/** Most past calls a replay looks at. */
export const REPLAY_LIMIT = 500
const SAMPLE_LIMIT = 20

/** A requested change. */
export interface DraftRequest {
  readonly op: Operation
  readonly layer: AuthoringLayer
  /** add: the complete rule; modify: `id` plus the fields to change. */
  readonly rule?: Record<string, unknown>
  /** remove (or modify without `rule.id`): the rule id. */
  readonly id?: string
  /** remove of a rule defined in a lower layer: why it is switched off. */
  readonly reason?: string
  /** add only; default `observe`. Redact rules are always written enforced. */
  readonly mode?: Mode
}

/** The checked change, ready to test, replay or apply. */
export interface DraftResult {
  readonly ok: boolean
  /** Reasons the change cannot be applied. */
  readonly problems: string[]
  /** Remarks that do not prevent applying. */
  readonly notes: string[]
  readonly op: Operation
  readonly layer: AuthoringLayer
  readonly id: string
  readonly mode: Mode
  /** Rule file that will be written. */
  readonly file: string
  /** Content of that file when the draft was made (undefined: file absent). */
  readonly baseText?: string
  /** Full new file content. */
  readonly fileText?: string
  /** The entry written for this id, or undefined when the entry is deleted. */
  readonly entry?: Record<string, unknown>
  /** The rule in force with this id before the change. */
  readonly previous?: Rule
  /** The rule in force after the change (undefined after a remove). */
  readonly effective?: Rule
}

/** Outcome of running a draft's examples. */
export interface TestResult {
  readonly ok: boolean
  readonly passed: number
  readonly failures: ExampleFailure[]
  readonly problems: string[]
}

/** One past call the draft affects. */
export interface ReplayHit {
  readonly time: number
  readonly sessionId: string
  readonly callId: string
  readonly tool: string
  readonly summary: string
  /** `new`: fires only after the change; `kept`: fires before and after; `gone`: fired before, not after. */
  readonly change: 'new' | 'kept' | 'gone'
}

/** Outcome of replaying a draft against past calls. */
export interface ReplayResult {
  readonly scanned: number
  readonly sessions: number
  /** Calls without a recorded result, skipped by a post_tool rule. */
  readonly skipped: number
  /** Action the rule would have taken (the `promote_to` of an observe-mode rule). */
  readonly action?: Action
  readonly firing: number
  readonly newlyFiring: number
  readonly noLongerFiring: number
  /** Newest first, at most 20. */
  readonly samples: ReplayHit[]
  readonly note?: string
}

/** Answer of the approval prompt, as dsh reports it. */
export type ApprovalAnswer = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * Answer of the approval step as far as the plugin can tell it apart: dsh's
 * outcome, with `rejected` split by the session's approval policy.
 * `rejected`: the policy is ask, so the user (or an approval answerer)
 * rejected; `policy-never`: the policy is never ask, so dsh rejected without
 * showing anything; `rejected-or-never`: rejected, the policy is unknown.
 */
export type AskAnswer = ApprovalAnswer | 'policy-never' | 'rejected-or-never'

/** Tool-result text for each failed approval answer. */
export const APPROVAL_FAILURE: Readonly<Record<Exclude<AskAnswer, 'allowed-once'>, string>> = {
  'rejected': 'Not applied: the user rejected the approval prompt. Ask the user what to change; do not call guard_apply again unchanged.',
  'policy-never': 'Not applied: the approval policy of this session is set to never ask, so dsh rejected the approval without showing it. Guard rules can only be changed with the user\'s approval: ask the user to switch the approval policy to ask for this change, then call guard_apply again.',
  'rejected-or-never': 'Not applied: the approval was rejected or not shown. If no prompt was shown, the approval policy is set to never ask: switch it to ask for this change, since guard rules can only be changed with the user\'s approval.',
  'cancelled': 'Not applied: the approval prompt was cancelled (the turn was interrupted).',
  'unavailable': 'Not applied: the approval was unavailable; no approval prompt can be shown in this composition (for example dsh headless without an answerer). Guard rules can only be changed with the user\'s approval.',
}

/** Draft, example run and replay of one proposed change. */
export interface ProposeResult {
  readonly draft: DraftResult
  readonly test?: TestResult
  readonly replay?: ReplayResult
  /** Why the replay did not run. */
  readonly replayNote?: string
}

/** Outcome of an apply attempt. */
export interface ApplyResult {
  readonly applied: boolean
  readonly outcome: 'written' | 'refused' | AskAnswer | 'failed'
  readonly message: string
  readonly draft: DraftResult
  readonly test?: TestResult
  readonly replay?: ReplayResult
  /** The full approval prompt. */
  readonly prompt?: string
}

const SCOPE_KEYS = ['when', 'tool', 'match', 'check'] as const

function issueText(issue: Issue): string {
  return `${issue.level}: ${issue.file}${issue.id !== undefined ? ` [${issue.id}]` : ''}: ${issue.message}`
}

/** The fields of a compiled rule as they would be written in YAML. */
export function specOf(rule: Rule): Record<string, unknown> {
  return {
    id: rule.id,
    ...rule.doc !== undefined ? { doc: rule.doc } : {},
    when: rule.when,
    tool: rule.tool.length === 1 ? rule.tool[0] : [...rule.tool],
    match: Object.fromEntries(Object.entries(rule.match).map(([key, patterns]) => [key, patterns.length === 1 ? patterns[0] : [...patterns]])),
    action: rule.action,
    ...rule.promote_to !== undefined ? { promote_to: rule.promote_to } : {},
    message: rule.message,
    override: rule.override,
    ...rule.examples !== undefined ? { examples: rule.examples } : {},
    ...rule.disabled === true ? { disabled: true, reason: rule.reason } : {},
  }
}

/** YAML text of one value, for prompts and tool results. */
export function yamlText(value: unknown): string {
  return new Document(value).toString({ lineWidth: 0 }).trimEnd()
}

/** Whether a rule is an observe-mode rule. */
export function isObserve(rule: Rule): boolean {
  return rule.action === 'warn' && rule.promote_to !== undefined
}

/** Whether every loaded rule is built in, that is no rule file defines any rule. */
export function onlyBuiltin(rules: readonly Rule[]): boolean {
  return rules.every(rule => rule.sources.every(source => source.layer === 'builtin'))
}

/** Rules file state: the parsed document and its rule list node. */
function openRuleFile(text: string | undefined): { doc: Document, seq: YAMLSeq } | { error: string } {
  if (text === undefined || text.trim() === '') {
    const doc = new Document({ rules: [] })
    doc.commentBefore = ' dsh-guard rules. Change them through the guard authoring path (propose, then apply with the approval of the user).'
    return { doc, seq: (doc.contents as unknown as { get(key: string, keep: true): YAMLSeq }).get('rules', true) }
  }
  const doc = parseDocument(text)
  if (doc.errors.length > 0) return { error: `the file does not parse: ${doc.errors[0].message.split('\n')[0]}` }
  if (isSeq(doc.contents)) return { doc, seq: doc.contents }
  if (isMap(doc.contents)) {
    const rules = doc.contents.get('rules', true)
    if (isSeq(rules)) return { doc, seq: rules }
  }
  return { error: 'the file is not a list of rules or a mapping with a `rules` list' }
}

/** Indexes of entries with an id in a rule list. */
function entryIndexes(seq: YAMLSeq, id: string): number[] {
  const out: number[] = []
  seq.items.forEach((item, index) => {
    if (isMap(item) && item.get('id') === id) out.push(index)
  })
  return out
}

/** Host-independent authoring over one guard core. */
export class GuardAuthoring {
  readonly core: GuardCore

  /** @param core - the guard core whose options select the layers. */
  constructor(core: GuardCore) {
    this.core = core
  }

  /** Default rule file of a layer. */
  layerFile(layer: AuthoringLayer, cwd: string): string | undefined {
    switch (layer) {
      case 'user': return this.core.options.userDir === '' ? undefined : join(this.core.options.userDir, 'rules.yaml')
      case 'project': return join(cwd, '.dsh-guard', 'rules.yaml')
      case 'local': return join(cwd, '.dsh-guard.local', 'rules.yaml')
    }
  }

  /** Load the rules of a directory, optionally with simulated file contents. */
  async load(cwd: string, virtualFiles?: Record<string, string>): Promise<RuleSet> {
    return loadRules({ ...this.core.loadOptions(cwd), ...virtualFiles !== undefined ? { virtualFiles } : {} })
  }

  /**
   * Check a change without writing anything.
   * @param request - the change.
   * @param cwd - project directory of the session.
   */
  async draft(request: DraftRequest, cwd: string): Promise<DraftResult> {
    const problems: string[] = []
    const notes: string[] = []
    const op = request.op
    const layer = request.layer
    const rawRule = request.rule
    // A redact rule in observe mode would only warn and mask nothing, so it is always written enforced.
    const redactRule = op === 'add' && (rawRule?.action === 'redact' || (rawRule?.action === 'warn' && rawRule.promote_to === 'redact'))
    const mode: Mode = op === 'add' && !redactRule ? request.mode ?? 'observe' : 'enforce'
    const id = typeof rawRule?.id === 'string' ? rawRule.id : request.id ?? ''
    const base = { op, layer, id, mode, notes, problems }
    const fail = (message: string, file = ''): DraftResult => ({ ...base, ok: false, file, problems: [...problems, message] })

    if (!['add', 'modify', 'remove'].includes(op)) return fail('`op` must be add, modify or remove')
    if (!['user', 'project', 'local'].includes(layer)) return fail('`layer` must be user, project or local')
    if (id === '') return fail('the rule needs an `id`')
    if (id.startsWith(RESERVED_PREFIX)) return fail(`ids starting with \`${RESERVED_PREFIX}\` belong to built-in rules, which cannot be changed`)
    if (request.id !== undefined && typeof rawRule?.id === 'string' && rawRule.id !== request.id) return fail('`id` and `rule.id` differ; a rule cannot be renamed, remove it and add a new one')
    if (op !== 'remove' && rawRule === undefined) return fail(`op ${op} needs a \`rule\``)
    if (rawRule !== undefined) {
      if ('check' in rawRule) return fail('guard_draft does not write `check` hooks (they run code); write them by hand in a user or local rule file')
      const { errors } = checkEntry({ ...rawRule, id })
      if (errors.length > 0) return fail(`invalid rule: ${errors.join('; ')}`)
    }

    const current = await this.load(cwd)
    const previous = current.all.find(rule => rule.id === id)
    if (previous?.sources.some(source => source.layer === 'builtin')) return fail('built-in rules cannot be changed')
    if (op === 'add' && previous !== undefined) {
      return fail(`id \`${id}\` already exists (${previous.sources.map(source => `${source.layer}: ${source.file}`).join(', ')}); use op modify, or choose a new id`)
    }
    if (op !== 'add' && previous === undefined) return fail(`no rule with id \`${id}\` is loaded`)

    const ownSources = previous?.sources.filter(source => source.layer === layer) ?? []
    const file = ownSources.length > 0 ? ownSources[ownSources.length - 1].file : this.layerFile(layer, cwd)
    if (file === undefined) return fail('the user layer is switched off (userDir is empty)')
    const baseText = existsSync(file) ? readFileSync(file, 'utf8') : undefined
    const opened = openRuleFile(baseText)
    if ('error' in opened) return fail(`${file}: ${opened.error}`, file)
    const { doc, seq } = opened
    const indexes = entryIndexes(seq, id)
    const ownsDefinition = previous !== undefined && previous.sources[0].file === file
    let entry: Record<string, unknown> | undefined

    if (op === 'add') {
      entry = { ...rawRule, id }
      if (redactRule) {
        if (entry.action === 'warn') {
          entry = Object.fromEntries(Object.entries(entry).flatMap(([key, value]) => (key === 'promote_to' ? [] : key === 'action' ? [['action', 'redact']] : [[key, value]])))
        }
        if (request.mode === 'observe' || rawRule?.action === 'warn') notes.push('redact rules are always written enforced: in observe mode a redact rule only warns and masks nothing')
      }
      const action = entry.action
      if (mode === 'observe' && action !== undefined && action !== 'warn') {
        entry = Object.fromEntries(Object.entries(entry).flatMap(([key, value]) => (key === 'action' ? [['action', 'warn'], ['promote_to', value]] : [[key, value]])))
        notes.push(`observe mode: written as action warn with promote_to ${String(action)}; promote it once replay and the log show no false positives`)
      }
      seq.add(doc.createNode(entry))
    } else if (op === 'modify') {
      const changes = { ...rawRule }
      delete changes.id
      if (Object.keys(changes).length === 0) return fail('nothing to change')
      const existing = indexes.length > 0 ? (seq.items[indexes[indexes.length - 1]] as { toJSON(): unknown }).toJSON() as Record<string, unknown> : { id }
      entry = { ...existing, ...changes }
      if (changes.action !== undefined && changes.action !== 'warn') delete entry.promote_to
      if (changes.disabled === true && typeof changes.reason !== 'string') return fail('`disabled: true` needs a `reason`')
      if (changes.disabled === false) {
        delete entry.disabled
        delete entry.reason
      }
      if (!ownsDefinition) {
        const scope = SCOPE_KEYS.filter(key => key in changes)
        if (scope.length > 0) problems.push(`${scope.join(', ')} of a rule defined in a lower layer cannot change; add a new rule with its own id instead`)
      }
      for (const index of indexes.slice(0, -1).reverse()) seq.items.splice(index, 1)
      const last = entryIndexes(seq, id)
      const onlyId = Object.keys(entry).every(key => key === 'id')
      if (onlyId) {
        if (last.length > 0) seq.items.splice(last[0], 1)
        entry = undefined
      } else if (last.length > 0) {
        seq.items[last[0]] = doc.createNode(entry) as never
      } else {
        seq.add(doc.createNode(entry))
      }
    } else {
      for (const index of [...indexes].reverse()) seq.items.splice(index, 1)
      if (!ownsDefinition) {
        if (request.reason === undefined || request.reason.trim() === '') {
          return fail(`\`${id}\` is defined in the ${previous?.sources[0].layer} layer; removing it from the ${layer} layer writes \`disabled: true\`, which needs a \`reason\``, file)
        }
        entry = { id, disabled: true, reason: request.reason.trim() }
        seq.add(doc.createNode(entry))
      }
    }
    if (problems.length > 0) return { ...base, ok: false, file, problems }

    const fileText = doc.toString({ lineWidth: 0 })
    const simulated = await this.load(cwd, { [file]: fileText })
    const known = new Set(current.issues.map(issueText))
    for (const issue of simulated.issues) {
      if (known.has(issueText(issue))) continue
      if (issue.level === 'notice') {
        if (!(op === 'remove' && /^rule disabled/.test(issue.message))) notes.push(issueText(issue))
      } else {
        problems.push(issueText(issue))
      }
    }
    const effective = simulated.all.find(rule => rule.id === id && rule.disabled !== true && !rule.sources.some(source => source.layer === 'builtin'))
    const disabling = op === 'modify' && rawRule?.disabled === true
    if (disabling) {
      const after = simulated.all.find(rule => rule.id === id)
      if (after?.disabled !== true || !after.sources.some(source => source.file === file)) problems.push(`\`${id}\` is not switched off after the change (see the issues above)`)
    } else if (op !== 'remove') {
      if (effective === undefined) problems.push('after the change no active rule has this id')
      else if (entry !== undefined && !effective.sources.some(source => source.file === file)) problems.push(`the change to ${file} is not in force after loading (see the issues above)`)
    } else if (effective !== undefined) {
      problems.push(`\`${id}\` is still active after the change (another file defines it: ${effective.sources.map(source => source.file).join(', ')})`)
    }
    if (effective !== undefined) {
      for (const [key, patterns] of Object.entries(effective.match)) {
        for (const pattern of patterns) if (looksCatastrophic(pattern)) notes.push(`match.${key}: pattern may backtrack catastrophically: ${pattern}`)
      }
      if (effective.action === 'redact' || effective.promote_to === 'redact') {
        for (const pattern of effective.match.output ?? []) {
          for (const alternative of unboundedTokenPrefixes(pattern)) notes.push(`match.output: ${tokenPrefixRemark(alternative)}`)
        }
      }
      for (const name of effective.tool) {
        if (name !== 'any' && !(CANONICAL_TOOLS as readonly string[]).includes(name)) notes.push(`tool \`${name}\` is not a canonical tool; it matches only the raw tool of that name in one harness`)
      }
    }
    return {
      ...base,
      ok: problems.length === 0,
      problems,
      file,
      fileText,
      ...baseText !== undefined ? { baseText } : {},
      ...entry !== undefined ? { entry } : {},
      ...previous !== undefined ? { previous } : {},
      ...effective !== undefined && op !== 'remove' ? { effective } : {},
    }
  }

  /**
   * Run the examples of a drafted rule: every `block` example must fire and
   * every `pass` example must not. A new rule needs at least one of each.
   * @param draft - a successful draft.
   */
  test(draft: DraftResult): TestResult {
    if (!draft.ok) return { ok: false, passed: 0, failures: [], problems: ['the draft has problems; fix them first'] }
    if (draft.op === 'remove' || draft.effective === undefined) return { ok: true, passed: 0, failures: [], problems: [] }
    const problems: string[] = []
    const examples = draft.effective.examples
    if ((examples?.block?.length ?? 0) === 0) problems.push('the rule needs at least one `examples.block` call it must fire on')
    if (draft.op === 'add' && (examples?.pass?.length ?? 0) === 0) problems.push('a new rule needs at least one `examples.pass` call it must not fire on (a boundary case)')
    const { passed, failures } = runExamples(draft.effective)
    return { ok: problems.length === 0 && failures.length === 0, passed, failures, problems }
  }

  /**
   * Run a drafted change against past calls.
   * @param draft - a successful draft.
   * @param history - past calls, newest first.
   */
  replay(draft: DraftResult, history: History): ReplayResult {
    const calls = history.calls.slice(0, REPLAY_LIMIT)
    const before = draft.previous !== undefined && draft.previous.disabled !== true ? draft.previous : undefined
    const after = draft.effective
    const phase = (after ?? before)?.when ?? 'pre_tool'
    let skipped = 0
    let firing = 0
    let newly = 0
    let gone = 0
    const samples: ReplayHit[] = []
    const fires = (rule: Rule | undefined, call: HistoricCall): boolean => rule !== undefined && evaluate([rule], call, rule.when).hits.length > 0
    for (const call of calls) {
      if (phase === 'post_tool' && call.output === undefined) {
        skipped += 1
        continue
      }
      const was = fires(before, call)
      const is = fires(after, call)
      if (!was && !is) continue
      const change: ReplayHit['change'] = is && was ? 'kept' : is ? 'new' : 'gone'
      if (is) firing += 1
      if (change === 'new') newly += 1
      if (change === 'gone') gone += 1
      if (samples.length < SAMPLE_LIMIT) {
        samples.push({ time: call.time, sessionId: call.sessionId, callId: call.callId, tool: call.tool, summary: summarize(viewOf(call), 120), change })
      }
    }
    const action = after === undefined ? undefined : after.promote_to ?? after.action
    return {
      scanned: calls.length,
      sessions: history.sessions,
      skipped,
      ...action !== undefined ? { action } : {},
      firing,
      newlyFiring: newly,
      noLongerFiring: gone,
      samples,
      ...history.note !== undefined ? { note: history.note } : {},
    }
  }

  /**
   * Draft, test and replay a change in one step; writes nothing.
   * @param request - the change.
   * @param cwd - project directory of the session.
   * @param history - source of past calls, or undefined when replay is unavailable.
   */
  async propose(request: DraftRequest, cwd: string, history: HistorySource | undefined): Promise<ProposeResult> {
    const draft = await this.draft(request, cwd)
    if (!draft.ok) return { draft }
    const test = this.test(draft)
    if (history === undefined) return { draft, test, replayNote: 'Replay unavailable: this composition has no session query service.' }
    try {
      return { draft, test, replay: this.replay(draft, await history(REPLAY_LIMIT)) }
    } catch (error) {
      return { draft, test, replayNote: `Replay unavailable: session history could not be read: ${(error as Error).message}` }
    }
  }

  /**
   * Draft, test and replay a change, ask for approval, then write it.
   * @param request - the change.
   * @param cwd - project directory of the session.
   * @param history - source of past calls.
   * @param ask - shows the prompt (full text, and the compact form for the desktop card) and returns the answer.
   * @param approvedBy - approval channel, written to the log record (for example `prompt`).
   */
  async apply(request: DraftRequest, cwd: string, history: HistorySource | undefined, ask: (prompt: string, display: string) => Promise<AskAnswer>, approvedBy?: string): Promise<ApplyResult> {
    const draft = await this.draft(request, cwd)
    if (!draft.ok) return { applied: false, outcome: 'refused', message: `Not applied: ${draft.problems.join('; ')}`, draft }
    const test = this.test(draft)
    if (!test.ok) {
      const reasons = [...test.problems, ...test.failures.map(failure => `${failure.kind} example ${JSON.stringify(failure.example)}: ${failure.problem}`)]
      return { applied: false, outcome: 'refused', message: `Not applied, the examples fail: ${reasons.join('; ')}`, draft, test }
    }
    let past: History
    try {
      past = history === undefined ? { calls: [], sessions: 0, note: 'session history is not available in this composition' } : await history(REPLAY_LIMIT)
    } catch (error) {
      past = { calls: [], sessions: 0, note: `session history could not be read: ${(error as Error).message}` }
    }
    const replay = this.replay(draft, past)
    const prompt = approvalPrompt(draft, test, replay)
    const answer = await ask(prompt, approvalDisplay(draft, test, replay))
    if (answer !== 'allowed-once') {
      return { applied: false, outcome: answer, message: APPROVAL_FAILURE[answer] ?? `Not applied: the approval was ${String(answer)}.`, draft, test, replay, prompt }
    }
    const nowText = existsSync(draft.file) ? readFileSync(draft.file, 'utf8') : undefined
    if (nowText !== draft.baseText) {
      return { applied: false, outcome: 'failed', message: `Not applied: ${draft.file} changed while the approval was open; draft again.`, draft, test, replay, prompt }
    }
    try {
      writeAtomic(draft.file, draft.fileText ?? '')
    } catch (error) {
      return { applied: false, outcome: 'failed', message: `Not applied: writing ${draft.file} failed: ${(error as Error).message}`, draft, test, replay, prompt }
    }
    this.core.invalidate()
    const after = await this.load(cwd)
    const rule = after.rules.find(item => item.id === draft.id)
    const off = draft.op === 'remove' || draft.entry?.disabled === true
    const inForce = off ? rule === undefined : rule !== undefined && rule.action === draft.effective?.action
    if (!inForce) {
      try {
        if (draft.baseText === undefined) unlinkSync(draft.file)
        else writeAtomic(draft.file, draft.baseText)
      } catch {
        // reported below
      }
      this.core.invalidate()
      return { applied: false, outcome: 'failed', message: `Not applied: after writing, ${draft.file} did not load as drafted; the previous content was restored.`, draft, test, replay, prompt }
    }
    this.core.note({ tool: 'guard_apply', input: { path: draft.file }, cwd }, draft.id, `authoring-${draft.op}`, undefined, approvedBy !== undefined ? { reason: `approved-by: ${approvedBy}` } : {})
    const state = off
      ? draft.entry === undefined ? 'removed' : 'switched off'
      : `${draft.op === 'add' ? 'added' : 'changed'}; in force as action ${rule?.action}${rule?.promote_to !== undefined ? ` (observe mode, promote_to ${rule.promote_to})` : ''}`
    return { applied: true, outcome: 'written', message: `Rule ${draft.id} ${state} in ${draft.file}.`, draft, test, replay, prompt }
  }
}

/** Write a file through a temporary sibling and a rename. */
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, file)
}

/** Human-readable replay summary. */
export function replayText(replay: ReplayResult): string {
  const lines = [`Replay over the newest ${replay.scanned} tool calls from ${replay.sessions} session(s)${replay.skipped > 0 ? ` (${replay.skipped} without a recorded result skipped)` : ''}:`]
  if (replay.note !== undefined) lines.push(`  note: ${replay.note}`)
  lines.push(`  would fire on ${replay.firing} call(s)${replay.action !== undefined ? ` as ${replay.action}` : ''}; newly firing ${replay.newlyFiring}; no longer firing ${replay.noLongerFiring}`)
  for (const sample of replay.samples) {
    lines.push(`  [${sample.change}] ${new Date(sample.time).toISOString()} ${sample.tool}: ${sample.summary}`)
  }
  if (replay.firing + replay.noLongerFiring > replay.samples.length) lines.push(`  ... ${replay.firing + replay.noLongerFiring - replay.samples.length} more`)
  return lines.join('\n')
}

/** Human-readable example results. */
export function testText(test: TestResult): string {
  const lines = [`Examples: ${test.passed} passed, ${test.failures.length} failed${test.ok ? '' : ' (NOT OK)'}`]
  for (const problem of test.problems) lines.push(`  problem: ${problem}`)
  for (const failure of test.failures) lines.push(`  FAIL ${failure.kind} ${JSON.stringify(failure.example)}: ${failure.problem}`)
  return lines.join('\n')
}

/** Where the dsh adapter points for the rule format. */
export const DSH_FORMAT_HINT = 'the rule format and a complete example are in the dsh-guard rule reference of the system prompt.'

/**
 * Human-readable draft summary.
 * @param draft - the draft.
 * @param hint - where the rule format is described, shown when the draft fails.
 */
export function draftText(draft: DraftResult, hint = DSH_FORMAT_HINT): string {
  const lines = [`Draft ${draft.op} ${draft.id} in the ${draft.layer} layer (${draft.file}): ${draft.ok ? 'OK' : 'NOT OK'}`]
  for (const problem of draft.problems) lines.push(`  problem: ${problem}`)
  for (const note of draft.notes) lines.push(`  note: ${note}`)
  if (!draft.ok && draft.op !== 'remove') lines.push(`  hint: ${hint}`)
  if (draft.entry !== undefined) lines.push('Entry written to the file:', yamlText([draft.entry]).replace(/^/gm, '  '))
  else if (draft.op === 'remove' && draft.ok) lines.push('The entry is deleted from the file.')
  if (draft.effective !== undefined) lines.push('Rule in force after the change:', yamlText([specOf(draft.effective)]).replace(/^/gm, '  '))
  return lines.join('\n')
}

/**
 * The approval prompt: the change, the file, the rule, its examples result and replay hits.
 * @param draft - successful draft.
 * @param test - its example run.
 * @param replay - its replay.
 */
export function approvalPrompt(draft: DraftResult, test: TestResult, replay: ReplayResult, product = 'dsh-guard'): string {
  const verb = draft.op === 'add' ? 'Add' : draft.op === 'modify' ? 'Change' : draft.entry === undefined ? 'Remove' : 'Disable'
  const head = `${product}: ${verb} rule ${draft.id} in the ${draft.layer} layer (${draft.file}).`
  const mode = draft.op === 'add'
    ? draft.effective !== undefined && isObserve(draft.effective)
      ? `Mode: OBSERVE. The rule only warns (action warn); it is meant to become ${draft.effective.promote_to} after review. To enforce it at once, reject and ask for mode enforce.`
      : `Mode: ENFORCE. The rule takes effect as action ${draft.effective?.action}.`
    : undefined
  return [
    head,
    ...mode !== undefined ? [mode] : [],
    ...draft.entry !== undefined ? ['Entry:', yamlText([draft.entry])] : draft.op === 'remove' ? ['The entry is deleted from the file.'] : [],
    testText(test),
    replayText(replay),
    'Approve to write the file.',
  ].join('\n')
}

/** One line, capped. */
function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Compact one-paragraph approval text for the desktop app, which shows the
 * reason as a single headline and collapses newlines: a headline with the
 * operation, rule id, layer and mode, then the rule, the example results,
 * the replay hits and the file as sections separated by ` | `.
 * @param draft - successful draft.
 * @param test - its example run.
 * @param replay - its replay.
 */
export function approvalDisplay(draft: DraftResult, test: TestResult, replay: ReplayResult, product = 'dsh-guard'): string {
  const verb = draft.op === 'add' ? 'Add' : draft.op === 'modify' ? 'Change' : draft.entry === undefined ? 'Remove' : 'Disable'
  const rule = draft.effective
  const off = draft.op === 'remove' || draft.entry?.disabled === true
  const mode = off || rule === undefined
    ? undefined
    : isObserve(rule) ? `OBSERVE (warns now, ${rule.promote_to} after review)` : `ENFORCE ${rule.action}`
  const parts = [`${product}: ${verb} rule ${draft.id} · ${draft.layer} layer${mode !== undefined ? ` · ${mode}` : ''}`]
  if (!off && rule !== undefined) {
    const match = Object.entries(rule.match).map(([field, patterns]) => `${field} ${oneLine(patterns.join(' OR '), 160)}`).join('; ')
    parts.push(`Rule: ${rule.when === 'post_tool' ? 'after ' : ''}${rule.tool.join(', ')}${match !== '' ? `; ${match}` : ''}; message "${oneLine(rule.message, 120)}"`)
    parts.push(`Examples: ${test.passed} passed, ${test.failures.length} failed`)
  } else if (draft.entry?.disabled === true) {
    parts.push(`Switched off: ${oneLine(String(draft.entry.reason ?? ''), 120)}`)
  }
  const hits = replay.samples.slice(0, 3).map(sample => `[${sample.change}] ${sample.tool}: ${oneLine(sample.summary, 60)}`)
  const more = replay.firing + replay.noLongerFiring - hits.length
  const counts = `fires on ${replay.firing}${replay.action !== undefined ? ` as ${replay.action}` : ''}, newly ${replay.newlyFiring}, no longer ${replay.noLongerFiring}`
  parts.push(`Replay of ${replay.scanned} past calls: ${counts}${hits.length > 0 ? `; ${hits.join('; ')}${more > 0 ? `; ${more} more` : ''}` : ''}`)
  parts.push(`File: ${draft.file}`)
  return parts.join(' | ')
}

/** Wording of the propose verdict line for one adapter. */
export interface ProposeWords {
  /** How to propose again, for example `call guard_propose again`. */
  readonly again: string
  /** How to apply, for example `call guard_apply with the same arguments`. */
  readonly apply: string
  /** Where the rule format is described. */
  readonly hint: string
}

const DSH_PROPOSE_WORDS: ProposeWords = { again: 'call guard_propose again', apply: 'call guard_apply with the same arguments', hint: DSH_FORMAT_HINT }

/** Human-readable result of guard_propose: one verdict line, then draft, examples and replay. */
export function proposeText(result: ProposeResult, words: ProposeWords = DSH_PROPOSE_WORDS): string {
  const { draft, test, replay, replayNote } = result
  if (!draft.ok || test === undefined) return `Proposal NOT READY: the draft has problems; fix them and ${words.again}.\n${draftText(draft, words.hint)}`
  const fires = replay === undefined ? 'replay unavailable' : `replay fires on ${replay.firing} of ${replay.scanned} past call(s), ${replay.newlyFiring} new`
  const head = test.ok
    ? `Proposal READY: draft OK, ${test.passed} example(s) pass, ${fires}. Show the user the rule and the replay hits; ${words.apply} once the user agrees.`
    : `Proposal NOT READY: the examples fail (${test.failures.length} failed${test.problems.length > 0 ? `, ${test.problems.length} problem(s)` : ''}); fix the rule or its examples and ${words.again}.`
  return [head, draftText(draft, words.hint), testText(test), replay !== undefined ? replayText(replay) : replayNote ?? ''].filter(part => part !== '').join('\n')
}

/** Draft input for promoting an observe-mode rule to its `promote_to` action. */
export function promotionRequest(rule: Rule): DraftRequest | undefined {
  if (!isObserve(rule)) return undefined
  const source = [...rule.sources].reverse().find(item => item.layer === 'user' || item.layer === 'project' || item.layer === 'local')
  if (source === undefined) return undefined
  return { op: 'modify', layer: source.layer as AuthoringLayer, rule: { id: rule.id, action: rule.promote_to } }
}
