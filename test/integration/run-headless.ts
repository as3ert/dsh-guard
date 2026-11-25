/**
 * Boot a real `dsh headless` from the pinned devDependency with the dsh-guard
 * plugin and the scripted fake adapter, in a temporary DSH_HOME and
 * workspace. Returns everything the assertions need.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir, writeTree } from '../helpers.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const FIXTURES = join(REPO, 'test', 'fixtures')

/** Rule files of the guard run: the integration rules and the credentials fixture rules (opt-in through `packs`). */
export const GUARD_RULES = { packs: [join(FIXTURES, 'rules', 'credentials.yaml')], extra: [join(FIXTURES, 'integration-rules.yaml')] }

/** No rule files: the state of a fresh install. */
export const NO_RULES = { packs: [], extra: [] }

/** Fake credential the redact rule must mask. */
export const FAKE_KEY = 'FIXTURE-SECRET-0123456789ABCDEF'

export interface HeadlessRun {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** Parsed `--json` event lines. */
  readonly events: Record<string, unknown>[]
  /** Requests the fake adapter received. */
  readonly requests: { purpose: string | null, tools: string[], messages: unknown[] }[]
  /** dsh-guard decision log records. */
  readonly log: Record<string, unknown>[]
  /** Approval requests the scripted answerer saw (only with `approver`). */
  readonly approvals: { toolName: string, callId: string | null, reason: string | null }[]
  /** Workspace directory the session ran in. */
  readonly workspace: string
}

/** Variants of the headless run. */
export interface RunOptions {
  /** Fake-model script: `guard` (default) or `authoring`. */
  readonly script?: 'guard' | 'authoring'
  /**
   * Rule files the plugin loads. Default: the integration rules plus the
   * credentials fixture rules. An empty list runs with no rules at all, as a fresh
   * install does.
   */
  readonly rules?: { packs: string[], extra: string[] }
  /** Mount a scripted answerer that approves every request once. */
  readonly approver?: boolean
  readonly timeoutMs?: number
}

function lines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Record<string, unknown>)
}

/** Forward slashes for module paths in the overlay. */
function slash(path: string): string {
  return path.replace(/\\/g, '/')
}

export function runHeadless(options: RunOptions = {}): HeadlessRun {
  const timeoutMs = options.timeoutMs ?? 240_000
  const rules = options.rules ?? GUARD_RULES
  const root = tempDir('dsh-guard-it-')
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const record = join(root, 'requests.jsonl')
  const logPath = join(root, 'guard-log.jsonl')
  const approvals = join(root, 'approvals.jsonl')
  writeTree(root, {
    'workspace/notes.txt': 'plain notes\n',
    'workspace/secret.txt': `DEEPSEEK_API_KEY=${FAKE_KEY}\n`,
    'home/.keep': '',
  })
  const overlay = join(root, 'overlay.yml')
  writeFileSync(overlay, [
    '- id: agent-default-model',
    '  config:',
    '    provider: guard-fake',
    '    model: scripted',
    '- id: otel',
    '  disabled: true',
    '- id: session-telemetry-otel',
    '  disabled: true',
    '- id: session-title-llm',
    '  disabled: true',
    '- insert:',
    '    - id: guard-fake-llm',
    `      name: '${slash(join(HERE, 'fake-llm.mjs'))}'`,
    ...options.approver === true ? ['    - id: guard-it-approver', `      name: '${slash(join(HERE, 'approver.mjs'))}'`] : [],
    '    - id: dsh-guard',
    `      name: '${slash(join(REPO, 'dist', 'index.js'))}'`,
    '      config:',
    `        logPath: '${slash(logPath)}'`,
    "        userDir: ''",
    `        packs: [${rules.packs.map(file => `'${slash(file)}'`).join(', ')}]`,
    `        extraRuleFiles: [${rules.extra.map(file => `'${slash(file)}'`).join(', ')}]`,
    '',
  ].join('\n'), 'utf8')
  const bin = join(REPO, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const result = spawnSync(process.execPath, [bin, 'headless', '--patch', overlay, '--json', 'Run the guard integration script.'], {
    cwd: workspace,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_GUARD_IT_RECORD: record,
      DSH_GUARD_IT_SCRIPT: options.script ?? 'guard',
      DSH_GUARD_IT_APPROVALS: approvals,
      DEEPSEEK_API_KEY: '',
      DSH_TELEMETRY_DISABLED: '1',
    },
    encoding: 'utf8',
    timeout: timeoutMs,
  })
  const events = result.stdout.split('\n').filter(line => line.trim().startsWith('{')).map(line => {
    try {
      return JSON.parse(line) as Record<string, unknown>
    } catch {
      return { unparsed: line }
    }
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    events,
    requests: lines(record) as HeadlessRun['requests'],
    log: lines(logPath),
    approvals: lines(approvals) as HeadlessRun['approvals'],
    workspace,
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const authoring = process.argv[2] === 'authoring'
  const run = runHeadless({ script: authoring ? 'authoring' : 'guard', approver: process.argv.includes('--approver'), rules: authoring ? NO_RULES : GUARD_RULES })
  console.log(JSON.stringify({ status: run.status, stderr: run.stderr.slice(-4000), events: run.events, log: run.log, approvals: run.approvals, requests: run.requests.length }, null, 1))
}
