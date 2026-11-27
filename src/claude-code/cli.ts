#!/usr/bin/env node
/**
 * cc-guard command line for Claude Code. Claude runs it through Bash (the
 * plugin's `bin/` puts `cc-guard` on the Bash tool's PATH); the user can
 * run it in a terminal. Read-only commands: `test`, `lint`, `explain`,
 * `list`, `stats`, `draft`, `replay`, `propose`. `apply` stores the change
 * as pending; it is written only after the user types the approval code the
 * plugin shows (see `approval.ts`).
 * @module
 */
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { GuardAuthoring, REPLAY_LIMIT, approvalDisplay, approvalPrompt, draftText, proposeText, replayText } from '../core/authoring.ts'
import type { AuthoringLayer, DraftRequest, Mode, Operation, ProposeWords } from '../core/authoring.ts'
import { GuardCore, builtinFor } from '../core/core.ts'
import type { GuardOptions } from '../core/core.ts'
import { runCli } from '../core/cli.ts'
import type { CliArgs } from '../core/cli.ts'
import type { ToolCall } from '../core/types.ts'
import { createPending } from './approval.ts'
import { readConfig } from './config.ts'
import type { ClaudeCodeConfig } from './config.ts'
import { callOf, outputText } from './mapping.ts'
import type { HookInput } from './mapping.ts'
import { claudeCodeAdapter } from './protect.ts'
import { transcriptHistory } from './transcript.ts'

const USAGE = `Usage: cc-guard <command> [options]

Commands:
  list                 rules in force: layers, phase, tools, action, log counts (--layer L, --observe)
  test                 run every rule's examples; exit 1 on any mismatch
  lint                 check schema, regexes, example forms and overrides; exit 1 on errors or warnings
  explain '<json>'     show which rules fire on one Claude Code tool call
  stats                observe-mode rules with would-have counts and false-positive candidates
  draft   --request F  check a rule change without writing anything
  replay  --request F  run a rule change against past tool calls from the transcripts
  propose --request F  draft, run the examples and replay in one step (READY or NOT READY)
  apply   --request F  propose again and store the change as pending; the plugin shows the user
                       a code, and the change is written only when the user types
                       \`guard approve <code>\` (valid 30 minutes)

Options:
  --cwd <dir>             project directory (default: current directory)
  --request <file>        change request as JSON: {"op": "add"|"modify"|"remove", "layer": "user"|"project"|"local",
                          "rule": {...}, "id": "...", "reason": "...", "mode": "observe"|"enforce"}
  --request-json '<json>' the same, inline
  --sessions <n>          replay: newest transcript files read (default 200)
  --all-projects          replay: read the transcripts of every project, not only --cwd
  --projects-dir <dir>    replay: transcript directory (default: <CLAUDE_CONFIG_DIR or ~/.claude>/projects)
  --no-user, --user-dir <dir>, --packs <a,b>, --rules <file>, --log <file>, --phase <phase>, --all

The explain call is a Claude Code hook input {"tool_name": "Bash", "tool_input": {"command": "..."}}
(with "tool_response" for the post_tool phase) or {"tool": "Bash", "input": {...}, "output": "..."}.
Configuration comes from the environment (DSH_GUARD_HOME, DSH_GUARD_STATE, DSH_GUARD_LOG, ...; see README).`

const WORDS: ProposeWords = {
  again: 'run cc-guard propose again',
  apply: 'run cc-guard apply with the same request',
  hint: 'the rule format and a complete example are in the cc-guard:guard-authoring skill.',
}

/** A call from a hook input or an engine call. */
export function parseClaudeCall(text: string, cwd: string): ToolCall {
  const raw = JSON.parse(text) as Record<string, unknown>
  if (typeof raw.tool_name === 'string') {
    const input = raw as HookInput
    const response = input.tool_response
    return callOf({ ...input, cwd: typeof input.cwd === 'string' ? input.cwd : cwd }, response === undefined ? undefined : outputText(response))
  }
  if (typeof raw.tool === 'string') {
    return {
      tool: raw.tool,
      input: (raw.input ?? {}) as Record<string, unknown>,
      ...typeof raw.output === 'string' ? { output: raw.output } : {},
      cwd: typeof raw.cwd === 'string' ? raw.cwd : cwd,
    }
  }
  throw new Error('the call needs "tool_name" and "tool_input", or "tool" and "input"')
}

/** Parse and check a change request object. */
export function requestFrom(value: unknown): DraftRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('the request must be a JSON object')
  const raw = value as Record<string, unknown>
  if (!['add', 'modify', 'remove'].includes(String(raw.op))) throw new Error('request.op must be add, modify or remove')
  if (!['user', 'project', 'local'].includes(String(raw.layer))) throw new Error('request.layer must be user, project or local')
  let rule = raw.rule
  if (typeof rule === 'string') rule = JSON.parse(rule) as unknown
  if (rule !== undefined && rule !== null && (typeof rule !== 'object' || Array.isArray(rule))) throw new Error('request.rule must be an object')
  if (raw.mode !== undefined && raw.mode !== 'observe' && raw.mode !== 'enforce') throw new Error('request.mode must be observe or enforce')
  return {
    op: raw.op as Operation,
    layer: raw.layer as AuthoringLayer,
    ...rule !== undefined && rule !== null ? { rule: rule as Record<string, unknown> } : {},
    ...typeof raw.id === 'string' ? { id: raw.id } : {},
    ...typeof raw.reason === 'string' ? { reason: raw.reason } : {},
    ...raw.mode !== undefined ? { mode: raw.mode as Mode } : {},
  }
}

function requestOf(args: CliArgs): DraftRequest {
  const file = args.values.request
  const inline = args.values['request-json']
  if (file === undefined && inline === undefined) throw new Error('this command needs --request <file> or --request-json <json>')
  const text = inline ?? readFileSync(file as string, 'utf8')
  return requestFrom(JSON.parse(text.replace(/^﻿/, '')))
}

/** Guard options of the configuration with the command-line overrides. */
function optionsOf(config: ClaudeCodeConfig, args: CliArgs): GuardOptions {
  return { ...config.options, cwd: args.cwd, userDir: args.userDir ?? '', packs: args.packs, extraRuleFiles: args.extra, logPath: args.log }
}

function coreOf(config: ClaudeCodeConfig, args: CliArgs): GuardCore {
  return new GuardCore(optionsOf(config, args), () => {}, claudeCodeAdapter(config))
}

function historyOf(config: ClaudeCodeConfig, args: CliArgs) {
  const sessions = Number.parseInt(args.values.sessions ?? '', 10)
  return transcriptHistory({
    projectsDir: args.values['projects-dir'] ?? config.projectsDir,
    ...args.flags.has('all-projects') ? {} : { project: args.cwd },
    ...Number.isFinite(sessions) && sessions > 0 ? { maxSessions: sessions } : {},
  })
}

/** Run the command line. */
export async function cli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const config = readConfig(env)
  const draftCommand = async (args: CliArgs): Promise<number> => {
    const draft = await new GuardAuthoring(coreOf(config, args)).draft(requestOf(args), args.cwd)
    console.log(draftText(draft, WORDS.hint))
    return draft.ok ? 0 : 1
  }
  const replayCommand = async (args: CliArgs): Promise<number> => {
    const authoring = new GuardAuthoring(coreOf(config, args))
    const draft = await authoring.draft(requestOf(args), args.cwd)
    if (!draft.ok) {
      console.log(draftText(draft, WORDS.hint))
      return 1
    }
    console.log(`${draftText(draft, WORDS.hint)}\n${replayText(authoring.replay(draft, await historyOf(config, args)(REPLAY_LIMIT)))}`)
    return 0
  }
  const proposeCommand = async (args: CliArgs): Promise<number> => {
    const result = await new GuardAuthoring(coreOf(config, args)).propose(requestOf(args), args.cwd, historyOf(config, args))
    console.log(proposeText(result, WORDS))
    return result.draft.ok && result.test?.ok === true ? 0 : 1
  }
  const applyCommand = async (args: CliArgs): Promise<number> => {
    const request = requestOf(args)
    const core = coreOf(config, args)
    const authoring = new GuardAuthoring(core)
    const result = await authoring.propose(request, args.cwd, historyOf(config, args))
    const { draft, test } = result
    if (!draft.ok || test === undefined || !test.ok) {
      console.log(`Not applied.\n${proposeText(result, WORDS)}`)
      return 1
    }
    const replay = result.replay ?? { scanned: 0, sessions: 0, skipped: 0, firing: 0, newlyFiring: 0, noLongerFiring: 0, samples: [], note: result.replayNote ?? 'replay unavailable' }
    const prompt = approvalPrompt(draft, test, replay, 'cc-guard').replace(/\nApprove to write the file\.$/, '')
    if (env.CLAUDECODE === undefined && process.stdin.isTTY === true) {
      console.log(prompt)
      const reader = createInterface({ input: process.stdin, output: process.stdout })
      const answer = (await reader.question('Type yes to write this change: ')).trim().toLowerCase()
      reader.close()
      if (answer !== 'yes') {
        console.log('Not applied.')
        return 1
      }
      const written = await authoring.apply(request, args.cwd, async () => replay.note !== undefined ? { calls: [], sessions: 0, note: replay.note } : { calls: [], sessions: 0 }, async () => 'allowed-once', 'terminal')
      await core.log.flush()
      console.log(written.message)
      return written.applied ? 0 : 1
    }
    const id = createPending(config.stateDir, request, args.cwd, draft, approvalDisplay(draft, test, replay, 'cc-guard'))
    console.log([
      prompt,
      `cc-guard pending change ${id}`,
      'Nothing is written yet. The cc-guard plugin now shows the user an approval code below this tool call (you do not see it).',
      'Show the user the rule, the example results and the replay hits above; the change is written only if the user types `guard approve <code>` within 30 minutes. You cannot approve it yourself.',
    ].join('\n'))
    return 0
  }
  return runCli(argv, {
    name: 'cc-guard',
    usage: USAGE,
    defaults: () => ({ userDir: config.options.userDir, log: config.options.logPath }),
    builtin: args => builtinFor(optionsOf(config, args), claudeCodeAdapter(config)),
    parseCall: parseClaudeCall,
    valueOptions: ['request', 'request-json', 'sessions', 'projects-dir'],
    flagOptions: ['all-projects'],
    commands: { draft: draftCommand, replay: replayCommand, propose: proposeCommand, apply: applyCommand },
    noRulesText: 'No guard rules exist yet: cc-guard ships no rules, so every tool call passes except those the built-in self-protection rule stops. The user can describe what should be guarded; turn that into a first rule with `cc-guard propose` and `cc-guard apply` (see the cc-guard:guard-authoring skill).',
  })
}

if (import.meta.main) process.exitCode = await cli(process.argv.slice(2))
