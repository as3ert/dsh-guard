/** Schema validation of rule entries. @module */
import type { Action, Phase, RuleSpec } from './types.ts'

const KEYS = new Set(['id', 'doc', 'when', 'tool', 'match', 'action', 'message', 'override', 'examples', 'check', 'disabled', 'reason', 'promote_to'])
const PHASES: readonly Phase[] = ['pre_tool', 'post_tool']
const ACTIONS: readonly Action[] = ['block', 'ask', 'warn', 'redact']
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const CHECK_RE = /^.+:[A-Za-z_$][A-Za-z0-9_$]*$/

/** Actions allowed per phase. */
export const PHASE_ACTIONS: Readonly<Record<Phase, readonly Action[]>> = {
  pre_tool: ['block', 'ask', 'warn'],
  post_tool: ['block', 'warn', 'redact'],
}

/** Severity rank used by the tighten-only rule: warn < ask = redact < block. */
export const ACTION_RANK: Readonly<Record<Action, number>> = { warn: 0, ask: 1, redact: 1, block: 2 }

/** A rule entry as validated, with only the fields it states. */
export type PartialSpec = Partial<RuleSpec> & { id: string }

/** Validation result for one entry. */
export interface EntryCheck {
  readonly spec?: PartialSpec
  readonly errors: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')) return value as string[]
  return undefined
}

/**
 * Validate the shape of one YAML rule entry without applying defaults.
 * @param raw - parsed YAML value.
 * @returns the typed fields it states, or errors.
 */
export function checkEntry(raw: unknown): EntryCheck {
  const errors: string[] = []
  if (!isRecord(raw)) return { errors: ['rule entry must be a mapping'] }
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
    return { errors: ['`id` must be a string of letters, digits, ".", "_" or "-"'] }
  }
  const spec: PartialSpec = { id: raw.id }
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) errors.push(`unknown field \`${key}\``)
  if (raw.doc !== undefined) {
    if (typeof raw.doc === 'string') spec.doc = raw.doc
    else errors.push('`doc` must be a string')
  }
  if (raw.when !== undefined) {
    if (PHASES.includes(raw.when as Phase)) spec.when = raw.when as Phase
    else errors.push('`when` must be pre_tool or post_tool')
  }
  if (raw.tool !== undefined) {
    const tools = stringList(raw.tool)
    if (tools !== undefined) spec.tool = tools
    else errors.push('`tool` must be a tool name or a non-empty list of names')
  }
  if (raw.match !== undefined) {
    if (!isRecord(raw.match)) {
      errors.push('`match` must be a mapping of field name to regex or list of regexes')
    } else {
      const match: Record<string, string[]> = {}
      for (const [field, value] of Object.entries(raw.match)) {
        const bare = field.startsWith('not_') ? field.slice(4) : field
        if (!FIELD_RE.test(bare)) errors.push(`match field \`${field}\` is not a valid field name`)
        const patterns = stringList(value)
        if (patterns === undefined) errors.push(`match field \`${field}\` must be a regex or a non-empty list of regexes`)
        else match[field] = patterns
      }
      spec.match = match
    }
  }
  if (raw.action !== undefined) {
    if (ACTIONS.includes(raw.action as Action)) spec.action = raw.action as Action
    else errors.push('`action` must be block, ask, warn or redact')
  }
  if (raw.message !== undefined) {
    if (typeof raw.message === 'string' && raw.message.trim() !== '') spec.message = raw.message.trim()
    else errors.push('`message` must be a non-empty string')
  }
  if (raw.override !== undefined) {
    if (typeof raw.override === 'boolean') spec.override = raw.override
    else errors.push('`override` must be true or false')
  }
  if (raw.examples !== undefined) {
    if (!isRecord(raw.examples)) {
      errors.push('`examples` must be a mapping with `block` and/or `pass` lists')
    } else {
      for (const key of Object.keys(raw.examples)) {
        if (key !== 'block' && key !== 'pass') errors.push(`unknown examples key \`${key}\``)
      }
      const block = raw.examples.block
      const pass = raw.examples.pass
      if (block !== undefined && !Array.isArray(block)) errors.push('`examples.block` must be a list')
      if (pass !== undefined && !Array.isArray(pass)) errors.push('`examples.pass` must be a list')
      spec.examples = {
        ...Array.isArray(block) ? { block } : {},
        ...Array.isArray(pass) ? { pass } : {},
      }
    }
  }
  if (raw.check !== undefined) {
    if (typeof raw.check === 'string' && CHECK_RE.test(raw.check)) spec.check = raw.check
    else errors.push('`check` must have the form <module>:<function>')
  }
  if (raw.disabled !== undefined) {
    if (typeof raw.disabled === 'boolean') spec.disabled = raw.disabled
    else errors.push('`disabled` must be true or false')
  }
  if (raw.reason !== undefined) {
    if (typeof raw.reason === 'string' && raw.reason.trim() !== '') spec.reason = raw.reason.trim()
    else errors.push('`reason` must be a non-empty string')
  }
  if (raw.promote_to !== undefined) {
    if (raw.promote_to === 'block' || raw.promote_to === 'ask' || raw.promote_to === 'redact') spec.promote_to = raw.promote_to
    else errors.push('`promote_to` must be block, ask or redact')
  }
  return errors.length > 0 ? { errors } : { spec, errors }
}

/**
 * Apply defaults and check the cross-field constraints of a complete rule.
 * @param spec - merged fields of the first definition and its overrides.
 * @returns the complete rule spec, or errors.
 */
export function completeSpec(spec: PartialSpec): { spec?: RuleSpec, errors: string[] } {
  const errors: string[] = []
  if (spec.action === undefined) errors.push('`action` is required')
  const when = spec.when ?? 'pre_tool'
  const action = spec.action ?? 'block'
  if (spec.action !== undefined && !PHASE_ACTIONS[when].includes(action)) {
    errors.push(`action \`${action}\` is not valid for \`${when}\` (allowed: ${PHASE_ACTIONS[when].join(', ')})`)
  }
  const match = spec.match ?? {}
  if (action === 'redact' && match.output === undefined) errors.push('a redact rule needs `match.output`, the patterns to mask')
  if (when === 'pre_tool' && (match.output !== undefined || match.not_output !== undefined)) {
    errors.push('`output` can only be matched in a post_tool rule')
  }
  if (spec.disabled === true && spec.reason === undefined) errors.push('`disabled: true` needs a `reason`')
  // promote_to describes an observe-mode warn rule; it is void once the rule is promoted.
  const promoteTo = action === 'warn' ? spec.promote_to : undefined
  if (promoteTo !== undefined && !PHASE_ACTIONS[when].includes(promoteTo)) {
    errors.push(`promote_to \`${promoteTo}\` is not valid for \`${when}\` (allowed: ${PHASE_ACTIONS[when].filter(item => item !== 'warn').join(', ')})`)
  }
  if (promoteTo === 'redact' && match.output === undefined) errors.push('promote_to redact needs `match.output`, the patterns to mask')
  if (errors.length > 0) return { errors }
  return {
    spec: {
      id: spec.id,
      ...spec.doc !== undefined ? { doc: spec.doc } : {},
      when,
      tool: spec.tool ?? ['any'],
      match,
      action,
      message: spec.message ?? `matched guard rule ${spec.id}`,
      override: spec.override ?? false,
      ...spec.examples !== undefined ? { examples: spec.examples } : {},
      ...spec.check !== undefined ? { check: spec.check } : {},
      ...spec.disabled !== undefined ? { disabled: spec.disabled } : {},
      ...spec.reason !== undefined ? { reason: spec.reason } : {},
      ...promoteTo !== undefined ? { promote_to: promoteTo } : {},
    },
    errors,
  }
}
