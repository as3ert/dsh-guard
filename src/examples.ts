/** Turn rule examples into calls and check them. @module */
import { evaluate } from './engine.ts'
import { canonicalName } from './tools.ts'
import type { Rule, ToolCall } from './types.ts'

const DEFAULT_TOOL: Readonly<Record<string, string>> = {
  shell: 'bash', edit: 'edit', write: 'write', read: 'read', fetch: 'web_fetch', search: 'web_search', any: 'bash',
}

/** Raw tool name used for an example of this rule. */
function exampleTool(rule: Pick<Rule, 'tool'>): string {
  const named = rule.tool.find(name => name !== 'any') ?? 'any'
  return DEFAULT_TOOL[named] ?? named
}

/** Object form shown when a plain-string example is ambiguous for a tool. */
const OBJECT_FORM: Readonly<Record<string, string>> = {
  grep: '{"tool": "grep", "input": {"pattern": "<regex searched for>", "path": "<file or directory>"}}',
  glob: '{"tool": "glob", "input": {"pattern": "<glob>", "path": "<directory>"}}',
  web_search: '{"tool": "web_search", "input": {"queries": ["<query>"]}}',
  search: '{"tool": "grep", "input": {"pattern": "...", "path": "..."}} or {"tool": "web_search", "input": {"queries": ["..."]}}',
  write: '{"tool": "write", "input": {"file_path": "<path>", "content": "<text>"}}',
  edit: '{"tool": "edit", "input": {"file_path": "<path>", "old_string": "<old>", "new_string": "<new>"}}',
  apply_patch: '{"tool": "apply_patch", "input": {"input": "*** Begin Patch\\n*** Update File: <path>\\n..."}}',
  str_replace_editor: '{"tool": "str_replace_editor", "input": {"command": "create", "path": "<path>", "file_text": "<text>"}}',
}

/**
 * Error for a plain-string example of a tool with several matchable fields.
 * @param named - tool the rule names (canonical or raw).
 * @param canonical - canonical name of the example call.
 */
function ambiguousString(named: string, canonical: string): string {
  const fields = canonical === 'search' ? 'the search pattern, the query or the path' : canonical === 'edit' ? 'the path, the old or the new text' : 'the path or the content'
  const form = OBJECT_FORM[named] ?? OBJECT_FORM[canonical] ?? `{"tool": "${named}", "input": {...}}`
  return `a plain-string example is ambiguous for tool ${named} (it could be ${fields}); write it as an object, for example ${form}`
}

/**
 * Build the call an example stands for.
 * A string is shorthand only where one field is meant: the command of a
 * shell (or `any`) rule, the path of a read rule, the url of a fetch rule,
 * and the output of a post_tool rule. For write, edit and search tools
 * (grep, glob, web_search) a string is ambiguous and reported as an error.
 * A mapping with `tool`/`input`/`output`/`cwd` is a full call; any other
 * mapping is the input of the rule's tool.
 * @param rule - the rule the example belongs to.
 * @param example - YAML value.
 * @returns the call, or an error.
 */
export function exampleCall(rule: Pick<Rule, 'tool' | 'when'>, example: unknown): { call?: ToolCall, error?: string } {
  const tool = exampleTool(rule)
  if (typeof example === 'string') {
    if (rule.when === 'post_tool') return { call: { tool, input: {}, output: example } }
    const canonical = canonicalName(tool, {})
    switch (canonical) {
      case 'shell': return { call: { tool, input: { command: example } } }
      case 'read': return { call: { tool, input: { file_path: example } } }
      case 'fetch': return { call: { tool, input: { url: example } } }
      case 'edit':
      case 'write':
      case 'search': return { error: ambiguousString(rule.tool.find(name => name !== 'any') ?? tool, canonical) }
      default: return { error: `a string example needs a known tool; write {"tool": "${tool}", "input": {...}} for ${tool}` }
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
