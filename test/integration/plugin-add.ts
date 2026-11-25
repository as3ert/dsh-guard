/**
 * Manual check: install dsh-guard into a fresh profile with `dsh plugin add`
 * and boot it headless with the scripted model. Needs pnpm on PATH (dsh
 * forwards `plugin` to pnpm) and, for a meaningful peer-dependency result,
 * a dsh installation separate from this checkout's devDependency:
 *
 *   DSH_GUARD_HOST_DSH=<prefix>/node_modules/@deepseek-ai/dsh node test/integration/plugin-add.ts
 *
 * Prints a JSON summary: install output, the composed bundle layer, the
 * probe's peer resolutions, and the tool results of the probe script.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir, writeTree } from '../helpers.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const slash = (path: string): string => path.replace(/\\/g, '/')

const hostDsh = resolve(process.env.DSH_GUARD_HOST_DSH ?? join(REPO, 'node_modules', '@deepseek-ai', 'dsh'))
const bin = join(hostDsh, 'lib', 'bin.js')
const root = tempDir('dsh-guard-plugin-add-')
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const probe = join(root, 'probe.json')
writeTree(root, { 'workspace/.dsh-guard/keep.yaml': 'rules: []\n', 'home/.keep': '', 'guard-home/.keep': '' })
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_GUARD_HOME: join(root, 'guard-home'),
  DSH_TELEMETRY_DISABLED: '1',
  DEEPSEEK_API_KEY: '',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  DSH_GUARD_IT_SCRIPT: 'probe',
  DSH_GUARD_IT_PROBE: probe,
}
const install = spawnSync(process.execPath, [bin, 'plugin', '--profile', 'headless', 'add', REPO], { env, encoding: 'utf8', timeout: 300_000, shell: false })
const dump = spawnSync(process.execPath, [bin, '--profile', 'headless', '--dump-config'], { env, encoding: 'utf8', timeout: 120_000 })
const overlay = join(root, 'overlay.yml')
writeFileSync(overlay, [
  '- id: agent-default-model',
  '  config: { provider: guard-fake, model: scripted }',
  '- id: otel',
  '  disabled: true',
  '- id: session-telemetry-otel',
  '  disabled: true',
  '- id: session-title-llm',
  '  disabled: true',
  '- insert:',
  '    - id: guard-fake-llm',
  `      name: '${slash(join(HERE, 'fake-llm.mjs'))}'`,
  '    - id: guard-peer-probe',
  `      name: '${slash(join(HERE, 'peer-probe.mjs'))}'`,
  '',
].join('\n'))
const boot = spawnSync(process.execPath, [bin, 'headless', '--patch', overlay, '--json', 'Run the probe script.'], { cwd: workspace, env, encoding: 'utf8', timeout: 240_000 })
const events = boot.stdout.split('\n').filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line) as Record<string, unknown>)
const peers = existsSync(probe) ? JSON.parse(readFileSync(probe, 'utf8')) as Record<string, string> : {}
const origin = (path: string): string => path.startsWith(hostDsh.slice(0, hostDsh.lastIndexOf(`${sep}@deepseek-ai`))) && !path.startsWith(REPO) ? 'host installation' : path.startsWith(REPO) ? 'checkout node_modules' : 'other'
console.log(JSON.stringify({
  hostDsh,
  separateHost: !hostDsh.startsWith(REPO),
  install: { status: install.status, tail: `${install.stdout}${install.stderr}`.trim().split('\n').slice(-6) },
  profileManifest: existsSync(join(home, 'profiles', 'headless', 'package.json')) ? JSON.parse(readFileSync(join(home, 'profiles', 'headless', 'package.json'), 'utf8')) : null,
  bundleLayer: dump.stdout.split('\n').filter(line => /dsh-guard/.test(line)),
  boot: { status: boot.status, stderrTail: boot.stderr.trim().split('\n').slice(-8) },
  peers: Object.fromEntries(Object.entries(peers).map(([name, path]) => [name, { path, origin: origin(path) }])),
  results: events.filter(event => event.type === 'tool_result').map(event => ({ callId: event.callId, status: event.status, result: String(event.result).slice(0, 160) })),
}, null, 1))
