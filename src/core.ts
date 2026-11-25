/** Host-independent guard logic used by the dsh plugin and the CLI. @module */
import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinRules, defaultDshHome } from './builtin.ts'
import type { ProtectedPaths } from './builtin.ts'
import { denialText, evaluate, redact } from './engine.ts'
import { defaultUserDir, layerFiles, loadRules } from './loader.ts'
import { DecisionLog, defaultLogPath } from './log.ts'
import { summarize, viewOf } from './tools.ts'
import type { LoadOptions } from './loader.ts'
import type { Hit, Issue, LayerName, Rule, RuleSet, ToolCall, Verdict } from './types.ts'

/** Guard configuration (mirrors the plugin Config). */
export interface GuardOptions {
  /** `open` lets a call pass on internal errors or an exhausted budget; `closed` denies it. */
  failMode: 'open' | 'closed'
  /** Per-call, per-phase evaluation budget in milliseconds. */
  timeBudgetMs: number
  /** Field size cap for matching. */
  maxFieldChars: number
  /** JSONL log path; empty disables logging. */
  logPath: string
  /** User rule directory; empty skips the user layer. */
  userDir: string
  /** Rule files or directories loaded before the user layer; none by default. */
  packs: string[]
  /** Extra rule files loaded after the local layer. */
  extraRuleFiles: string[]
  /** Fallback project directory when the session directory is unknown. */
  cwd: string
  /** Minimum interval between rule-file change checks; 0 disables hot reload. */
  reloadIntervalMs: number
  /** Layers allowed to disable earlier rules. */
  disableLayers: LayerName[]
  /** Layers allowed to name check hooks. */
  checkLayers: LayerName[]
  /** DSH home whose profile patches hold the plugin configuration (protected). */
  dshHome: string
}

/** Defaults of every option. */
export function defaultOptions(): GuardOptions {
  return {
    failMode: 'open',
    timeBudgetMs: 250,
    maxFieldChars: 100_000,
    logPath: defaultLogPath(),
    userDir: defaultUserDir(),
    packs: [],
    extraRuleFiles: [],
    cwd: process.cwd(),
    reloadIntervalMs: 2000,
    disableLayers: ['user', 'local'],
    checkLayers: ['packs', 'user', 'local', 'extra'],
    dshHome: defaultDshHome(),
  }
}

/** Directory of the running plugin code (`dist/` in dsh, `src/` in tests). */
const CODE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Locations the self-protection rule guards for a set of options.
 * @param options - guard options.
 */
export function protectedPaths(options: GuardOptions): ProtectedPaths {
  return {
    userDir: options.userDir === '' ? null : options.userDir,
    logPath: options.logPath,
    ruleFiles: [...options.extraRuleFiles],
    codeDirs: [CODE_DIR, ...options.packs.map(pack => resolve(pack))],
    dshHome: options.dshHome,
  }
}

/** Pre-execute outcome. */
export interface PreOutcome {
  readonly kind: 'allow' | 'deny' | 'ask'
  readonly reason?: string
  /** Warning texts to deliver as additional context. */
  readonly warnings: string[]
  readonly verdict?: Verdict
}

/** Post-execute outcome. */
export interface PostOutcome {
  readonly kind: 'accept' | 'block'
  readonly feedback?: string
  readonly redactHits: Hit[]
  readonly warnings: string[]
  readonly verdict?: Verdict
}

interface CacheEntry {
  set: RuleSet
  signature: string
  checkedAt: number
}

/** Rule cache, evaluation and logging for one host. */
/**
 * Notice text for a hit of a warn rule. An observe-mode rule (warn with promote_to) says that the call was allowed and what the rule would do once enforced; a plain warn keeps the rule message.
 */
function warningText(hit: { rule: { id: string, promote_to?: string }, message: string }): string {
  const promote = hit.rule.promote_to
  if (promote === undefined) return `dsh-guard warning [${hit.rule.id}]: ${hit.message}`
  const verb = promote === 'block' ? 'block it' : promote === 'ask' ? 'ask for confirmation' : promote === 'redact' ? 'redact the matching output' : promote
  return `dsh-guard observe [${hit.rule.id}]: this call was allowed; once enforced the rule would ${verb}: ${hit.message}`
}

export class GuardCore {
  readonly options: GuardOptions
  readonly log: DecisionLog
  private readonly cache = new Map<string, CacheEntry>()
  private readonly pending = new Map<string, Promise<RuleSet>>()
  private readonly reported = new Set<string>()
  /** Built-in rules, compiled once. */
  readonly builtin: readonly Rule[]
  /** Receives load issues and internal errors (for example the host logger). */
  readonly report: (level: 'warn' | 'info', message: string) => void

  /**
   * @param options - partial options merged over the defaults.
   * @param report - receives load issues and internal errors (for example the host logger).
   */
  constructor(options: Partial<GuardOptions> = {}, report: (level: 'warn' | 'info', message: string) => void = () => {}) {
    this.report = report
    this.options = { ...defaultOptions(), ...options }
    this.log = new DecisionLog(this.options.logPath)
    this.builtin = builtinRules(protectedPaths(this.options))
  }

  /**
   * Layer selection for a project directory.
   * @param cwd - project directory.
   */
  loadOptions(cwd: string): LoadOptions {
    return {
      builtin: this.builtin,
      cwd,
      packs: this.options.packs,
      userDir: this.options.userDir === '' ? null : this.options.userDir,
      extraFiles: this.options.extraRuleFiles,
      disableLayers: this.options.disableLayers,
      checkLayers: this.options.checkLayers,
    }
  }

  /** Signature of the rule files of a directory: paths and modification times. */
  private signature(cwd: string): string {
    return layerFiles(this.loadOptions(cwd)).map(({ file }) => {
      try {
        return `${file}@${statSync(file).mtimeMs}`
      } catch {
        return `${file}@missing`
      }
    }).join('|')
  }

  private reportIssues(issues: readonly Issue[]): void {
    for (const issue of issues) {
      const text = `dsh-guard: ${issue.level}: ${issue.file}${issue.id !== undefined ? ` [${issue.id}]` : ''}: ${issue.message}`
      if (this.reported.has(text)) continue
      this.reported.add(text)
      this.report(issue.level === 'notice' ? 'info' : 'warn', text)
    }
  }

  /**
   * Rules for a project directory, loaded once and reloaded when files change.
   * @param cwd - project directory.
   */
  async ruleSetFor(cwd: string): Promise<RuleSet> {
    const cached = this.cache.get(cwd)
    const now = Date.now()
    if (cached !== undefined) {
      if (this.options.reloadIntervalMs <= 0 || now - cached.checkedAt < this.options.reloadIntervalMs) return cached.set
      cached.checkedAt = now
      if (this.signature(cwd) === cached.signature) return cached.set
    }
    let pending = this.pending.get(cwd)
    if (pending === undefined) {
      pending = (async () => {
        const signature = this.signature(cwd)
        const set = await loadRules(this.loadOptions(cwd))
        this.reportIssues(set.issues)
        this.cache.set(cwd, { set, signature, checkedAt: Date.now() })
        return set
      })().finally(() => this.pending.delete(cwd))
      this.pending.set(cwd, pending)
    }
    return pending
  }

  /** Drop cached rules so the next call re-reads every file (after guard_apply writes one). */
  invalidate(): void {
    this.cache.clear()
  }

  /** Rules already loaded for a directory, or for the fallback directory. */
  cachedRuleSet(cwd: string): RuleSet | undefined {
    return this.cache.get(cwd)?.set ?? this.cache.get(this.options.cwd)?.set
  }

  private evalOptions() {
    return { timeBudgetMs: this.options.timeBudgetMs, maxFieldChars: this.options.maxFieldChars }
  }

  private logHits(call: ToolCall, verdict: Verdict, verdictName: (hit: Hit) => string, callId?: string): void {
    const view = viewOf(call)
    const base = { tool: call.tool, summary: summarize(view), cwd: call.cwd ?? this.options.cwd, ...callId !== undefined ? { callId } : {} }
    const onError = (error: unknown) => this.report('warn', `dsh-guard: log write failed: ${(error as Error).message}`)
    for (const hit of verdict.hits) this.log.write({ ...base, rule: hit.rule.id, verdict: verdictName(hit) }, onError)
    for (const hit of verdict.overridden) this.log.write({ ...base, rule: hit.rule.id, verdict: 'override', reason: hit.overrideReason ?? '' }, onError)
    if (verdict.budgetExceeded) this.log.write({ ...base, rule: '-', verdict: `budget-exceeded-${this.options.failMode}` }, onError)
  }

  /** Record one free-form decision line. */
  note(call: ToolCall, rule: string, verdict: string, callId?: string): void {
    this.log.write({
      rule, verdict, tool: call.tool, summary: summarize(viewOf(call)), cwd: call.cwd ?? this.options.cwd,
      ...callId !== undefined ? { callId } : {},
    }, error => this.report('warn', `dsh-guard: log write failed: ${(error as Error).message}`))
  }

  private budgetDenial(verdict: Verdict, checkSize = true): string | undefined {
    if (this.options.failMode !== 'closed') return undefined
    if (verdict.budgetExceeded) return 'Blocked by dsh-guard: the rule check ran out of its time budget (failMode: closed).'
    if (checkSize && verdict.truncated) return 'Blocked by dsh-guard: the input exceeds the size the rules can check (failMode: closed).'
    return undefined
  }

  /**
   * Pre-execute decision for one call. Loads rules when needed.
   * @param call - the call with its session directory.
   * @param callId - for the log.
   */
  async pre(call: ToolCall, callId?: string): Promise<PreOutcome> {
    const set = await this.ruleSetFor(call.cwd ?? this.options.cwd)
    const verdict = evaluate(set.rules, call, 'pre_tool', this.evalOptions())
    this.logHits(call, verdict, hit => hit.rule.action, callId)
    const warnings = verdict.hits.filter(hit => hit.rule.action === 'warn').map(warningText)
    const failure = this.budgetDenial(verdict)
    if (failure !== undefined) return { kind: 'deny', reason: failure, warnings, verdict }
    if (verdict.action === 'block') return { kind: 'deny', reason: denialText(verdict.hits, 'block'), warnings, verdict }
    if (verdict.action === 'ask') return { kind: 'ask', reason: denialText(verdict.hits, 'ask'), warnings, verdict }
    return { kind: 'allow', warnings, verdict }
  }

  /**
   * Synchronous block check for the monotonic guard, from cached rules only.
   * @param call - the call.
   * @returns a denial reason, or undefined.
   */
  guardSync(call: ToolCall): string | undefined {
    const set = this.cachedRuleSet(call.cwd ?? this.options.cwd)
    if (set === undefined) {
      return this.options.failMode === 'closed' ? 'Blocked by dsh-guard: rules are not loaded yet (failMode: closed).' : undefined
    }
    const verdict = evaluate(set.rules.filter(rule => rule.action === 'block'), call, 'pre_tool', this.evalOptions())
    const failure = this.budgetDenial(verdict)
    if (failure !== undefined) return failure
    return verdict.action === 'block' ? denialText(verdict.hits, 'block') : undefined
  }

  /**
   * Post-execute decision for one result.
   * @param call - the call with its `output` set to the result text.
   * @param callId - for the log.
   */
  async post(call: ToolCall, callId?: string): Promise<PostOutcome> {
    const set = await this.ruleSetFor(call.cwd ?? this.options.cwd)
    const verdict = evaluate(set.rules, call, 'post_tool', this.evalOptions())
    this.logHits(call, verdict, hit => hit.rule.action, callId)
    const warnings = verdict.hits.filter(hit => hit.rule.action === 'warn').map(warningText)
    const redactHits = verdict.hits.filter(hit => hit.rule.action === 'redact')
    const failure = this.budgetDenial(verdict, false)
    if (failure !== undefined) return { kind: 'block', feedback: failure, redactHits, warnings, verdict }
    if (verdict.action === 'block') return { kind: 'block', feedback: denialText(verdict.hits, 'block'), redactHits, warnings, verdict }
    return { kind: 'accept', redactHits, warnings, verdict }
  }

  /** Mask redact matches in a text. */
  redactText(text: string, hits: readonly Hit[]): string {
    return redact(text, hits).text
  }
}
