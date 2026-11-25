/**
 * Command-line framework shared by the adapters: argument parsing and the
 * read-only commands `test`, `explain`, `lint`, `stats` and `list`. Each
 * adapter supplies how a call is parsed, its built-in rules and its own
 * extra commands.
 * @module
 */
import { resolve } from 'node:path'
import { isObserve } from './authoring.ts'
import { evaluate, redact, ruleFires } from './engine.ts'
import { exampleCall, runExamples } from './examples.ts'
import { loadRules } from './loader.ts'
import { looksCatastrophic, tokenPrefixRemark, unboundedTokenPrefixes } from './regex.ts'
import { readLogStats } from './stats.ts'
import { listText } from './text.ts'
import { viewOf } from './tools.ts'
import type { LoadOptions } from './loader.ts'
import type { Issue, Phase, Rule, RuleSet, ToolCall } from './types.ts'

/** Parsed command line. */
export interface CliArgs {
  command?: string
  positional: string[]
  cwd: string
  userDir: string | null
  packs: string[]
  extra: string[]
  phase?: Phase
  log: string
  all: boolean
  /** Adapter-specific options with a value, keyed without the leading dashes. */
  values: Record<string, string>
  /** Adapter-specific switches, keyed without the leading dashes. */
  flags: Set<string>
}

/** What an adapter plugs into the framework. */
export interface CliSpec {
  /** Program name in messages. */
  readonly name: string
  /** Full usage text. */
  readonly usage: string
  /** Default user rule directory and decision log. */
  readonly defaults: () => { userDir: string, log: string }
  /** Built-in rules for the parsed arguments. */
  readonly builtin: (args: CliArgs) => readonly Rule[]
  /** Parse the JSON call of `explain`. */
  readonly parseCall: (text: string, cwd: string) => ToolCall
  /** Adapter options that take a value (without dashes). */
  readonly valueOptions?: readonly string[]
  /** Adapter switches (without dashes). */
  readonly flagOptions?: readonly string[]
  /** Extra commands; they win over the shared ones of the same name. */
  readonly commands?: Readonly<Record<string, (args: CliArgs) => Promise<number>>>
  /** Explanation printed by `list` while no rule file defines a rule. */
  readonly noRulesText?: string
}

/** Parse the command line for one adapter. */
export function parseCliArgs(argv: readonly string[], spec: CliSpec): CliArgs {
  const defaults = spec.defaults()
  const args: CliArgs = { positional: [], cwd: process.cwd(), userDir: defaults.userDir, packs: [], extra: [], log: defaults.log, all: false, values: {}, flags: new Set() }
  const valueOptions = new Set(spec.valueOptions ?? [])
  const flagOptions = new Set(spec.flagOptions ?? [])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = (): string => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    const bare = arg.startsWith('--') ? arg.slice(2) : undefined
    if (arg === '--cwd') args.cwd = resolve(value())
    else if (arg === '--no-user') args.userDir = null
    else if (arg === '--user-dir') args.userDir = resolve(value())
    else if (arg === '--packs') args.packs = value().split(',').map(item => item.trim()).filter(item => item !== '').map(item => resolve(item))
    else if (arg === '--rules') args.extra.push(resolve(value()))
    else if (arg === '--log') args.log = resolve(value())
    else if (arg === '--all') args.all = true
    else if (arg === '--phase') {
      const phase = value()
      if (phase !== 'pre_tool' && phase !== 'post_tool') throw new Error('--phase must be pre_tool or post_tool')
      args.phase = phase
    } else if (arg === '-h' || arg === '--help') args.command = 'help'
    else if (bare !== undefined && valueOptions.has(bare)) args.values[bare] = value()
    else if (bare !== undefined && flagOptions.has(bare)) args.flags.add(bare)
    else if (bare !== undefined) throw new Error(`unknown option: ${arg}`)
    else if (args.command === undefined) args.command = arg
    else args.positional.push(arg)
  }
  return args
}

/** Layer selection of the parsed arguments. */
export function cliLoadOptions(args: CliArgs, spec: CliSpec): LoadOptions {
  return { cwd: args.cwd, packs: args.packs, userDir: args.userDir, extraFiles: args.extra, builtin: spec.builtin(args) }
}

/** Print load or lint issues, one per line. */
export function printIssues(issues: readonly Issue[]): void {
  for (const issue of issues) {
    console.log(`${issue.level.padEnd(7)} ${issue.file}${issue.id !== undefined ? ` [${issue.id}]` : ''}: ${issue.message}`)
  }
}

function countErrors(set: RuleSet): number {
  return set.issues.filter(issue => issue.level === 'error').length
}

async function cmdTest(args: CliArgs, spec: CliSpec): Promise<number> {
  const set = await loadRules(cliLoadOptions(args, spec))
  printIssues(set.issues.filter(issue => issue.level !== 'notice'))
  let passed = 0
  let failed = 0
  let untested = 0
  for (const rule of set.rules) {
    const examples = (rule.examples?.block?.length ?? 0) + (rule.examples?.pass?.length ?? 0)
    if (examples === 0) {
      untested += 1
      continue
    }
    const result = runExamples(rule)
    passed += result.passed
    failed += result.failures.length
    for (const failure of result.failures) {
      console.log(`FAIL [${failure.rule}] ${failure.kind} example ${JSON.stringify(failure.example)}: ${failure.problem}`)
    }
  }
  const errors = countErrors(set)
  console.log(`${spec.name} test: ${set.rules.length} rules, ${passed} examples passed, ${failed} failed, ${untested} rules without examples, ${errors} load errors`)
  return failed > 0 || errors > 0 ? 1 : 0
}

async function cmdExplain(args: CliArgs, spec: CliSpec): Promise<number> {
  const text = args.positional[0]
  if (text === undefined) throw new Error('explain needs a JSON tool call')
  const call = spec.parseCall(text, args.cwd)
  const set = await loadRules(cliLoadOptions(args, spec))
  printIssues(set.issues.filter(issue => issue.level === 'error'))
  const view = viewOf(call)
  const phase: Phase = args.phase ?? (call.output !== undefined ? 'post_tool' : 'pre_tool')
  console.log(`tool: ${call.tool} (canonical: ${view.canonical}), phase: ${phase}`)
  for (const [field, value] of Object.entries(view.fields)) {
    const shown = value.length > 120 ? `${value.slice(0, 119)}…` : value
    console.log(`  field ${field}: ${JSON.stringify(shown)}`)
  }
  for (const rule of set.all) {
    if (rule.when !== phase) continue
    const fired = rule.disabled === true ? undefined : ruleFires(rule, view).message
    const state = rule.disabled === true ? `disabled (${rule.reason})` : fired !== undefined ? `FIRES ${rule.action}` : 'no match'
    console.log(`  ${rule.id}: ${state}`)
  }
  const verdict = evaluate(set.rules, view, phase)
  for (const hit of verdict.overridden) console.log(`overridden: ${hit.rule.id} (reason: ${hit.overrideReason})`)
  console.log(`verdict: ${verdict.action ?? 'allow'}${verdict.hits.length > 0 ? ` (${verdict.hits.map(hit => hit.rule.id).join(', ')})` : ''}`)
  if (phase === 'post_tool' && call.output !== undefined) {
    const masked = redact(call.output, verdict.hits)
    if (masked.count > 0) console.log(`redacted output: ${masked.text}`)
  }
  return 0
}

async function cmdLint(args: CliArgs, spec: CliSpec): Promise<number> {
  const set = await loadRules(cliLoadOptions(args, spec))
  const extra: Issue[] = []
  for (const rule of set.all) {
    const file = rule.sources[rule.sources.length - 1].file
    for (const patterns of Object.values(rule.match)) {
      for (const pattern of patterns) {
        if (looksCatastrophic(pattern)) extra.push({ level: 'warning', file, id: rule.id, message: `pattern may backtrack catastrophically: ${pattern}` })
      }
    }
    if (rule.action === 'redact' || rule.promote_to === 'redact') {
      for (const pattern of rule.match.output ?? []) {
        for (const alternative of unboundedTokenPrefixes(pattern)) extra.push({ level: 'warning', file, id: rule.id, message: tokenPrefixRemark(alternative) })
      }
    }
    for (const kind of ['block', 'pass'] as const) {
      for (const example of rule.examples?.[kind] ?? []) {
        const { error } = exampleCall(rule, example)
        if (error !== undefined) extra.push({ level: 'error', file, id: rule.id, message: `${kind} example ${JSON.stringify(example)}: ${error}` })
      }
    }
    if ((rule.examples?.block?.length ?? 0) === 0) extra.push({ level: 'notice', file, id: rule.id, message: 'no block example' })
    if (rule.override && rule.tool.every(name => !['shell', 'any', 'bash', 'pwsh', 'Bash', 'PowerShell'].includes(name))) {
      extra.push({ level: 'notice', file, id: rule.id, message: '`override` only works for shell commands; it has no effect on this rule' })
    }
  }
  const issues = [...set.issues, ...extra]
  printIssues(issues)
  const errors = issues.filter(issue => issue.level === 'error').length
  const warnings = issues.filter(issue => issue.level === 'warning').length
  console.log(`user rule directory: ${args.userDir ?? '(skipped)'}`)
  console.log(`${spec.name} lint: ${set.all.length} rules from ${set.files.length} files, ${errors} errors, ${warnings} warnings`)
  return errors > 0 || warnings > 0 ? 1 : 0
}

async function cmdStats(args: CliArgs, spec: CliSpec): Promise<number> {
  const set = await loadRules(cliLoadOptions(args, spec))
  const stats = readLogStats(args.log)
  const observe = set.rules.filter(isObserve)
  console.log(`Observe-mode rules (action warn with promote_to), from ${args.log}:`)
  if (observe.length === 0) console.log('  none')
  for (const rule of observe) {
    const stat = stats.get(rule.id)
    const hits = stat?.verdicts.warn ?? 0
    const candidates = stat?.falsePositives ?? []
    console.log(`  ${rule.id} (${rule.sources[0].layer}, ${rule.sources[rule.sources.length - 1].file})`)
    console.log(`    would have ${rule.promote_to === 'block' ? 'blocked' : rule.promote_to === 'ask' ? 'asked on' : 'redacted'} ${hits} call(s); false-positive candidates (overridden calls): ${stat?.overrides ?? 0}`)
    for (const candidate of candidates.slice(-5)) console.log(`      ${candidate.time} ${candidate.summary} (reason: ${candidate.reason})`)
    if (hits > 0 && (stat?.overrides ?? 0) === 0) {
      console.log(`    suggestion: promote to ${rule.promote_to}; ask the agent (guard_apply op modify, action ${rule.promote_to}) or edit the rule. dsh-guard never promotes by itself.`)
    } else if (hits === 0) {
      console.log('    suggestion: keep observing; no hits yet.')
    } else {
      console.log('    suggestion: review the overridden calls and narrow the rule before promoting.')
    }
  }
  if (args.all) {
    console.log('All rules with log records:')
    for (const rule of set.all) {
      const stat = stats.get(rule.id)
      if (stat === undefined) continue
      const verdicts = Object.entries(stat.verdicts).map(([verdict, count]) => `${verdict} ${count}`).join(', ')
      console.log(`  ${rule.id}: ${verdicts}`)
    }
  }
  console.log(`${spec.name} stats: ${observe.length} observe-mode rules, ${stats.size} rules with log records`)
  return 0
}

async function cmdList(args: CliArgs, spec: CliSpec): Promise<number> {
  const set = await loadRules(cliLoadOptions(args, spec))
  const layer = args.values.layer
  console.log(listText(set.all, args.log, { ...layer !== undefined ? { layer } : {}, ...args.flags.has('observe') ? { observeOnly: true } : {} }, spec.noRulesText ?? ''))
  return 0
}

const SHARED: Record<string, (args: CliArgs, spec: CliSpec) => Promise<number>> = {
  test: cmdTest, explain: cmdExplain, lint: cmdLint, stats: cmdStats, list: cmdList,
}

/**
 * Run one command line and set the exit code.
 * @param argv - arguments after the program name.
 * @param spec - the adapter's part.
 */
export async function runCli(argv: readonly string[], spec: CliSpec): Promise<number> {
  try {
    const args = parseCliArgs(argv, { ...spec, valueOptions: [...spec.valueOptions ?? [], 'layer'], flagOptions: [...spec.flagOptions ?? [], 'observe'] })
    if (args.command === undefined || args.command === 'help') {
      console.log(spec.usage)
      return args.command === 'help' ? 0 : 2
    }
    const own = spec.commands?.[args.command]
    if (own !== undefined) return await own(args)
    const shared = SHARED[args.command]
    if (shared !== undefined) return await shared(args, spec)
    console.error(`unknown command: ${args.command}\n\n${spec.usage}`)
    return 2
  } catch (error) {
    console.error(`${spec.name}: ${(error as Error).message}`)
    return 2
  }
}
