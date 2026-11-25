#!/usr/bin/env node
/**
 * Development script, not part of the published package:
 *
 *   npm run pack:zip -- --out <dir> [export options]
 *
 * Builds a prebuilt release zip for users who install with the DeepSeek
 * Harness desktop app and have no Node.js or npm of their own:
 *
 * 1. removes `dist/` and rebuilds it with the checkout's TypeScript;
 * 2. runs the clean export (`scripts/export.ts`) into a temporary directory
 *    with `dist/` and the runtime dependencies (`yaml`, copied from the
 *    installed `node_modules/`) included, so every leftover and overlap check
 *    also covers the build output, and `dsh plugin add`, which links the
 *    folder without installing into it, finds `yaml`; a finding aborts the pack;
 * 3. writes `<dir>/dsh-guard-<version>.zip`, whose single top-level folder
 *    `dsh-guard-<version>/` can be passed to `dsh plugin add`.
 *
 * Export options (`--patterns`, `--rules-dir`, `--no-private-patterns`) are
 * passed through unchanged. `dist/` stays git-ignored.
 * @module
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import { exportClean, parseArgs } from './export.ts'
import { REPO, build, headTime, listFiles, writeZip } from './zip.ts'
import type { ZipEntry } from './zip.ts'

/** Split `--out <dir>` from the flags passed through to the export. */
function splitArgs(argv: string[]): { out: string, rest: string[] } {
  const rest: string[] = []
  let out: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[++i]
      if (out === undefined) throw new Error('--out needs a value')
    } else rest.push(argv[i])
  }
  if (out === undefined) throw new Error('usage: npm run pack:zip -- --out <dir> [--patterns <file> | --no-private-patterns] [--rules-dir <dir>]')
  return { out: resolve(out), rest }
}

function main(): number {
  const { out, rest } = splitArgs(process.argv.slice(2))
  const version = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version
  const folder = `dsh-guard-${version}`
  build()
  const staging = mkdtempSync(join(tmpdir(), 'dsh-guard-pack-'))
  try {
    const tree = join(staging, folder)
    const code = exportClean({ ...parseArgs(rest), clean: tree, keep: false, withDist: true, withDeps: true })
    if (code !== 0) {
      console.error('dsh-guard pack: the export scan failed; no zip written')
      return code
    }
    const files = listFiles(tree)
    for (const required of ['package.json', 'cordis.patch.yml', 'dist/index.js', 'dist/cli.js', 'dist/dsh/index.js', 'guidance/authoring.md', 'node_modules/yaml/package.json']) {
      if (!files.includes(required)) throw new Error(`the packed tree lacks ${required}`)
    }
    const dirs = new Set<string>([`${folder}/`])
    for (const path of files) {
      for (let dir = posix.dirname(path); dir !== '.'; dir = posix.dirname(dir)) dirs.add(`${folder}/${dir}/`)
    }
    const entries: ZipEntry[] = [
      ...[...dirs].sort().map(name => ({ name })),
      ...files.map(path => ({ name: `${folder}/${path}`, data: readFileSync(join(tree, path)) })),
    ]
    mkdirSync(out, { recursive: true })
    const zip = join(out, `${folder}.zip`)
    const size = writeZip(zip, entries, headTime())
    const unpacked = files.reduce((sum, path) => sum + statSync(join(tree, path)).size, 0)
    console.log(`dsh-guard pack: ${zip} (${size} bytes, ${files.length} files, ${unpacked} bytes unpacked)`)
    return 0
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(`dsh-guard pack: ${(error as Error).message}`)
  process.exitCode = 2
}
