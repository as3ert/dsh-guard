#!/usr/bin/env node
/** dsh-guard command line for dsh: test, explain, lint, stats, list. @module */
import { builtinFor, defaultOptions } from './core/core.ts'
import { runCli } from './core/cli.ts'
import type { CliArgs } from './core/cli.ts'
import { defaultUserDir } from './core/loader.ts'
import { defaultLogPath } from './core/log.ts'
import type { ToolCall } from './core/types.ts'
import { NO_RULES_TEXT } from './dsh/text.ts'
import { dshAdapter } from './dsh/protect.ts'

const USAGE = `Usage: dsh-guard <command> [options]

Commands:
  test                 run every rule's examples; exit 1 on any mismatch
  explain '<json>'     show which rules fire on one tool call
  lint                 check schema, regexes, example forms and overrides, name the user rule directory;
                       exit 1 on errors or warnings
  stats                observe-mode rules with would-have counts and false-positive candidates
  list                 rules in force with layers, actions and log counts (--layer L, --observe)

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

function builtin(args: CliArgs) {
  const options = { ...defaultOptions(), cwd: args.cwd, userDir: args.userDir ?? '', packs: args.packs, extraRuleFiles: args.extra, logPath: args.log }
  return builtinFor(options, dshAdapter())
}

process.exitCode = await runCli(process.argv.slice(2), {
  name: 'dsh-guard',
  usage: USAGE,
  defaults: () => ({ userDir: defaultUserDir(), log: defaultLogPath() }),
  builtin,
  parseCall,
  noRulesText: NO_RULES_TEXT,
})
