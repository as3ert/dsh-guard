#!/usr/bin/env node
/** dsh-guard command line: test, explain, lint. @module */
import { resolve } from 'node:path'
import { isObserve } from './authoring.ts'
import { builtinRules } from './builtin.ts'
import { defaultOptions, protectedPaths } from './core.ts'
import { evaluate, redact, ruleFires } from './engine.ts'
import { runExamples } from './examples.ts'
import { defaultUserDir, loadRules } from './loader.ts'
import { defaultLogPath } from './log.ts'
import { looksCatastrophic } from './regex.ts'
import { readLogStats } from './stats.ts'
import { viewOf } from './tools.ts'
import type { LoadOptions } from './loader.ts'
import type { Issue, Phase, RuleSet, ToolCall } from './types.ts'

const USAGE = `Usage: dsh-guard <command> [options]

Commands:
  test                 run every rule's examples; exit 1 on any mismatch
  explain '<json>'     show which rules fire on one tool call
  lint                 check schema, regexes and overrides, name the user rule directory;
                       exit 1 on errors or warnings
  stats                observe-mode rules with would-have counts and false-positive candidates

Options:
  --cwd <dir>          project directory (default: current directory)
  --no-user            skip the user layer ($DSH_GUARD_HOME, else ~/.dsh-guard)
  --user-dir <dir>     user rule directory
  --packs <a,b>        rule files or directories loaded before the user layer (default: none)
  --rules <file>       extra rule file, loaded last (repeatable)
  --phase <phase>      explain only: pre_tool or post_tool (default: post_tool when the call has output)
  --log <file>         stats only: decision log (default: ~/.dsh-guard/log.jsonl)
  --all                stats only: list every rule with hits, not only observe-mode rules

The explain call is {"tool": "bash", "input": {"command": "..."}, "output": "..."}
or a dsh tool/call record {"name": "bash", "arguments": "{...}"}.`

interface Args {
  command?: string
  positional: string[]
  cwd: string
  userDir: string | null
  packs: string[]
  extra: string[]
  phase?: Phase
  log: string
  all: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], cwd: process.cwd(), userDir: defaultUserDir(), packs: [], extra: [], log: defaultLogPath(), all: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = (): string => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
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
    else if (args.command === undefined) args.command = arg
    else args.positional.push(arg)
  }
  return args
}

function loadOptions(args: Args): LoadOptions {
  const options = { ...defaultOptions(), cwd: args.cwd, userDir: args.userDir ?? '', packs: args.packs, extraRuleFiles: args.extra, logPath: args.log }
  return { cwd: args.cwd, packs: args.packs, userDir: args.userDir, extraFiles: args.extra, builtin: builtinRules(protectedPaths(options)) }
}

function printIssues(issues: readonly Issue[]): void {
  for (const issue of issues) {
    console.log(`${issue.level.padEnd(7)} ${issue.file}${issue.id !== undefined ? ` [${issue.id}]` : ''}: ${issue.message}`)
  }
}

function countIssues(set: RuleSet): { errors: number, warnings: number } {
  return {
    errors: set.issues.filter(issue => issue.level === 'error').length,
    warnings: set.issues.filter(issue => issue.level === 'warning').length,
  }
}

async function cmdTest(args: Args): Promise<number> {
  const set = await loadRules(loadOptions(args))
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
  const { errors } = countIssues(set)
  console.log(`dsh-guard test: ${set.rules.length} rules, ${passed} examples passed, ${failed} failed, ${untested} rules without examples, ${errors} load errors`)
  return failed > 0 || errors > 0 ? 1 : 0
}

/** Accept either an engine call or a dsh tool/call record. */
function parseCall(text: string, cwd: string): ToolCall {
  const raw = JSON.parse(text) as Record<string, unknown>
  if (typeof raw.tool === 'string') {
    return {
      tool: raw.tool,
      input: (raw.input ?? {}) as Record<string, unknown>,
      ...typeof raw.output === 'string' ? { output: raw.output } : {},
      cwd: typeof raw.cwd === 'string' ? raw.cwd : cwd,
    }
  }
  if (typeof raw.name === 'string') {
    const input = typeof raw.arguments === 'string' ? JSON.parse(raw.arguments) as Record<string, unknown> : (raw.arguments ?? {}) as Record<string, unknown>
    return { tool: raw.name, input, ...typeof raw.output === 'string' ? { output: raw.output } : {}, cwd }
  }
  throw new Error('the call needs "tool" and "input", or "name" and "arguments"')
}

async function cmdExplain(args: Args): Promise<number> {
  const text = args.positional[0]
  if (text === undefined) throw new Error('explain needs a JSON tool call')
  const call = parseCall(text, args.cwd)
  const set = await loadRules(loadOptions(args))
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

async function cmdLint(args: Args): Promise<number> {
  const set = await loadRules(loadOptions(args))
  const extra: Issue[] = []
  for (const rule of set.all) {
    const file = rule.sources[rule.sources.length - 1].file
    for (const patterns of Object.values(rule.match)) {
      for (const pattern of patterns) {
        if (looksCatastrophic(pattern)) extra.push({ level: 'warning', file, id: rule.id, message: `pattern may backtrack catastrophically: ${pattern}` })
      }
    }
    if ((rule.examples?.block?.length ?? 0) === 0) extra.push({ level: 'notice', file, id: rule.id, message: 'no block example' })
    if (rule.override && rule.tool.every(name => name !== 'shell' && name !== 'any' && name !== 'bash' && name !== 'pwsh')) {
      extra.push({ level: 'notice', file, id: rule.id, message: '`override` only works for shell commands; it has no effect on this rule' })
    }
  }
  const issues = [...set.issues, ...extra]
  printIssues(issues)
  const errors = issues.filter(issue => issue.level === 'error').length
  const warnings = issues.filter(issue => issue.level === 'warning').length
  console.log(`user rule directory: ${args.userDir ?? '(skipped)'}`)
  console.log(`dsh-guard lint: ${set.all.length} rules from ${set.files.length} files, ${errors} errors, ${warnings} warnings`)
  return errors > 0 || warnings > 0 ? 1 : 0
}

async function cmdStats(args: Args): Promise<number> {
  const set = await loadRules(loadOptions(args))
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
  console.log(`dsh-guard stats: ${observe.length} observe-mode rules, ${stats.size} rules with log records`)
  return 0
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  switch (args.command) {
    case 'test': return cmdTest(args)
    case 'explain': return cmdExplain(args)
    case 'lint': return cmdLint(args)
    case 'stats': return cmdStats(args)
    case undefined:
    case 'help':
      console.log(USAGE)
      return args.command === 'help' ? 0 : 2
    default:
      console.error(`unknown command: ${args.command}\n\n${USAGE}`)
      return 2
  }
}

main().then(code => {
  process.exitCode = code
}, (error: unknown) => {
  console.error(`dsh-guard: ${(error as Error).message}`)
  process.exitCode = 2
})
