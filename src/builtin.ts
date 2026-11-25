/**
 * Built-in rules that no layer can override or disable. The self-protection
 * rule keeps generic file and shell tools away from the guard's own rule
 * files and configuration; only `guard_apply` (after an approval) writes them.
 * @module
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { normalizePath } from './tools.ts'
import type { CallView, Rule } from './types.ts'

/** Id prefix reserved for built-in rules; rule files may not use it. */
export const RESERVED_PREFIX = 'dsh-guard.'

/** Id of the self-protection rule. */
export const SELF_PROTECT_ID = 'dsh-guard.self-protect'

/** Paths the self-protection rule needs to know. */
export interface ProtectedPaths {
  /** User rule directory, or null when the user layer is off. */
  userDir: string | null
  /** Decision log, or empty when logging is off. */
  logPath: string
  /** Rule files from `extraRuleFiles`. */
  ruleFiles: readonly string[]
  /** Protected trees: the running plugin code and every configured pack file or directory. */
  codeDirs: readonly string[]
  /** DSH home; its profile patches hold the plugin configuration. */
  dshHome: string
}

/** Default DSH home, following `@deepseek-ai/dsh-home-paths`: `$DSH_HOME`, else `~/.dsh`. */
export function defaultDshHome(): string {
  const env = process.env.DSH_HOME
  return env !== undefined && env.trim() !== '' ? resolve(env) : join(homedir(), '.dsh')
}

const caseless = process.platform === 'win32' || process.platform === 'darwin'

/** Comparable form of an absolute path. */
function comparable(path: string): string {
  const slashed = normalizePath(resolve(path)).replace(/\/+$/, '')
  return caseless ? slashed.toLowerCase() : slashed
}

/** Whether `path` is `root` or lies below it. */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

/** Protected directories and single files for one session directory. */
function protectedTargets(paths: ProtectedPaths, cwd: string | undefined): { dirs: string[], files: string[], patterns: RegExp[] } {
  const dirs: string[] = [...paths.codeDirs]
  if (paths.userDir !== null) dirs.push(paths.userDir)
  if (cwd !== undefined) dirs.push(join(cwd, '.dsh-guard'), join(cwd, '.dsh-guard.local'))
  const files = [...paths.ruleFiles]
  if (paths.logPath !== '') files.push(paths.logPath)
  // Profile and home patches carry the plugin row and its config; package.json lists the profile's bundles.
  const home = comparable(paths.dshHome)
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`^${escaped}/(profiles/[^/]+/)?(cordis(\\.patch)?\\.ya?ml|package\\.json|pnpm-workspace\\.yaml)$`, caseless ? 'i' : ''),
  ]
  return { dirs: dirs.map(comparable), files: files.map(comparable), patterns }
}

/** Whether an absolute or session-relative path is protected. */
function isProtected(raw: string, cwd: string | undefined, targets: ReturnType<typeof protectedTargets>): boolean {
  const trimmed = raw.trim()
  if (trimmed === '') return false
  const expanded = trimmed.startsWith('~/') || trimmed === '~' ? join(homedir(), trimmed.slice(1)) : trimmed
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd ?? process.cwd(), expanded)
  const path = comparable(absolute)
  return targets.dirs.some(dir => within(path, dir))
    || targets.files.includes(path)
    || targets.patterns.some(pattern => pattern.test(path))
}

/** Shell verbs and operators that create, change, move or delete files. */
const SHELL_WRITE = new RegExp([
  String.raw`(^|[^0-9&<>=-])>{1,2}\s*[^\s&|]`,
  String.raw`\b(rm|rmdir|mv|cp|tee|touch|truncate|dd|ln|install|chmod|chown|unlink|mkdir|rsync|scp)\b`,
  String.raw`\b(sed|perl|ruby)\b[^|;&\n]*\s-i`,
  String.raw`\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Set-ItemProperty|Export-\w+)\b`,
  String.raw`(^|[;&|(\s])(ni|del|erase|ren|rename|move|copy|rd|sc|ac|xcopy|robocopy)(?=\s)`,
  String.raw`\bgit\s+(checkout|restore|rm|mv|reset|clean|stash|apply|am|pull|merge|rebase|switch)\b`,
  String.raw`\b(WriteAllText|WriteAllBytes|AppendAllText|writeFile\w*|appendFile\w*|open\s*\([^)]*['"][wa+])`,
].join('|'), 'i')

/** Path-like tokens of a shell command, quotes stripped. */
function shellTokens(command: string): string[] {
  return command.split(/[\s;|&<>(){}=,]+/).map(token => token.replace(/^['"`]+|['"`]+$/g, '')).filter(token => token !== '')
}

/** Whether a shell command names a protected path and looks like a write. */
function shellWritesProtected(command: string, cwd: string | undefined, targets: ReturnType<typeof protectedTargets>): boolean {
  if (!SHELL_WRITE.test(command)) return false
  if (/\.dsh-guard(\.local)?\b/i.test(command)) return true
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
    const cwd = view.cwd ?? view.fields.cwd
    const targets = protectedTargets(paths, cwd)
    switch (view.canonical) {
      case 'write':
      case 'edit':
        return writtenPaths(view).some(path => isProtected(path, cwd, targets))
      case 'shell':
        return shellWritesProtected(view.fields.command ?? '', cwd, targets)
      default:
        if (view.tool === 'plugin_manager') {
          const action = view.fields.action ?? ''
          return /^(set_plugin|set_bundle|remove_bundle)$/.test(action) && /dsh-guard/i.test(view.fields.target ?? '')
            ? { hit: true, message: 'The dsh-guard plugin cannot be disabled or removed by the agent; ask the user to do it.' }
            : false
        }
        return false
    }
  }
}

/**
 * The built-in rules, compiled. They load after every layer and ignore
 * overrides and `disabled` entries.
 * @param paths - protected locations.
 */
export function builtinRules(paths: ProtectedPaths): Rule[] {
  const source = { layer: 'builtin' as const, file: '<built-in>' }
  return [{
    id: SELF_PROTECT_ID,
    doc: 'Generic file and shell tools may not change guard rules, the decision log or the plugin configuration; guard_apply does this after an approval.',
    when: 'pre_tool',
    tool: ['any'],
    match: {},
    action: 'block',
    message: 'Guard rule files and the dsh-guard configuration can only be changed through guard_apply, which asks the user. Use guard_draft, guard_test, guard_replay and guard_apply.',
    override: false,
    examples: {
      block: [
        { tool: 'write', input: { file_path: '.dsh-guard/rules.yaml', content: 'rules: []' }, cwd: '/work/project' },
        { tool: 'edit', input: { file_path: '/work/project/.dsh-guard.local/mine.yaml', old_string: 'block', new_string: 'warn' }, cwd: '/work/project' },
        { tool: 'bash', input: { command: 'rm -rf .dsh-guard' }, cwd: '/work/project' },
        { tool: 'pwsh', input: { command: "Set-Content -Path .dsh-guard.local\\x.yaml -Value ''" }, cwd: '/work/project' },
        { tool: 'bash', input: { command: "echo '- id: x' >> ~/.dsh-guard/rules.yaml" }, cwd: '/work/project' },
        { tool: 'plugin_manager', input: { action: 'set_plugin', target: 'dsh-guard', enabled: false } },
      ],
      pass: [
        { tool: 'read', input: { file_path: '.dsh-guard/rules.yaml' }, cwd: '/work/project' },
        { tool: 'bash', input: { command: 'cat .dsh-guard/rules.yaml' }, cwd: '/work/project' },
        { tool: 'write', input: { file_path: 'src/guard.ts', content: '' }, cwd: '/work/project' },
        { tool: 'plugin_manager', input: { action: 'list_plugins' } },
      ],
    },
    sources: [source],
    matchers: [],
    checkFn: selfProtectCheck(paths),
  }]
}
