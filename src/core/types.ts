/** Shared types of the dsh-guard rule engine. @module */

/** Pipeline phase a rule applies to. */
export type Phase = 'pre_tool' | 'post_tool'

/** What a matching rule does. */
export type Action = 'block' | 'ask' | 'warn' | 'redact'

/** Rule source layers, in load order. */
export type LayerName = 'packs' | 'user' | 'project' | 'local' | 'extra' | 'builtin'

/** One tool call as the engine sees it, independent of dsh types. */
export interface ToolCall {
  /** Raw tool name, for example `bash` or `read` (dsh), `Bash` or `Read` (Claude Code). */
  readonly tool: string
  /** Parsed tool arguments. */
  readonly input: Readonly<Record<string, unknown>>
  /** Model-facing result text, present only in the post_tool phase. */
  readonly output?: string
  /** Working directory of the calling session, when known. */
  readonly cwd?: string
  /**
   * Harness context matchable as fields when the input has no field of that
   * name, for example `agent_type`, `permission_mode` or `mcp_source`.
   */
  readonly context?: Readonly<Record<string, string>>
}

/** Signature of an optional `check: <module>:<fn>` hook. Must be synchronous. */
export type CheckFn = (call: CallView, rule: Rule) => boolean | { hit: boolean, message?: string } | undefined

/** Normalized view of a call handed to matchers and check hooks. */
export interface CallView {
  readonly tool: string
  readonly canonical: string
  /** Raw and canonical fields as strings; absent fields are missing. */
  readonly fields: Readonly<Record<string, string>>
  readonly input: Readonly<Record<string, unknown>>
  readonly output?: string
  readonly cwd?: string
}

/** Example calls embedded in a rule. */
export interface RuleExamples {
  /** Calls the rule must fire on. */
  block?: unknown[]
  /** Calls the rule must not fire on. */
  pass?: unknown[]
}

/** A rule as written in YAML, after defaults. */
export interface RuleSpec {
  id: string
  doc?: string
  when: Phase
  tool: string[]
  match: Record<string, string[]>
  action: Action
  message: string
  override: boolean
  examples?: RuleExamples
  check?: string
  disabled?: boolean
  reason?: string
  /**
   * Observe mode: the action this `warn` rule is meant to take once it is
   * promoted. Only meaningful while `action` is `warn`.
   */
  promote_to?: Action
}

/** Where a rule (or one of its overrides) came from. */
export interface RuleSource {
  readonly layer: LayerName
  readonly file: string
}

/** A compiled field matcher. */
export interface FieldMatcher {
  readonly field: string
  readonly negate: boolean
  readonly patterns: readonly RegExp[]
}

/** A loaded, compiled rule. */
export interface Rule extends RuleSpec {
  /** First definition followed by every accepted override. */
  readonly sources: readonly RuleSource[]
  readonly matchers: readonly FieldMatcher[]
  readonly checkFn?: CheckFn
}

/** Severity of a load or lint issue. */
export type IssueLevel = 'error' | 'warning' | 'notice'

/** A problem found while loading rule files. */
export interface Issue {
  readonly level: IssueLevel
  readonly file: string
  readonly id?: string
  readonly message: string
}

/** Result of loading all layers. */
export interface RuleSet {
  /** Active rules in definition order. */
  readonly rules: readonly Rule[]
  /** Every rule including disabled ones. */
  readonly all: readonly Rule[]
  readonly issues: readonly Issue[]
  /** Rule files that were read, for change detection. */
  readonly files: readonly string[]
}

/** One rule that fired on a call. */
export interface Hit {
  readonly rule: Rule
  readonly message: string
  /** Set when an override comment let the call pass this rule. */
  readonly overrideReason?: string
}

/** Outcome of evaluating one phase against a call. */
export interface Verdict {
  readonly phase: Phase
  /** Rules that fired and were not overridden. */
  readonly hits: readonly Hit[]
  /** Rules that fired but were overridden by a `# guard: allow` comment. */
  readonly overridden: readonly Hit[]
  /** Strongest non-overridden action, or undefined when nothing fired. */
  readonly action?: Action
  /** Whether the time budget ran out before all rules were evaluated. */
  readonly budgetExceeded: boolean
  /** Whether at least one field was truncated to the size cap. */
  readonly truncated: boolean
}
