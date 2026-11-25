/**
 * Configuration of the Claude Code adapter. Hooks and the command line read
 * the same environment variables, so a value set in the `env` block of a
 * Claude Code settings file reaches both (plugin `userConfig` values reach
 * hooks only and are therefore not used).
 *
 * | variable | meaning | default |
 * |---|---|---|
 * | `DSH_GUARD_HOME` | user rule directory | `~/.dsh-guard` |
 * | `DSH_GUARD_LOG` | decision log; empty disables it | `<DSH_GUARD_HOME>/log.jsonl` |
 * | `DSH_GUARD_STATE` | pending approvals | `<DSH_GUARD_HOME>/state` |
 * | `DSH_GUARD_PACKS` | rule files or directories loaded first, separated by the path delimiter | none |
 * | `DSH_GUARD_RULES` | extra rule files loaded last, separated by the path delimiter | none |
 * | `DSH_GUARD_PROTECT` | further protected files or directories, separated by the path delimiter | none |
 * | `DSH_GUARD_FAIL_MODE` | `open` or `closed` | `open` |
 * | `DSH_GUARD_TIME_BUDGET_MS` | evaluation budget per call and phase | 250 |
 * | `CLAUDE_CONFIG_DIR` | Claude Code configuration directory | `~/.claude` |
 * @module
 */
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultOptions } from '../core/core.ts'
import type { GuardOptions } from '../core/core.ts'
import { defaultUserDir } from '../core/loader.ts'

/** Everything the hooks and the command line need to know. */
export interface ClaudeCodeConfig {
  /** Guard options for {@link GuardCore}. */
  readonly options: GuardOptions
  /** Directory of pending approvals. */
  readonly stateDir: string
  /** Claude Code configuration directories whose settings and plugins are protected. */
  readonly configDirs: readonly string[]
  /** `projects/` directory with the transcripts. */
  readonly projectsDir: string
  /** Root of the installed plugin (protected). */
  readonly pluginRoot: string
  /** Further protected paths from `DSH_GUARD_PROTECT`. */
  readonly protect: readonly string[]
}

/** Split a path-list variable. */
function list(value: string | undefined): string[] {
  return (value ?? '').split(delimiter).map(item => item.trim()).filter(item => item !== '').map(item => resolve(item))
}

/** Root of the plugin: two levels above this module (`dist/claude-code/` or `src/claude-code/`). */
export function codePluginRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/**
 * Read the configuration from an environment.
 * @param env - environment, `process.env` by default.
 * @param cwd - fallback project directory.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ClaudeCodeConfig {
  const home = homedir()
  const userDir = env.DSH_GUARD_HOME !== undefined && env.DSH_GUARD_HOME.trim() !== '' ? resolve(env.DSH_GUARD_HOME) : defaultUserDir()
  const logPath = env.DSH_GUARD_LOG !== undefined ? (env.DSH_GUARD_LOG.trim() === '' ? '' : resolve(env.DSH_GUARD_LOG)) : join(userDir, 'log.jsonl')
  const budget = Number.parseInt(env.DSH_GUARD_TIME_BUDGET_MS ?? '', 10)
  const configDir = env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR.trim() !== '' ? resolve(env.CLAUDE_CONFIG_DIR) : join(home, '.claude')
  const configDirs = [...new Set([configDir, join(home, '.claude')])]
  const options: GuardOptions = {
    ...defaultOptions(),
    failMode: env.DSH_GUARD_FAIL_MODE === 'closed' ? 'closed' : 'open',
    ...Number.isFinite(budget) && budget > 0 ? { timeBudgetMs: budget } : {},
    logPath,
    userDir,
    packs: list(env.DSH_GUARD_PACKS),
    extraRuleFiles: list(env.DSH_GUARD_RULES),
    cwd,
    reloadIntervalMs: 0,
    askAsBlock: true,
  }
  return {
    options,
    stateDir: env.DSH_GUARD_STATE !== undefined && env.DSH_GUARD_STATE.trim() !== '' ? resolve(env.DSH_GUARD_STATE) : join(userDir, 'state'),
    configDirs,
    projectsDir: join(configDir, 'projects'),
    pluginRoot: env.CLAUDE_PLUGIN_ROOT !== undefined && env.CLAUDE_PLUGIN_ROOT.trim() !== '' ? resolve(env.CLAUDE_PLUGIN_ROOT) : codePluginRoot(),
    protect: list(env.DSH_GUARD_PROTECT),
  }
}
