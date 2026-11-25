#!/usr/bin/env node
/**
 * Development script, not part of the published package:
 *
 *   npm run pack:claude-code -- --out <dir> [--fail-closed] [export options]
 *
 * Builds the Claude Code plugin release:
 *
 * 1. removes `dist/` and rebuilds it with the checkout's TypeScript;
 * 2. assembles `<dir>/dsh-guard-claude-code-<version>/`: the plugin files of
 *    `plugin/claude-code/` (manifest, hooks, skill, `bin/` launchers), the
 *    compiled `dist/core/` and `dist/claude-code/` (JavaScript only), the
 *    runtime dependency `yaml` in `node_modules/`, a minimal `package.json`
 *    (`"type": "module"`), README and LICENSE; the manifest version is set
 *    from the root `package.json`;
 * 3. with `--fail-closed`, sets `onFailure: "block"` on the PreToolUse
 *    handler, so a hook that cannot start, crashes or times out blocks the
 *    call instead of letting it pass;
 * 4. scans the folder like the dsh export (absolute home paths, email
 *    addresses, private patterns, no YAML) and aborts on a finding;
 * 5. writes `<dir>/dsh-guard-claude-code-<version>.zip` (one top-level folder)
 *    and `<dir>/.claude-plugin/marketplace.json`, so `<dir>` can be added as
 *    a local marketplace and the folder can be passed to `claude --plugin-dir`.
 *
 * Export options (`--patterns`, `--rules-dir`, `--no-private-patterns`) are
 * passed through to the scan.
 * @module
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { parseArgs, scanTree } from './export.ts'
import { REPO, build, headTime, listFiles, writeZip } from './zip.ts'
import type { ZipEntry } from './zip.ts'

const PLUGIN = join(REPO, 'plugin', 'claude-code')

function splitArgs(argv: string[]): { out: string, failClosed: boolean, rest: string[] } {
  const rest: string[] = []
  let out: string | undefined
  let failClosed = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[++i]
      if (out === undefined) throw new Error('--out needs a value')
    } else if (argv[i] === '--fail-closed') failClosed = true
    else rest.push(argv[i])
  }
  if (out === undefined) throw new Error('usage: npm run pack:claude-code -- --out <dir> [--fail-closed] [--patterns <file> | --no-private-patterns] [--rules-dir <dir>]')
  return { out: resolve(out), failClosed, rest }
}

/** Copy the compiled JavaScript of one dist package. */
function copyJs(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) if (name.endsWith('.js')) cpSync(join(from, name), join(to, name))
}

/** `hooks.json` with `onFailure: "block"` on the PreToolUse handlers. */
export function failClosedHooks(text: string): string {
  const doc = JSON.parse(text) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> }
  for (const group of doc.hooks.PreToolUse ?? []) for (const handler of group.hooks) handler.onFailure = 'block'
  return `${JSON.stringify(doc, null, 2)}\n`
}

function main(): number {
  const { out, failClosed, rest } = splitArgs(process.argv.slice(2))
  const root = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string, dependencies?: Record<string, string> }
  const folder = `dsh-guard-claude-code-${root.version}`
  const tree = join(out, folder)
  if (existsSync(tree)) throw new Error(`${tree} exists; choose an empty --out directory`)
  build()
  mkdirSync(tree, { recursive: true })
  cpSync(PLUGIN, tree, { recursive: true })
  // A checkout with CRLF conversion would break the shebang of the POSIX launcher.
  const launcher = join(tree, 'bin', 'dsh-guard')
  writeFileSync(launcher, readFileSync(launcher, 'utf8').replaceAll('\r\n', '\n'))
  const manifestFile = join(tree, '.claude-plugin', 'plugin.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
  writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, version: root.version }, null, 2)}\n`)
  if (failClosed) {
    const hooksFile = join(tree, 'hooks', 'hooks.json')
    writeFileSync(hooksFile, failClosedHooks(readFileSync(hooksFile, 'utf8')))
  }
  copyJs(join(REPO, 'dist', 'core'), join(tree, 'dist', 'core'))
  copyJs(join(REPO, 'dist', 'claude-code'), join(tree, 'dist', 'claude-code'))
  const vendored: string[] = []
  for (const name of Object.keys(root.dependencies ?? {})) {
    cpSync(join(REPO, 'node_modules', name), join(tree, 'node_modules', name), { recursive: true })
    vendored.push(`node_modules/${name}`)
  }
  writeFileSync(join(tree, 'package.json'), `${JSON.stringify({ name: 'dsh-guard-claude-code', version: root.version, private: true, type: 'module', license: 'MIT', dependencies: root.dependencies ?? {} }, null, 2)}\n`)
  for (const file of ['README.md', 'LICENSE']) cpSync(join(REPO, file), join(tree, file))
  for (const required of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'skills/guard-authoring/SKILL.md', 'bin/dsh-guard', 'bin/dsh-guard.cmd', 'dist/claude-code/hook.js', 'dist/claude-code/cli.js', 'dist/core/engine.js', 'node_modules/yaml/package.json']) {
    if (!existsSync(join(tree, required))) throw new Error(`the release lacks ${required}`)
  }
  const leftovers = scanTree(tree, parseArgs(rest), vendored)
  if (leftovers > 0) {
    console.error(`dsh-guard pack: the scan found ${leftovers} leftover(s); the folder ${tree} is kept for inspection and no zip was written`)
    return 1
  }
  mkdirSync(join(out, '.claude-plugin'), { recursive: true })
  writeFileSync(join(out, '.claude-plugin', 'marketplace.json'), `${JSON.stringify({
    name: 'dsh-guard-local',
    owner: { name: 'dsh-guard' },
    plugins: [{ name: 'dsh-guard', source: `./${folder}`, description: manifest.description, version: root.version }],
  }, null, 2)}\n`)
  const files = listFiles(tree)
  const dirs = new Set<string>([`${folder}/`])
  for (const path of files) for (let dir = posix.dirname(path); dir !== '.'; dir = posix.dirname(dir)) dirs.add(`${folder}/${dir}/`)
  const entries: ZipEntry[] = [
    ...[...dirs].sort().map(name => ({ name })),
    ...files.map(path => ({ name: `${folder}/${path}`, data: readFileSync(join(tree, path)), executable: path === 'bin/dsh-guard' })),
  ]
  const zip = join(out, `${folder}.zip`)
  const size = writeZip(zip, entries, headTime())
  const unpacked = files.reduce((sum, path) => sum + statSync(join(tree, path)).size, 0)
  console.log(`dsh-guard pack: ${tree} (${files.length} files, ${unpacked} bytes${failClosed ? ', fail-closed' : ''}), ${zip} (${size} bytes), marketplace ${join(out, '.claude-plugin', 'marketplace.json')}`)
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`dsh-guard pack: ${(error as Error).message}`)
    process.exitCode = 2
  }
}
