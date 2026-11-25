#!/usr/bin/env node
/**
 * Development script, not part of the published package:
 *
 *   dsh-guard export --clean <dir>      (npm run export -- --clean <dir>)
 *
 * Copies the publishable tree of this checkout into <dir> and scans the copy
 * for leftovers that must not be published: absolute home paths, email
 * addresses other than noreply placeholders, rule files outside
 * `test/fixtures/rules/` (plus `test/fixtures/integration-rules.yaml`), fixture
 * rules that reuse an id or a regex of a private rule folder, and the
 * patterns of a private pattern file (one regex per line, kept outside this
 * repository). On a finding the copy is deleted (unless `--keep`) and the
 * exit code is 1. `scripts/pack.ts` reuses {@link exportClean} with the built
 * `dist/` and the runtime dependencies included, so the same checks run on the
 * shipped tree.
 *
 * Options:
 *   --clean <dir>           target directory; must be missing or empty and outside the checkout
 *   --patterns <file>       private pattern file (default: $DSH_GUARD_EXPORT_PATTERNS,
 *                           else ../dsh-guard-rules/export-scan.txt next to the checkout)
 *   --rules-dir <dir>       private rule folder whose ids and regexes fixtures must not reuse
 *                           (default: $DSH_GUARD_PRIVATE_RULES, else a `rules` folder beside the
 *                           private pattern file when it exists)
 *   --no-private-patterns   run only the built-in checks (no private pattern file)
 *   --keep                  keep the copy when the scan fails
 *   --with-dist             also copy and scan the built `dist/` (git-ignored; run `npm run build` first)
 *   --with-deps             also copy and scan the runtime `dependencies` (not the dsh peers) into
 *                           `node_modules/`, so the tree loads after `dsh plugin add` without an
 *                           install; a vendored file may name the addresses its own package.json names
 * @module
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { compilePattern } from '../src/core/regex.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Directories never exported, at any depth. */
const SKIP_DIRS = new Set(['.git', '.tools', 'node_modules', 'dist', 'coverage'])
/** Files never exported: logs, decision logs, packed tarballs and zips. */
const SKIP_FILE = /\.(log|jsonl|tgz|zip)$/i
/**
 * Internal planning documents of this private checkout: they describe the
 * maintainer's own setup and are never part of the publishable tree.
 */
const INTERNAL_FILES = new Set(['docs/claude-code-port.md'])
/**
 * YAML files allowed in the publishable tree: the synthetic fixture rules, the
 * integration rules, the dsh bundle layer, the example profile overlay and the
 * worked example rule shown in TESTING.md;
 * the last two hold no rules.
 */
function yamlAllowed(path: string): boolean {
  return path.startsWith('test/fixtures/rules/') || path === 'test/fixtures/integration-rules.yaml' ||
    path === 'cordis.patch.yml' || path === 'examples/headless-account.yml' || path === 'examples/canary-rule.yaml'
}

interface Check {
  readonly label: string
  readonly pattern: RegExp
  /** Matches that are allowed after all. */
  readonly allow?: (match: string) => boolean
}

const EMAIL_CHECK: Check = {
  label: 'email address',
  pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
  allow: match => /no-?reply/i.test(match),
}

/** Checks that need no private knowledge; safe to publish with this script. */
const BUILTIN_CHECKS: readonly Check[] = [
  { label: 'Windows profile path', pattern: /\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}/i },
  { label: 'macOS home path', pattern: /\/Users\/[A-Za-z0-9._-]+/ },
  { label: 'home path other than /home/user', pattern: /\/home\/(?!user\b)[A-Za-z0-9._-]+/ },
  EMAIL_CHECK,
]

/** Options of {@link exportClean}; the command-line flags map onto them one to one. */
export interface ExportArgs {
  clean?: string
  patterns?: string
  rulesDir?: string
  privatePatterns: boolean
  keep: boolean
  /** Copy and scan the built `dist/` as well. */
  withDist: boolean
  /** Copy and scan the runtime dependencies into `node_modules/` as well. */
  withDeps: boolean
}

/** Parse the export flags; `pack.ts` passes its remaining flags through here. */
export function parseArgs(argv: string[]): ExportArgs {
  const args: ExportArgs = { privatePatterns: true, keep: false, withDist: false, withDeps: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = (): string => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === 'export') continue
    if (arg === '--clean') args.clean = resolve(value())
    else if (arg === '--patterns') args.patterns = resolve(value())
    else if (arg === '--rules-dir') args.rulesDir = resolve(value())
    else if (arg === '--no-private-patterns') args.privatePatterns = false
    else if (arg === '--keep') args.keep = true
    else if (arg === '--with-dist') args.withDist = true
    else if (arg === '--with-deps') args.withDeps = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

/** A runtime dependency copied into the tree: its folder and the addresses its own package.json names. */
interface Vendored { readonly dir: string, readonly addresses: ReadonlySet<string> }

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

/**
 * Runtime dependencies of the checkout, followed through their own `dependencies`, as
 * folders below `node_modules/`; each installed version must equal the one in
 * `package-lock.json`. The dsh packages are peers and are never vendored.
 */
function runtimeDependencies(): Vendored[] {
  const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }
  const out = new Map<string, Vendored>()
  const visit = (name: string): void => {
    const dir = `node_modules/${name}`
    if (out.has(dir)) return
    const manifest = join(REPO, dir, 'package.json')
    if (!existsSync(manifest)) throw new Error(`runtime dependency ${name} is not installed; run \`npm ci\` first`)
    const text = readFileSync(manifest, 'utf8')
    const pkg = JSON.parse(text) as { version: string, dependencies?: Record<string, string> }
    const locked = lock.packages[dir]?.version
    if (locked !== pkg.version) throw new Error(`${dir} is ${pkg.version} but package-lock.json pins ${locked ?? 'nothing'}; run \`npm ci\` first`)
    out.set(dir, { dir, addresses: new Set(text.match(EMAIL) ?? []) })
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep)
  }
  const root = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  for (const name of Object.keys(root.dependencies ?? {})) visit(name)
  return [...out.values()]
}

/** Files of the publishable tree, relative to the checkout, with forward slashes. */
function publishableFiles(withDist: boolean, vendored: readonly Vendored[]): string[] {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  })
  const listed = git.status === 0 ? git.stdout.split('\0').filter(path => path !== '') : walk(REPO)
  const source = listed
    .map(path => path.replace(/\\/g, '/'))
    .filter(path => !path.split('/').some(part => SKIP_DIRS.has(part)))
  // dist/ is git-ignored and skipped above; --with-dist adds the top-level build output back.
  if (withDist) {
    const dist = join(REPO, 'dist')
    if (!existsSync(join(dist, 'index.js'))) throw new Error('dist/index.js is missing; run `npm run build` first')
    source.push(...walk(dist, REPO).map(path => path.replace(/\\/g, '/')))
  }
  // Vendored packages are copied whole, their own dist/ folders included.
  for (const { dir } of vendored) source.push(...walk(join(REPO, dir), REPO, false).map(path => path.replace(/\\/g, '/')))
  return source
    .filter(path => !SKIP_FILE.test(path) && !INTERNAL_FILES.has(path))
    .filter(path => existsSync(join(REPO, path)) && statSync(join(REPO, path)).isFile())
    .sort()
}

/** Every file below a directory (also the fallback without git); `skip` leaves out {@link SKIP_DIRS}. */
function walk(root: string, base = root, skip = true): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skip || !SKIP_DIRS.has(entry.name)) out.push(...walk(join(root, entry.name), base, skip))
    } else if (entry.isFile()) out.push(relative(base, join(root, entry.name)))
  }
  return out
}

/** Read the private pattern file: one regex per line, `#` comments, `(?i)` prefix allowed. */
function privateChecks(file: string): Check[] {
  return readFileSync(file, 'utf8').split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .map((line, index) => ({ label: `private pattern ${index + 1}`, pattern: compilePattern(line) }))
}

/** Ids and match regexes of the private rule folder, as plain strings. */
interface PrivateRules { readonly ids: Set<string>, readonly regexes: Set<string> }

function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') out.add(value.trim())
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out)
}

/** Read every rule YAML below a folder; the folder is private and never named in the published tree. */
function readRules(dir: string, ids: Set<string>, regexes: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) readRules(full, ids, regexes)
    else if (/\.ya?ml$/i.test(entry.name)) {
      const doc = parse(readFileSync(full, 'utf8')) as { rules?: unknown }
      for (const rule of Array.isArray(doc?.rules) ? doc.rules as Array<Record<string, unknown>> : []) {
        if (typeof rule?.id === 'string') ids.add(rule.id)
        collectStrings(rule?.match, regexes)
      }
    }
  }
}

function privateRules(dir: string): PrivateRules {
  const rules = { ids: new Set<string>(), regexes: new Set<string>() }
  readRules(dir, rules.ids, rules.regexes)
  return rules
}

/** Findings for fixture rules that reuse an id or a regex of the private rule folder. */
function fixtureOverlap(path: string, text: string, owner: PrivateRules): Finding[] {
  if (!path.startsWith('test/fixtures/') || !/\.ya?ml$/i.test(path)) return []
  const ids = new Set<string>()
  const regexes = new Set<string>()
  const doc = parse(text) as { rules?: unknown }
  for (const rule of Array.isArray(doc?.rules) ? doc.rules as Array<Record<string, unknown>> : []) {
    if (typeof rule?.id === 'string') ids.add(rule.id)
    collectStrings(rule?.match, regexes)
  }
  const findings: Finding[] = []
  for (const id of ids) if (owner.ids.has(id)) findings.push({ file: path, line: 0, label: 'fixture rule id also in the private rules', match: id })
  for (const regex of regexes) if (owner.regexes.has(regex)) findings.push({ file: path, line: 0, label: 'fixture regex also in the private rules', match: regex })
  return findings
}

interface Finding {
  readonly file: string
  readonly line: number
  readonly label: string
  readonly match: string
}

/** Scan one exported file: its path and, for text files, every line. */
function scanFile(path: string, text: string | undefined, checks: readonly Check[], allowed: ReadonlySet<string> = new Set()): Finding[] {
  const findings: Finding[] = []
  const test = (subject: string, line: number) => {
    for (const check of checks) {
      const flags = check.pattern.flags.includes('g') ? check.pattern.flags : `${check.pattern.flags}g`
      for (const match of subject.matchAll(new RegExp(check.pattern.source, flags))) {
        if (check.allow?.(match[0]) === true || (check === EMAIL_CHECK && allowed.has(match[0]))) continue
        findings.push({ file: path, line, label: check.label, match: match[0] })
      }
    }
  }
  test(path, 0)
  if (text !== undefined) text.split(/\r?\n/).forEach((content, index) => test(content, index + 1))
  const yaml = /\.ya?ml$/i.test(path)
  if (yaml && !yamlAllowed(path)) {
    findings.push({ file: path, line: 0, label: 'YAML file outside test/fixtures/rules', match: path })
  }
  return findings
}

/**
 * Copy the publishable tree into `args.clean` and scan the copy; returns the exit code.
 * Throws on a usage error (target inside the checkout or not empty, pattern file missing).
 */
export function exportClean(args: ExportArgs): number {
  if (args.clean === undefined) {
    console.error('usage: dsh-guard export --clean <dir> [--patterns <file> | --no-private-patterns] [--rules-dir <dir>] [--with-dist] [--with-deps] [--keep]')
    return 2
  }
  const target = args.clean
  if (target === REPO || target.startsWith(`${REPO}${sep}`)) throw new Error('the export directory must lie outside the checkout')
  if (existsSync(target) && readdirSync(target).length > 0) throw new Error(`the export directory is not empty: ${target}`)

  const checks: Check[] = [...BUILTIN_CHECKS]
  let rulesDir = args.rulesDir ?? process.env.DSH_GUARD_PRIVATE_RULES
  if (args.privatePatterns) {
    const file = args.patterns ?? process.env.DSH_GUARD_EXPORT_PATTERNS ?? resolve(REPO, '..', 'dsh-guard-rules', 'export-scan.txt')
    if (!existsSync(file)) {
      throw new Error(`private pattern file not found: ${file}; pass --patterns <file>, or --no-private-patterns to run only the built-in checks`)
    }
    checks.push(...privateChecks(file))
    rulesDir ??= join(dirname(file), 'rules')
  }
  const owner = rulesDir !== undefined && existsSync(rulesDir) ? privateRules(rulesDir) : undefined
  if (args.rulesDir !== undefined && owner === undefined) throw new Error(`private rule folder not found: ${args.rulesDir}`)

  const vendored = args.withDeps ? runtimeDependencies() : []
  const files = publishableFiles(args.withDist, vendored)
  const findings: Finding[] = []
  for (const path of files) {
    const from = join(REPO, path)
    const to = join(target, path)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    const bytes = readFileSync(to)
    const text = bytes.includes(0) ? undefined : bytes.toString('utf8')
    const own = vendored.find(({ dir }) => path.startsWith(`${dir}/`))
    findings.push(...scanFile(path, text, checks, own?.addresses))
    if (owner !== undefined && text !== undefined) findings.push(...fixtureOverlap(path, text, owner))
  }

  for (const finding of findings) {
    const shown = finding.match.length > 60 ? `${finding.match.slice(0, 59)}…` : finding.match
    console.log(`LEFTOVER ${finding.file}${finding.line > 0 ? `:${finding.line}` : ''}: ${finding.label}: ${shown}`)
  }
  const summary = `dsh-guard export: ${files.length} files copied to ${target}, ${checks.length} checks${owner === undefined ? '' : ', private rule overlap checked'}, ${findings.length} leftovers`
  if (findings.length > 0) {
    if (!args.keep) rmSync(target, { recursive: true, force: true })
    console.log(`${summary}; the export is NOT clean${args.keep ? '' : ' and was removed'}`)
    return 1
  }
  console.log(`${summary}; clean`)
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = exportClean(parseArgs(process.argv.slice(2)))
  } catch (error) {
    console.error(`dsh-guard export: ${(error as Error).message}`)
    process.exitCode = 2
  }
}
