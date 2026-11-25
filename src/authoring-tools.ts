/**
 * Model-facing authoring tools: guard_list, guard_propose (draft, test and
 * replay in one call), guard_draft, guard_test, guard_replay and guard_apply. Each tool takes the same change request and
 * re-checks it from scratch, so no draft state lives between calls.
 * @module
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { GuardAuthoring, REPLAY_LIMIT, draftText, isObserve, onlyBuiltin, proposeText, replayText, testText } from './authoring.ts'
import type { ApprovalAnswer, AskAnswer, AuthoringLayer, DraftRequest, Mode, Operation } from './authoring.ts'
import type { GuardCore } from './core.ts'
import { sessionHistory } from './history.ts'
import type { HistorySource, SessionQueryLike } from './history.ts'
import { readLogStats } from './stats.ts'
import type { Rule } from './types.ts'

/** Shipped guidance for the agent, also registered as a system-prompt section. */
export const GUIDANCE_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'guidance', 'authoring.md')

/** Read the shipped guidance text. */
export function guidanceText(): string {
  try {
    return readFileSync(GUIDANCE_FILE, 'utf8').trim()
  } catch {
    return 'Guard rules are changed only through guard_propose and guard_apply; ask the user about the boundary first and never apply without the approval prompt.'
  }
}

interface ApprovalLike {
  request(req: { agent: unknown, toolName: string, callId?: unknown, reason?: string, displayReason?: { en: string }, signal?: AbortSignal }): Promise<ApprovalAnswer>
  /** dsh-user-approval: the session's logged policy override, if any. */
  overrideOf?(session: unknown): 'ask' | 'never' | undefined
  /** dsh-user-approval: the configured default policy. */
  config?: { policy?: 'ask' | 'never' }
}

/** The session's approval policy, when the approval service exposes it. */
export function approvalPolicy(approval: ApprovalLike, session: unknown): 'ask' | 'never' | undefined {
  try {
    const override = typeof approval.overrideOf === 'function' && session !== undefined ? approval.overrideOf(session) : undefined
    const policy = override ?? (typeof approval.overrideOf === 'function' ? approval.config?.policy ?? 'ask' : approval.config?.policy)
    return policy === 'ask' || policy === 'never' ? policy : undefined
  } catch {
    return undefined
  }
}

/** Split dsh's `rejected` by the policy it was decided under. */
export function askAnswer(outcome: ApprovalAnswer, policy: 'ask' | 'never' | undefined): AskAnswer {
  if (outcome !== 'rejected') return outcome
  return policy === 'never' ? 'policy-never' : policy === 'ask' ? 'rejected' : 'rejected-or-never'
}

const CHANGE_PARAMETERS = {
  op: { type: 'string', required: true, enum: ['add', 'modify', 'remove'], description: 'add a new rule, modify an existing one (id plus the fields to change), or remove one.' },
  layer: { type: 'string', required: true, enum: ['user', 'project', 'local'], description: 'user: all projects (~/.dsh-guard); project: this repository (.dsh-guard/, shared with collaborators); local: this checkout only (.dsh-guard.local/).' },
  rule: { type: 'json', description: 'add: the complete rule object (id, tool, match, action, message, examples.block, examples.pass, optional doc, when, override). modify: id plus the fields to change. Same fields as the YAML rule files.' },
  id: { type: 'string', description: 'Rule id for remove.' },
  reason: { type: 'string', description: 'remove of a rule defined in a lower layer: why it is switched off (written as disabled: true).' },
  mode: { type: 'string', enum: ['observe', 'enforce'], description: 'add only. observe (default): the rule is written as action warn with promote_to set to the drafted action. enforce: the rule takes effect at once. Recommend observe for a new rule (a fresh regex can be too wide or too narrow), except for rules that prevent a leak or an irreversible loss on the first hit, such as reading credential or secret files: recommend enforce for those, since observe would let the first hit through. Use enforce when the user agreed to it or asked for it. Redact rules are always written enforced (observe would mask nothing), whatever this field says.' },
} as const

/** Turn validated tool arguments into a draft request. */
function requestOf(args: { op: string, layer: string, rule?: unknown, id?: string, reason?: string, mode?: string }): DraftRequest {
  let rule = args.rule
  if (typeof rule === 'string') {
    try {
      rule = JSON.parse(rule) as unknown
    } catch {
      throw new Error('`rule` must be a JSON object')
    }
  }
  if (rule !== undefined && rule !== null && (typeof rule !== 'object' || Array.isArray(rule))) throw new Error('`rule` must be an object')
  return {
    op: args.op as Operation,
    layer: args.layer as AuthoringLayer,
    ...rule !== undefined && rule !== null ? { rule: rule as Record<string, unknown> } : {},
    ...args.id !== undefined ? { id: args.id } : {},
    ...args.reason !== undefined ? { reason: args.reason } : {},
    ...args.mode !== undefined ? { mode: args.mode as Mode } : {},
  }
}

/** Shown by guard_list while no rule file defines any rule. */
export const NO_RULES_TEXT = 'No guard rules exist yet: dsh-guard ships no rules, so every tool call passes except those the built-in self-protection rule stops. '
  + 'The user can describe in this conversation what should be guarded (which calls to block, ask about or warn on, and which similar calls must keep working); '
  + 'turn that into a first rule with guard_propose and guard_apply. The rule object format and a complete example are in the dsh-guard section of the system prompt; do not search the filesystem for a schema.'

/** One line per rule for guard_list. */
export function listText(rules: readonly Rule[], logPath: string, filter: { layer?: string, observeOnly?: boolean } = {}): string {
  const table = rulesTable(rules, logPath, filter)
  return onlyBuiltin(rules) && filter.layer !== 'builtin' ? `${NO_RULES_TEXT}
${table}` : table
}

function rulesTable(rules: readonly Rule[], logPath: string, filter: { layer?: string, observeOnly?: boolean }): string {
  const stats = readLogStats(logPath)
  const lines: string[] = []
  for (const rule of rules) {
    const layers = rule.sources.map(source => source.layer)
    if (filter.layer !== undefined && !layers.includes(filter.layer as never)) continue
    if (filter.observeOnly === true && !isObserve(rule)) continue
    const stat = stats.get(rule.id)
    const action = rule.disabled === true ? `disabled (${rule.reason})` : isObserve(rule) ? `warn [observe, promote_to ${rule.promote_to}]` : rule.action
    const counts = stat === undefined ? 'hits 0' : `hits ${stat.hits}, overrides ${stat.overrides}`
    const file = rule.sources[rule.sources.length - 1].file
    lines.push(`${rule.id} | ${layers.join('>')} | ${rule.when} ${rule.tool.join(',')} | ${action} | ${counts} | ${file}`)
  }
  return lines.length === 0 ? 'No rules match.' : ['id | layers (definition>overrides) | phase tools | action | log counts | file', ...lines].join('\n')
}

/**
 * Register the authoring tools.
 * @param ctx - plugin context with the tools service.
 * @param core - the running guard core.
 * @param cwdOf - session directory of a call.
 */
export function registerAuthoringTools(ctx: Context, core: GuardCore, cwdOf: (exec: Readonly<ToolExecution>) => string): GuardAuthoring {
  const authoring = new GuardAuthoring(core)
  const service = <T>(name: string): T | undefined => {
    try {
      return (ctx as unknown as { get(name: string): unknown }).get(name) as T | undefined
    } catch {
      return undefined
    }
  }
  const history = (): HistorySource | undefined => {
    const query = service<SessionQueryLike>('sessionQuery')
    return query === undefined ? undefined : sessionHistory(query)
  }
  const text = { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] } as const

  ctx.tools.register(defineTool({
    name: 'guard_list',
    description: 'List dsh-guard rules in force for this session: id, layers, phase and tools, action (observe-mode rules show promote_to), hit and override counts from the decision log, and the file. Read-only.',
    parameters: {
      layer: { type: 'string', enum: ['packs', 'user', 'project', 'local', 'extra', 'builtin'], description: 'Only rules defined or overridden in this layer.' },
      observe_only: { type: 'boolean', description: 'Only observe-mode rules (warn with promote_to).' },
    },
    output: text,
    async execute(args, exec) {
      const set = await authoring.load(cwdOf(exec))
      return listText(set.all, core.options.logPath, { ...args.layer !== undefined ? { layer: args.layer } : {}, ...args.observe_only !== undefined ? { observeOnly: args.observe_only } : {} })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'guard_propose',
    description: `Check a dsh-guard rule change in one call, writing nothing: draft (schema, regexes, layering, tighten-only rule), run its examples (every examples.block call must fire, every examples.pass call must not) and replay it against the newest ${REPLAY_LIMIT} past tool calls. Returns a READY or NOT READY line, the problems, the example results and the replay hits. Use this instead of guard_draft, guard_test and guard_replay; repeat until READY, then show the user the rule and the hits.`,
    parameters: CHANGE_PARAMETERS,
    output: text,
    async execute(args, exec) {
      return proposeText(await authoring.propose(requestOf(args), cwdOf(exec), history()))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'guard_draft',
    description: 'Check a dsh-guard rule change without writing anything: schema, regexes, layering and the tighten-only rule for overrides (an override may not change when, tool, match or check, nor loosen action or override; the project layer cannot disable rules). Returns problems, or the entry that would be written and the rule in force afterwards. Ask the user about the boundary before drafting.',
    parameters: CHANGE_PARAMETERS,
    output: text,
    async execute(args, exec) {
      return draftText(await authoring.draft(requestOf(args), cwdOf(exec)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'guard_test',
    description: 'Draft a dsh-guard rule change and run its examples: every examples.block call must fire, every examples.pass call must not. A new rule needs at least one of each. Writes nothing.',
    parameters: CHANGE_PARAMETERS,
    output: text,
    async execute(args, exec) {
      const draft = await authoring.draft(requestOf(args), cwdOf(exec))
      if (!draft.ok) return draftText(draft)
      return `${draftText(draft)}\n${testText(authoring.test(draft))}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'guard_replay',
    description: `Draft a dsh-guard rule change and run it against the newest ${REPLAY_LIMIT} past tool calls from the session history. Shows which past calls it would have hit (new), still hits (kept) or no longer hits (gone). Writes nothing.`,
    parameters: CHANGE_PARAMETERS,
    output: text,
    async execute(args, exec) {
      const draft = await authoring.draft(requestOf(args), cwdOf(exec))
      if (!draft.ok) return draftText(draft)
      const source = history()
      if (source === undefined) return `${draftText(draft)}\nReplay unavailable: this composition has no session query service.`
      return `${draftText(draft)}\n${replayText(authoring.replay(draft, await source(REPLAY_LIMIT)))}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'guard_apply',
    description: 'Write a dsh-guard rule change (add, modify or remove) to the chosen layer file. It drafts, tests and replays the change again, then asks the user through an approval prompt that shows the rule, the example results and the replay hits; nothing is written without that approval. New rules are written in observe mode (warn) unless mode is enforce; redact rules always enforced. Use only after guard_propose returned READY and the user agreed. If it reports that the approval was rejected or not shown, tell the user the reason it gives.',
    parameters: CHANGE_PARAMETERS,
    output: text,
    async execute(args, exec) {
      const request = requestOf(args)
      const result = await authoring.apply(request, cwdOf(exec), history(), async (prompt, display) => {
        const approval = service<ApprovalLike>('approval')
        if (approval === undefined || exec.agent === undefined) return 'unavailable'
        // reason (multi-line) goes to the audit log; displayReason is what the desktop card shows as one headline.
        const outcome = await approval.request({ agent: exec.agent, toolName: 'guard_apply', callId: exec.callId, reason: prompt, displayReason: { en: display }, signal: exec.signal })
        return askAnswer(outcome, approvalPolicy(approval, (exec.agent as { session?: unknown }).session))
      })
      const parts = [result.message]
      if (!result.applied && result.outcome === 'refused') parts.push(draftText(result.draft))
      if (result.test !== undefined && result.outcome === 'refused') parts.push(testText(result.test))
      return parts.join('\n')
    },
  }))

  ctx.inject(['systemPrompt'], scoped => {
    const prompt = (scoped as unknown as { systemPrompt: { section(section: { name: string, order: number, text: string, interpolate?: boolean }): () => void } }).systemPrompt
    scoped.effect(() => prompt.section({ name: 'dsh-guard-authoring', order: 2950, text: guidanceText(), interpolate: false }))
  })
  return authoring
}
