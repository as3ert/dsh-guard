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
 * exit code is 1.
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
 * @module
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { compilePattern } from '../src/regex.ts'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Directories never exported, at any depth. */
const SKIP_DIRS = new Set(['.git', '.tools', 'node_modules', 'dist', 'coverage'])
/** Files never exported: logs, decision logs and packed tarballs. */
const SKIP_FILE = /\.(log|jsonl|tgz)$/i
/**
 * YAML files allowed in the publishable tree: the synthetic fixture rules, the
 * integration rules, and the dsh bundle layer, which holds no rules.
 */
function yamlAllowed(path: string): boolean {
  return path.startsWith('test/fixtures/rules/') || path === 'test/fixtures/integration-rules.yaml' || path === 'cordis.patch.yml'
}

interface Check {
  readonly label: string
  readonly pattern: RegExp
  /** Matches that are allowed after all. */
  readonly allow?: (match: string) => boolean
}

/** Checks that need no private knowledge; safe to publish with this script. */
const BUILTIN_CHECKS: readonly Check[] = [
  { label: 'Windows profile path', pattern: /\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}/i },
  { label: 'macOS home path', pattern: /\/Users\/[A-Za-z0-9._-]+/ },
  { label: 'home path other than /home/user', pattern: /\/home\/(?!user\b)[A-Za-z0-9._-]+/ },
  {
    label: 'email address',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
    allow: match => /no-?reply/i.test(match),
  },
]

interface Args {
  clean?: string
  patterns?: string
  rulesDir?: string
  privatePatterns: boolean
  keep: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { privatePatterns: true, keep: false }
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
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

/** Files of the publishable tree, relative to the checkout, with forward slashes. */
function publishableFiles(): string[] {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  })
  const listed = git.status === 0 ? git.stdout.split('\0').filter(path => path !== '') : walk(REPO)
  return listed
    .map(path => path.replace(/\\/g, '/'))
    .filter(path => !path.split('/').some(part => SKIP_DIRS.has(part)))
    .filter(path => !SKIP_FILE.test(path))
    .filter(path => existsSync(join(REPO, path)) && statSync(join(REPO, path)).isFile())
    .sort()
}

/** Fallback without git: every file below a directory. */
function walk(root: string, base = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walk(join(root, entry.name), base))
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
function scanFile(path: string, text: string | undefined, checks: readonly Check[]): Finding[] {
  const findings: Finding[] = []
  const test = (subject: string, line: number) => {
    for (const check of checks) {
      const flags = check.pattern.flags.includes('g') ? check.pattern.flags : `${check.pattern.flags}g`
      for (const match of subject.matchAll(new RegExp(check.pattern.source, flags))) {
        if (check.allow?.(match[0]) === true) continue
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

function main(): number {
  const args = parseArgs(process.argv.slice(2))
  if (args.clean === undefined) {
    console.error('usage: dsh-guard export --clean <dir> [--patterns <file> | --no-private-patterns] [--rules-dir <dir>] [--keep]')
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

  const files = publishableFiles()
  const findings: Finding[] = []
  for (const path of files) {
    const from = join(REPO, path)
    const to = join(target, path)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    const bytes = readFileSync(to)
    const text = bytes.includes(0) ? undefined : bytes.toString('utf8')
    findings.push(...scanFile(path, text, checks))
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

try {
  process.exitCode = main()
} catch (error) {
  console.error(`dsh-guard export: ${(error as Error).message}`)
  process.exitCode = 2
}
