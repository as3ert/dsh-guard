/**
 * Built-in rules that no layer can override or disable. The self-protection
 * rule keeps generic file and shell tools away from the guard's own rule
 * files and configuration; only the harness's approved authoring path writes
 * them. The generic targets (rule directories, rule files, the decision log,
 * the guard's code) are known here; each harness adapter adds its own
 * (configuration files, plugin trees, extra checks) through
 * {@link ProtectedPaths}.
 * @module
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { normalizePath } from './tools.ts'
import type { CallView, Rule, RuleExamples } from './types.ts'

/** Id prefix reserved for built-in rules; rule files may not use it. */
export const RESERVED_PREFIX = 'dsh-guard.'

/** Id of the self-protection rule. */
export const SELF_PROTECT_ID = 'dsh-guard.self-protect'

/** Project rule directory names, relative to the session directory. */
export const PROJECT_DIRS = ['.dsh-guard', '.dsh-guard.local'] as const

/** Outcome of an adapter check: a hit with an optional message, or undefined. */
export type ExtraCheck = (view: CallView) => { hit: true, message?: string } | undefined

/** Paths the self-protection rule needs to know. */
export interface ProtectedPaths {
  /** User rule directory, or null when the user layer is off. */
  userDir: string | null
  /** Decision log, or empty when logging is off. */
  logPath: string
  /** Rule files from `extraRuleFiles`. */
  ruleFiles: readonly string[]
  /** Protected trees: the running guard code and every configured pack file or directory. */
  codeDirs: readonly string[]
  /** Further protected directories (adapter state, plugin trees). */
  extraDirs?: readonly string[]
  /** Further protected single files (harness settings). */
  extraFiles?: readonly string[]
  /** Patterns over the comparable absolute path (forward slashes; lower case on Windows and macOS). */
  extraPatterns?: readonly RegExp[]
  /** Patterns over a shell command that mark it as touching a protected location by name. */
  shellNames?: readonly RegExp[]
  /** Harness-specific checks run on every call, before the path checks. */
  extraChecks?: readonly ExtraCheck[]
}

/** Text and examples of the self-protection rule, supplied by the adapter. */
export interface SelfProtectText {
  doc: string
  message: string
  examples: RuleExamples
}

const caseless = process.platform === 'win32' || process.platform === 'darwin'

/** Comparable form of an absolute path. */
export function comparablePath(path: string): string {
  const slashed = normalizePath(resolve(path)).replace(/\/+$/, '')
  return caseless ? slashed.toLowerCase() : slashed
}

/** Regex source matching a comparable path literally. */
export function escapedPath(path: string): string {
  return comparablePath(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Flags for a regex over comparable paths. */
export const PATH_FLAGS = caseless ? 'i' : ''

/** Whether `path` is `root` or lies below it. */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

interface Targets { dirs: string[], files: string[], patterns: readonly RegExp[] }

/** Protected directories and single files for one session directory. */
function protectedTargets(paths: ProtectedPaths, cwd: string | undefined): Targets {
  const dirs: string[] = [...paths.codeDirs, ...paths.extraDirs ?? []]
  if (paths.userDir !== null) dirs.push(paths.userDir)
  if (cwd !== undefined) for (const name of PROJECT_DIRS) dirs.push(join(cwd, name))
  const files = [...paths.ruleFiles, ...paths.extraFiles ?? []]
  if (paths.logPath !== '') files.push(paths.logPath)
  return { dirs: dirs.map(comparablePath), files: files.map(comparablePath), patterns: paths.extraPatterns ?? [] }
}

/** Whether an absolute or session-relative path is protected. */
function isProtected(raw: string, cwd: string | undefined, targets: Targets): boolean {
  const trimmed = raw.trim()
  if (trimmed === '') return false
  const expanded = trimmed.startsWith('~/') || trimmed === '~' ? join(homedir(), trimmed.slice(1)) : trimmed
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd ?? process.cwd(), expanded)
  const path = comparablePath(absolute)
  return targets.dirs.some(dir => within(path, dir))
    || targets.files.includes(path)
    || targets.patterns.some(pattern => pattern.test(path))
}

/** Shell verbs and operators that create, change, move or delete files. */
export const SHELL_WRITE = new RegExp([
  String.raw`(^|[^0-9&<>=-])>{1,2}\s*[^\s&|]`,
  String.raw`\b(rm|rmdir|mv|cp|tee|touch|truncate|dd|ln|install|chmod|chown|unlink|mkdir|rsync|scp)\b`,
  String.raw`\b(sed|perl|ruby)\b[^|;&\n]*\s-i`,
  String.raw`\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Set-ItemProperty|Export-\w+)\b`,
  String.raw`(^|[;&|(\s])(ni|del|erase|ren|rename|move|copy|rd|sc|ac|xcopy|robocopy)(?=\s)`,
  String.raw`\bgit\s+(checkout|restore|rm|mv|reset|clean|stash|apply|am|pull|merge|rebase|switch)\b`,
  String.raw`\b(WriteAllText|WriteAllBytes|AppendAllText|writeFile\w*|appendFile\w*|open\s*\([^)]*['"][wa+])`,
].join('|'), 'i')

const PROJECT_DIR_NAME = /\.dsh-guard(\.local)?\b/i

/** Path-like tokens of a shell command, quotes stripped. */
function shellTokens(command: string): string[] {
  return command.split(/[\s;|&<>(){}=,]+/).map(token => token.replace(/^['"`]+|['"`]+$/g, '')).filter(token => token !== '')
}

/** Whether a shell command names a protected path and looks like a write. */
function shellWritesProtected(command: string, cwd: string | undefined, targets: Targets, names: readonly RegExp[]): boolean {
  if (!SHELL_WRITE.test(command)) return false
  if (PROJECT_DIR_NAME.test(command) || names.some(name => name.test(command))) return true
  const normalized = caseless ? normalizePath(command).toLowerCase() : normalizePath(command)
  if (targets.dirs.some(dir => normalized.includes(dir)) || targets.files.some(file => normalized.includes(file))) return true
  return shellTokens(command).some(token => /[\\/.]/.test(token) && isProtected(token, cwd, targets))
}

/** Paths a write or edit call touches. */
function writtenPaths(view: CallView): string[] {
  const value = view.fields.path
  return value === undefined ? [] : value.split('\n')
}

/**
 * Build the self-protection check.
 * @param paths - protected locations.
 * @returns a check hook for the built-in rule.
 */
export function selfProtectCheck(paths: ProtectedPaths): (view: CallView) => boolean | { hit: boolean, message?: string } {
  return view => {
    for (const check of paths.extraChecks ?? []) {
      const outcome = check(view)
      if (outcome !== undefined) return outcome
    }
    const cwd = view.cwd ?? view.fields.cwd
    const targets = protectedTargets(paths, cwd)
    switch (view.canonical) {
      case 'write':
      case 'edit':
        return writtenPaths(view).some(path => isProtected(path, cwd, targets))
      case 'shell':
        return shellWritesProtected(view.fields.command ?? '', cwd, targets, paths.shellNames ?? [])
      default:
        return false
    }
  }
}

/** Generic wording, used when an adapter supplies none. */
export const GENERIC_SELF_PROTECT: SelfProtectText = {
  doc: 'Generic file and shell tools may not change guard rules, the decision log or the guard configuration; the approved authoring path does this.',
  message: 'Guard rule files and the dsh-guard configuration can only be changed through the guard\'s authoring path, which asks the user.',
  examples: {
    block: [
      { tool: 'write', input: { file_path: '.dsh-guard/rules.yaml', content: 'rules: []' }, cwd: '/work/project' },
      { tool: 'shell', input: { command: 'rm -rf .dsh-guard' }, cwd: '/work/project' },
    ],
    pass: [
      { tool: 'read', input: { file_path: '.dsh-guard/rules.yaml' }, cwd: '/work/project' },
      { tool: 'write', input: { file_path: 'src/guard.ts', content: '' }, cwd: '/work/project' },
    ],
  },
}

/**
 * The built-in rules, compiled. They load after every layer and ignore
 * overrides and `disabled` entries.
 * @param paths - protected locations.
 * @param text - the adapter's wording and examples of the self-protection rule.
 */
export function builtinRules(paths: ProtectedPaths, text: SelfProtectText = GENERIC_SELF_PROTECT): Rule[] {
  const source = { layer: 'builtin' as const, file: '<built-in>' }
  return [{
    id: SELF_PROTECT_ID,
    doc: text.doc,
    when: 'pre_tool',
    tool: ['any'],
    match: {},
    action: 'block',
    message: text.message,
    override: false,
    examples: text.examples,
    sources: [source],
    matchers: [],
    checkFn: selfProtectCheck(paths),
  }]
}
