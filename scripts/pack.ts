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
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'
import { exportClean, parseArgs } from './export.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }

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

/** Remove `dist/` and compile `src/` with the checkout's TypeScript. */
function build(): void {
  rmSync(join(REPO, 'dist'), { recursive: true, force: true })
  const tsc = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc')
  const result = spawnSync(process.execPath, [tsc, '-p', REPO], { cwd: REPO, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`build failed (tsc exit ${result.status ?? result.signal})`)
}

/** Every file below a directory, relative to it, with forward slashes, sorted. */
function listFiles(root: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...listFiles(root, path))
    else if (entry.isFile()) out.push(path)
  }
  return out.sort()
}

/** MS-DOS time and date of a timestamp, in local time as zip readers expect. */
function dosDateTime(date: Date): { time: number, date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

interface ZipEntry { readonly name: string, readonly data?: Buffer }

/**
 * Minimal zip writer (deflate, UTF-8 names, Unix permissions), so packing
 * needs no external zip tool on any platform. Directory entries end in `/`.
 */
function writeZip(file: string, entries: readonly ZipEntry[], stamp: Date): number {
  const { time, date } = dosDateTime(stamp)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const isDir = entry.data === undefined
    const raw = entry.data ?? Buffer.alloc(0)
    const deflated = isDir ? raw : deflateRawSync(raw, { level: 9 })
    const stored = isDir || deflated.length >= raw.length
    const body = stored ? raw : deflated
    const method = stored ? 0 : 8
    const crc = isDir ? 0 : crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    const mode = isDir ? 0o040755 : 0o100644
    central.writeUInt32LE(((mode << 16) | (isDir ? 0x10 : 0)) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  const zip = Buffer.concat([...locals, directory, end])
  writeFileSync(file, zip)
  return zip.length
}

/** Commit time of HEAD, so the same commit packs to the same bytes; now without git. */
function headTime(): Date {
  const git = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: REPO, encoding: 'utf8', env: GIT_ENV })
  const seconds = Number.parseInt(git.stdout ?? '', 10)
  return git.status === 0 && Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date()
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
    for (const required of ['package.json', 'cordis.patch.yml', 'dist/index.js', 'dist/cli.js', 'guidance/authoring.md', 'node_modules/yaml/package.json']) {
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
