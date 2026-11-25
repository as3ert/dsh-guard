/**
 * dsh-specific self-protection targets: the DSH home's profile patches and
 * bundle manifests, which hold the plugin row and its configuration, and the
 * `plugin_manager` tool, which could disable or remove the plugin.
 * @module
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { PATH_FLAGS, escapedPath } from '../core/builtin.ts'
import type { ProtectedPaths, SelfProtectText } from '../core/builtin.ts'
import type { GuardAdapter, GuardOptions } from '../core/core.ts'

/** Default DSH home, following `@deepseek-ai/dsh-home-paths`: `$DSH_HOME`, else `~/.dsh`. */
export function defaultDshHome(): string {
  const env = process.env.DSH_HOME
  return env !== undefined && env.trim() !== '' ? resolve(env) : join(homedir(), '.dsh')
}

/** Wording and examples of the self-protection rule in dsh. */
export const DSH_SELF_PROTECT: SelfProtectText = {
  doc: 'Generic file and shell tools may not change guard rules, the decision log or the plugin configuration; guard_apply does this after an approval.',
  message: 'Guard rule files and the dsh-guard configuration can only be changed through guard_apply, which asks the user. Use guard_draft, guard_test, guard_replay and guard_apply.',
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
}

/**
 * dsh additions to the generic protected paths.
 * @param base - generic targets from the guard options.
 * @param dshHome - DSH home whose patches hold the plugin configuration.
 */
export function dshProtectedPaths(base: ProtectedPaths, dshHome: string): ProtectedPaths {
  return {
    ...base,
    // Profile and home patches carry the plugin row and its config; package.json lists the profile's bundles.
    extraPatterns: [
      new RegExp(`^${escapedPath(dshHome)}/(profiles/[^/]+/)?(cordis(\\.patch)?\\.ya?ml|package\\.json|pnpm-workspace\\.yaml)$`, PATH_FLAGS),
    ],
    extraChecks: [view => {
      if (view.tool !== 'plugin_manager') return undefined
      const action = view.fields.action ?? ''
      return /^(set_plugin|set_bundle|remove_bundle)$/.test(action) && /dsh-guard/i.test(view.fields.target ?? '')
        ? { hit: true, message: 'The dsh-guard plugin cannot be disabled or removed by the agent; ask the user to do it.' }
        : undefined
    }],
  }
}

/**
 * The dsh adapter for {@link GuardCore}.
 * @param dshHome - DSH home; default `$DSH_HOME` or `~/.dsh`.
 */
export function dshAdapter(dshHome: string = defaultDshHome()): GuardAdapter {
  return {
    harness: 'dsh',
    protect: (base: ProtectedPaths, _options: GuardOptions) => dshProtectedPaths(base, dshHome),
    selfProtect: DSH_SELF_PROTECT,
  }
}
