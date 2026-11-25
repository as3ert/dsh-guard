/** Turn rule examples into calls and check them. @module */
import { evaluate } from './engine.ts'
import { canonicalName } from './tools.ts'
import type { Rule, ToolCall } from './types.ts'

const DEFAULT_TOOL: Readonly<Record<string, string>> = {
  shell: 'bash', edit: 'edit', write: 'write', read: 'read', fetch: 'web_fetch', search: 'web_search', any: 'bash',
}

/** Raw tool name used for an example of this rule. */
function exampleTool(rule: Rule): string {
  const named = rule.tool.find(name => name !== 'any') ?? 'any'
  return DEFAULT_TOOL[named] ?? named
}

/**
 * Build the call an example stands for.
 * A string is the primary field (command, path, url, query, or the output
 * of a post_tool rule); a mapping with `tool`/`input`/`output`/`cwd` is a
 * full call; any other mapping is the input of the rule's tool.
 * @param rule - the rule the example belongs to.
 * @param example - YAML value.
 * @returns the call, or an error.
 */
export function exampleCall(rule: Rule, example: unknown): { call?: ToolCall, error?: string } {
  const tool = exampleTool(rule)
  if (typeof example === 'string') {
    if (rule.when === 'post_tool') return { call: { tool, input: {}, output: example } }
    switch (canonicalName(tool, {})) {
      case 'shell': return { call: { tool, input: { command: example } } }
      case 'edit':
      case 'write':
      case 'read': return { call: { tool, input: { file_path: example } } }
      case 'fetch': return { call: { tool, input: { url: example } } }
      case 'search': return { call: { tool, input: { queries: [example] } } }
      default: return { error: `a string example needs a known tool; write {tool, input} for ${tool}` }
    }
  }
  if (typeof example !== 'object' || example === null || Array.isArray(example)) {
    return { error: 'an example must be a string or a mapping' }
  }
  const record = example as Record<string, unknown>
  const keys = Object.keys(record)
  const structured = keys.length > 0 && keys.every(key => ['tool', 'input', 'output', 'cwd'].includes(key))
  if (!structured) return { call: { tool, input: record } }
  const input = record.input ?? {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { error: '`input` must be a mapping' }
  if (record.tool !== undefined && typeof record.tool !== 'string') return { error: '`tool` must be a string' }
  if (record.output !== undefined && typeof record.output !== 'string') return { error: '`output` must be a string' }
  if (record.cwd !== undefined && typeof record.cwd !== 'string') return { error: '`cwd` must be a string' }
  return {
    call: {
      tool: (record.tool as string | undefined) ?? tool,
      input: input as Record<string, unknown>,
      ...record.output !== undefined ? { output: record.output as string } : {},
      ...record.cwd !== undefined ? { cwd: record.cwd as string } : {},
    },
  }
}

/** One example that did not behave as declared. */
export interface ExampleFailure {
  readonly rule: string
  readonly kind: 'block' | 'pass'
  readonly example: unknown
  readonly problem: string
}

/**
 * Run a rule's examples in isolation, override comments included.
 * @param rule - compiled rule.
 * @returns counts and failures.
 */
export function runExamples(rule: Rule): { passed: number, failures: ExampleFailure[] } {
  const failures: ExampleFailure[] = []
  let passed = 0
  for (const kind of ['block', 'pass'] as const) {
    for (const example of rule.examples?.[kind] ?? []) {
      const { call, error } = exampleCall(rule, example)
      if (call === undefined) {
        failures.push({ rule: rule.id, kind, example, problem: error ?? 'invalid example' })
        continue
      }
      let fired: boolean
      try {
        fired = evaluate([rule], call, rule.when).hits.length > 0
      } catch (evalError) {
        failures.push({ rule: rule.id, kind, example, problem: `evaluation threw: ${(evalError as Error).message}` })
        continue
      }
      if (fired === (kind === 'block')) passed += 1
      else failures.push({ rule: rule.id, kind, example, problem: kind === 'block' ? 'expected the rule to fire, it did not' : 'expected the rule not to fire, it did' })
    }
  }
  return { passed, failures }
}
