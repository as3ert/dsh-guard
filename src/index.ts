/**
 * dsh-guard: declarative guard rules for DeepSeek Harness tool calls.
 * Cordis plugin entry: block rules become a monotonic guard, ask rules an
 * approval request, warn rules additional context, redact rules a masked
 * tool result.
 * @module dsh-guard
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, PreToolDecision, ToolErrorInfo, ToolExecution } from '@deepseek-ai/dsh-tools'
import { GuardCore, defaultOptions } from './core.ts'
import type { GuardOptions } from './core.ts'
import { redact } from './engine.ts'
import type { Hit, LayerName, ToolCall } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-guard': { kind: 'dsh-guard' } & ContextFormed
  }
}

export const name = 'dsh-guard'
export const inject = ['tools']

/** Plugin configuration; every field has a default. */
export interface Config {
  failMode?: 'open' | 'closed'
  timeBudgetMs?: number
  maxFieldChars?: number
  logPath?: string
  userDir?: string
  packs?: string[]
  extraRuleFiles?: string[]
  cwd?: string
  reloadIntervalMs?: number
  disableLayers?: LayerName[]
  checkLayers?: LayerName[]
}

const defaults = defaultOptions()
const LAYERS: LayerName[] = ['bundled', 'user', 'project', 'local', 'extra']

export const Config: z<Config> = z.object({
  failMode: z.union(['open', 'closed']).default('open').description('On internal errors or an exhausted time budget: open lets the call pass, closed denies it.'),
  timeBudgetMs: z.number().default(defaults.timeBudgetMs).description('Evaluation budget per call and phase, in milliseconds.'),
  maxFieldChars: z.number().default(defaults.maxFieldChars).description('Longer fields are matched on their head and tail only.'),
  logPath: z.string().default(defaults.logPath).description('JSONL decision log; empty disables logging.'),
  userDir: z.string().default(defaults.userDir).description('User rule directory; empty skips the user layer.'),
  packs: z.array(z.string()).default(defaults.packs).description('Bundled packs to load.'),
  extraRuleFiles: z.array(z.string()).default([]).description('Rule files loaded after the local layer.'),
  cwd: z.string().description('Fallback project directory; defaults to the process directory.'),
  reloadIntervalMs: z.number().default(defaults.reloadIntervalMs).description('Minimum interval between rule-file change checks; 0 disables hot reload.'),
  disableLayers: z.array(z.union(LAYERS)).default(defaults.disableLayers).description('Layers whose files may disable earlier rules.'),
  checkLayers: z.array(z.union(LAYERS)).default(defaults.checkLayers).description('Layers whose files may name check hooks (code).'),
})

const BLOCKED: ToolErrorInfo = { name: 'GuardError', code: 'GUARD_BLOCKED' }
const POST_BLOCKED: ToolErrorInfo = { name: 'GuardError', code: 'GUARD_RESULT_BLOCKED' }
const INTERNAL: ToolErrorInfo = { name: 'GuardError', code: 'GUARD_INTERNAL_ERROR' }

/** Per-call state carried from pre-execute to the guard and post-execute. */
interface ExecState {
  readonly call: ToolCall
  readonly warnings: string[]
  readonly blockedReason?: string
  readonly asked: boolean
}

/** Plain text of model-facing content blocks. */
function textOf(content: readonly ContentBlock[]): string {
  return content.map(block => (block.type === 'text' ? block.text : '')).filter(text => text !== '').join('\n')
}

/** Mask redact matches inside text blocks, leaving other blocks untouched. */
function maskBlocks(content: readonly ContentBlock[], hits: readonly Hit[]): { content: ContentBlock[], count: number } {
  let count = 0
  const masked = content.map(block => {
    if (block.type !== 'text') return block
    const out = redact(block.text, hits)
    count += out.count
    return out.count > 0 ? { ...block, text: out.text } : block
  })
  return { content: masked, count }
}

/** Build the additional-context message for one warning. */
function warningMessage(text: string): UserMessage {
  const line = text.replace(/\s+/g, ' ')
  const summary = line.length > 120 ? `${line.slice(0, 119)}…` : line
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-guard', form: 'notice', summary },
  }) as UserMessage
}

/**
 * Install the guard.
 * @param ctx - plugin context; every registration is an effect of it.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const options: Partial<GuardOptions> = Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  ) as Partial<GuardOptions>
  const core = new GuardCore(options, (level, message) => {
    if (level === 'warn') ctx.logger.warn(message)
    else ctx.logger.info(message)
  })
  const failMode = core.options.failMode
  const states = new WeakMap<object, ExecState>()

  const cwdOf = (exec: Readonly<ToolExecution>): string => {
    try {
      const service = (ctx as unknown as { get(name: string): unknown }).get('workingDirectory') as { get(session: unknown): string } | undefined
      const session = (exec.agent as { session?: unknown } | undefined)?.session
      if (service !== undefined && session !== undefined) return service.get(session)
    } catch {
      // fall back to the configured directory
    }
    return core.options.cwd
  }
  const callOf = (exec: Readonly<ToolExecution>): ToolCall => {
    const input = typeof exec.arguments === 'object' && exec.arguments !== null && !Array.isArray(exec.arguments)
      ? exec.arguments as Record<string, unknown>
      : { arguments: exec.arguments }
    return { tool: exec.name, input, cwd: cwdOf(exec) }
  }
  const internalError = (where: string, error: unknown, call?: ToolCall): void => {
    ctx.logger.warn(`dsh-guard: ${where} failed (${failMode}): ${(error as Error)?.stack ?? String(error)}`)
    if (call !== undefined) core.note(call, '-', `internal-error-${failMode}`)
  }

  // Warm the cache so the synchronous guard has rules before the first call.
  void core.ruleSetFor(core.options.cwd).catch(error => internalError('initial rule load', error))

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    let call: ToolCall | undefined
    let outcome
    try {
      call = callOf(exec)
      outcome = await core.pre(call, exec.callId)
    } catch (error) {
      internalError('pre-execute', error, call)
      if (failMode === 'closed') return { kind: 'deny', reason: 'Blocked by dsh-guard: internal error (failMode: closed).', info: INTERNAL }
      return next()
    }
    states.set(exec, {
      call,
      warnings: outcome.warnings,
      asked: outcome.kind === 'ask',
      ...outcome.kind === 'deny' ? { blockedReason: outcome.reason } : {},
    })
    if (outcome.kind === 'deny') return { kind: 'deny', reason: outcome.reason ?? 'Blocked by dsh-guard.', info: BLOCKED }
    const downstream = await next()
    if (outcome.kind !== 'ask' || downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream
    const reason = downstream.kind === 'ask' && downstream.reason !== undefined
      ? `${outcome.reason}\n${downstream.reason}`
      : outcome.reason ?? 'dsh-guard asks for confirmation.'
    return { kind: 'ask', reason, displayReason: { en: reason } }
  }, { prepend: true })

  ctx.tools.guard(exec => {
    const state = states.get(exec)
    try {
      if (state !== undefined) return state.blockedReason === undefined ? undefined : { reason: state.blockedReason, info: BLOCKED }
      // Pre-execute did not see this call (an earlier listener short-circuited): check from cache.
      const reason = core.guardSync(callOf(exec))
      return reason === undefined ? undefined : { reason, info: BLOCKED }
    } catch (error) {
      internalError('guard', error, state?.call)
      return failMode === 'closed' ? { reason: 'Blocked by dsh-guard: internal error (failMode: closed).', info: INTERNAL } : undefined
    }
  })

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const downstream = await next()
    const state = states.get(exec)
    let call: ToolCall | undefined = state?.call
    try {
      call ??= callOf(exec)
      if (state?.asked) {
        const approvalDenied = result.isError && result.error?.info?.name === 'ApprovalError'
        core.note(call, '-', approvalDenied ? 'ask-denied' : 'ask-allowed', exec.callId)
      }
      // A replaced `value` re-renders its own content; it cannot be inspected here.
      const content: readonly ContentBlock[] | undefined = downstream.kind === 'block'
        ? downstream.feedback
        : downstream.value !== undefined
          ? undefined
          : downstream.content ?? result.content
      const outcome = await core.post({ ...call, output: content === undefined ? '' : textOf(content) }, exec.callId)
      const contexts = [...downstream.additionalContexts ?? [], ...[...state?.warnings ?? [], ...outcome.warnings].map(warningMessage)]
      const withContexts = contexts.length > 0 ? { additionalContexts: contexts } : {}
      if (outcome.kind === 'block') {
        return { kind: 'block', feedback: [{ type: 'text', text: outcome.feedback ?? 'Blocked by dsh-guard.' }], info: POST_BLOCKED, ...withContexts }
      }
      if (outcome.redactHits.length > 0 && content !== undefined) {
        const masked = maskBlocks(content, outcome.redactHits)
        if (masked.count > 0) {
          if (downstream.kind === 'block') return { ...downstream, feedback: masked.content, ...withContexts }
          return { kind: 'accept', content: masked.content, ...withContexts }
        }
      }
      return { ...downstream, ...withContexts } as PostToolDecision
    } catch (error) {
      internalError('post-execute', error, call)
      if (failMode === 'closed') return { kind: 'block', feedback: [{ type: 'text', text: 'Blocked by dsh-guard: internal error while checking the result (failMode: closed).' }], info: INTERNAL }
      return downstream
    }
  })

  ctx.effect(() => () => {
    void core.log.flush()
  })
}

export { GuardCore } from './core.ts'
export { evaluate, redact, overrideReason } from './engine.ts'
export { loadRules } from './loader.ts'
export type { Rule, RuleSet, ToolCall, Verdict } from './types.ts'
