/** Evaluate rules against a call. @module */
import { compilePattern } from './regex.ts'
import { ACTION_RANK } from './schema.ts'
import { viewOf } from './tools.ts'
import type { Action, CallView, Hit, Phase, Rule, ToolCall, Verdict } from './types.ts'

/** Evaluation limits. */
export interface EvalOptions {
  /** Wall-clock budget for one phase of one call, in milliseconds. */
  timeBudgetMs?: number
  /** Fields longer than this are matched on their head and tail only. */
  maxFieldChars?: number
  /** Clock, replaceable in tests. */
  now?: () => number
  /** Let the override comment pass `ask` rules as well, as if they set `override: true`. */
  askOverridable?: boolean
}

const OVERRIDE_RE = /#\s*guard:\s*allow\b[ \t]*([^\r\n]*)/i

/**
 * Read a `# guard: allow <reason>` comment from a shell command.
 * @param command - shell command text.
 * @returns the stated reason, or undefined when there is no comment or no reason.
 */
export function overrideReason(command: string | undefined): string | undefined {
  if (command === undefined) return undefined
  const match = OVERRIDE_RE.exec(command)
  const reason = match?.[1].trim()
  return reason !== undefined && reason !== '' ? reason : undefined
}

/** Whether a rule's `tool:` list covers the call. */
export function toolMatches(rule: Rule, view: CallView): boolean {
  return rule.tool.some(name => name === 'any' || name === view.canonical || name === view.tool)
}

function capped(value: string, max: number): { text: string, truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false }
  const half = Math.floor(max / 2)
  return { text: `${value.slice(0, half)}\n${value.slice(value.length - half)}`, truncated: true }
}

/**
 * Whether one rule fires on a call, ignoring override comments.
 * @param rule - compiled rule.
 * @param view - normalized call.
 * @param maxFieldChars - field size cap.
 * @returns the hit message when it fires, undefined otherwise, and whether a field was truncated.
 */
export function ruleFires(rule: Rule, view: CallView, maxFieldChars = 100_000): { message?: string, truncated: boolean } {
  let truncated = false
  if (!toolMatches(rule, view)) return { truncated }
  for (const matcher of rule.matchers) {
    const raw = view.fields[matcher.field]
    if (raw === undefined) {
      if (matcher.negate) continue
      return { truncated }
    }
    const { text, truncated: cut } = capped(raw, maxFieldChars)
    truncated ||= cut
    const any = matcher.patterns.some(pattern => {
      pattern.lastIndex = 0
      return pattern.test(text)
    })
    if (any === matcher.negate) return { truncated }
  }
  let message = rule.message
  if (rule.checkFn !== undefined) {
    const outcome = rule.checkFn(view, rule)
    if (outcome === true) {
      // fires with the rule message
    } else if (typeof outcome === 'object' && outcome !== null && outcome.hit) {
      if (outcome.message !== undefined) message = outcome.message
    } else {
      return { truncated }
    }
  }
  return { message, truncated }
}

/** Strongest of two actions by the tighten-only order. */
function stronger(a: Action | undefined, b: Action): Action {
  if (a === undefined) return b
  if (ACTION_RANK[b] > ACTION_RANK[a]) return b
  return a
}

/**
 * Evaluate every rule of one phase against a call.
 * @param rules - active rules.
 * @param call - raw call, or an already normalized view.
 * @param phase - pipeline phase.
 * @param options - limits.
 * @returns the verdict; rules after an exhausted budget are not evaluated.
 */
export function evaluate(rules: readonly Rule[], call: ToolCall | CallView, phase: Phase, options: EvalOptions = {}): Verdict {
  const view = 'fields' in call ? call : viewOf(call)
  const now = options.now ?? (() => performance.now())
  const budget = options.timeBudgetMs ?? Number.POSITIVE_INFINITY
  const start = now()
  const hits: Hit[] = []
  const overridden: Hit[] = []
  let action: Action | undefined
  let truncated = false
  let budgetExceeded = false
  const reason = view.canonical === 'shell' ? overrideReason(view.fields.command) : undefined
  for (const rule of rules) {
    if (rule.when !== phase) continue
    if (now() - start > budget) {
      budgetExceeded = true
      break
    }
    const fired = ruleFires(rule, view, options.maxFieldChars)
    truncated ||= fired.truncated
    if (fired.message === undefined) continue
    const overridable = rule.override || (options.askOverridable === true && rule.action === 'ask')
    if (overridable && reason !== undefined && rule.action !== 'redact') {
      overridden.push({ rule, message: fired.message, overrideReason: reason })
      continue
    }
    hits.push({ rule, message: fired.message })
    action = stronger(action, rule.action)
  }
  return { phase, hits, overridden, ...action !== undefined ? { action } : {}, budgetExceeded, truncated }
}

/**
 * Mask every match of the hits' redact patterns in a text.
 * @param text - tool output.
 * @param hits - redact hits of the post_tool verdict.
 * @returns the masked text and the number of replacements.
 */
export function redact(text: string, hits: readonly Hit[]): { text: string, count: number } {
  let count = 0
  let out = text
  for (const hit of hits) {
    if (hit.rule.action !== 'redact') continue
    for (const pattern of hit.rule.match.output ?? []) {
      const re = compilePattern(pattern, 'g')
      out = out.replace(re, match => {
        if (match === '') return match
        count += 1
        return `[REDACTED:${hit.rule.id}]`
      })
    }
  }
  return { text: out, count }
}

/** Model-facing text for a block or ask hit. */
export function denialText(hits: readonly Hit[], action: Action, product = 'dsh-guard'): string {
  const lines = hits.filter(hit => hit.rule.action === action).map(hit => `[${hit.rule.id}] ${hit.message}`)
  const head = action === 'block' ? `Blocked by ${product}` : action === 'ask' ? `${product} asks for confirmation` : product
  const overridable = hits.some(hit => hit.rule.action === action && hit.rule.override)
  const tail = action === 'block' && overridable
    ? '\nOnly if the user explicitly asked for this exception, append `# guard: allow <reason>` to the shell command.'
    : ''
  return `${head}: ${lines.join('; ')}${tail}`
}

/**
 * Model-facing text for ask hits in a harness whose own approval prompt is not
 * used: the call is refused, and the agent is told to get the user's agreement
 * in the chat and then repeat a shell command with the override comment.
 * @param hits - hits of the verdict.
 * @param shell - whether the call is a shell command (only those take the comment).
 */
export function askBlockText(hits: readonly Hit[], shell: boolean, product = 'dsh-guard'): string {
  const lines = hits.filter(hit => hit.rule.action === 'ask').map(hit => `[${hit.rule.id}] ${hit.message}`)
  const tail = shell
    ? 'Ask the user in the chat whether to run this command. Only after the user agrees, run the same command again with `# guard: allow <the user\'s reason>` appended.'
    : 'This is not a shell command, so it cannot be repeated with an override comment; ask the user in the chat how to proceed.'
  return `${product} needs the user's agreement: ${lines.join('; ')}\n${tail}`
}
