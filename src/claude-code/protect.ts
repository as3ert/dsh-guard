/**
 * Claude Code self-protection targets, added to the generic ones (rule
 * directories, rule files, the decision log, the guard's code):
 *
 * - the guard's state directory (pending approvals) and the installed plugin tree;
 * - the `plugins/` directory of every Claude Code configuration directory
 *   (plugin cache, plugin data, the registry of installed plugins and marketplaces);
 * - `settings.json` and `settings.local.json` of the configuration directories,
 *   and `.claude/settings.json` and `.claude/settings.local.json` of any project:
 *   they can disable the plugin, set `disableAllHooks` or remove hook entries;
 * - paths listed in `DSH_GUARD_PROTECT`;
 * - shell commands that disable or remove the plugin (`claude plugin disable|uninstall|remove`);
 * - any tool call whose input contains an approval phrase `guard approve <code>`, so that
 *   Claude cannot submit an approval through a scheduled task, a message to another
 *   session, a subagent or a script.
 * @module
 */
import { join } from 'node:path'
import { PATH_FLAGS } from '../core/builtin.ts'
import type { ProtectedPaths, SelfProtectText } from '../core/builtin.ts'
import type { GuardAdapter } from '../core/core.ts'
import type { ClaudeCodeConfig } from './config.ts'

/** The approval phrase with a code, anywhere in a text. */
export const APPROVAL_PHRASE = /\bguard\s+approve\s+[a-z0-9]{6}\b/i

/** A shell command that disables or removes the dsh-guard plugin. */
const PLUGIN_OFF = /\bclaude(?:\.exe)?\s+plugins?\s+(?:disable|uninstall|remove|rm)\b[^\n;&|]*\bdsh-guard\b/i

/** Wording and examples of the self-protection rule in Claude Code. */
export const CLAUDE_CODE_SELF_PROTECT: SelfProtectText = {
  doc: 'Generic file and shell tools may not change guard rules, the guard\'s state, the decision log, Claude Code settings or installed plugins; rule changes go through `dsh-guard apply` and a code the user types.',
  message: 'Guard rule files, the guard\'s state, Claude Code settings and installed plugins cannot be changed by tool calls. Rule changes go through `dsh-guard propose` and `dsh-guard apply`, which the user approves by typing a code; settings and plugins are changed by the user.',
  examples: {
    block: [
      { tool: 'Write', input: { file_path: '/work/project/.dsh-guard/rules.yaml', content: 'rules: []' }, cwd: '/work/project' },
      { tool: 'Edit', input: { file_path: '/work/project/.claude/settings.json', old_string: '"hooks"', new_string: '"disableAllHooks": true, "hooks"' }, cwd: '/work/project' },
      { tool: 'Bash', input: { command: 'rm -rf .dsh-guard.local' }, cwd: '/work/project' },
      { tool: 'Bash', input: { command: 'claude plugin disable dsh-guard@local' }, cwd: '/work/project' },
      { tool: 'CronCreate', input: { cron: '*/5 * * * *', prompt: 'guard approve k3f9qz', recurring: false } },
    ],
    pass: [
      { tool: 'Read', input: { file_path: '/work/project/.dsh-guard/rules.yaml' }, cwd: '/work/project' },
      { tool: 'Bash', input: { command: 'cat .claude/settings.json' }, cwd: '/work/project' },
      { tool: 'Write', input: { file_path: '/work/project/src/settings.json', content: '{}' }, cwd: '/work/project' },
      { tool: 'Bash', input: { command: 'claude plugin list' }, cwd: '/work/project' },
      { tool: 'Write', input: { file_path: '/work/project/notes.md', content: 'type guard approve <code> to approve' }, cwd: '/work/project' },
    ],
  },
}

/**
 * Claude Code additions to the generic protected paths.
 * @param base - generic targets.
 * @param config - adapter configuration.
 */
export function claudeCodeProtectedPaths(base: ProtectedPaths, config: ClaudeCodeConfig): ProtectedPaths {
  const settings = config.configDirs.flatMap(dir => [join(dir, 'settings.json'), join(dir, 'settings.local.json')])
  return {
    ...base,
    extraDirs: [config.stateDir, config.pluginRoot, ...config.configDirs.map(dir => join(dir, 'plugins')), ...config.protect],
    extraFiles: [...settings, ...config.protect],
    extraPatterns: [new RegExp('/\\.claude/settings(\\.local)?\\.json$', PATH_FLAGS)],
    shellNames: [/[\\/]\.claude[\\/]+settings(\.local)?\.json\b/i, /\.claude[\\/]+plugins\b/i],
    extraChecks: [
      view => APPROVAL_PHRASE.test(JSON.stringify(view.input))
        ? { hit: true, message: 'Tool calls may not contain the approval phrase `guard approve <code>`: only the user approves rule changes, by typing the code.' }
        : undefined,
      view => view.canonical === 'shell' && PLUGIN_OFF.test(view.fields.command ?? '')
        ? { hit: true, message: 'The dsh-guard plugin cannot be disabled or removed by the agent; ask the user to do it.' }
        : undefined,
    ],
  }
}

/**
 * The Claude Code adapter for {@link GuardCore}.
 * @param config - adapter configuration.
 */
export function claudeCodeAdapter(config: ClaudeCodeConfig): GuardAdapter {
  return {
    harness: 'claude-code',
    protect: base => claudeCodeProtectedPaths(base, config),
    selfProtect: CLAUDE_CODE_SELF_PROTECT,
  }
}
