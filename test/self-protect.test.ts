/** Built-in self-protection: generic tools cannot change guard rules or the plugin configuration. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { GuardCore } from '../src/core.ts'
import type { ToolCall } from '../src/types.ts'
import { tempDir, writeTree } from './helpers.ts'

function setup(files: Record<string, string> = {}) {
  const root = tempDir()
  writeTree(root, { 'project/.keep': '', ...files })
  const cwd = join(root, 'project')
  const core = new GuardCore({
    packs: [join(root, 'packs')], userDir: join(root, 'user'), logPath: join(root, 'user', 'log.jsonl'), cwd, dshHome: join(root, 'dsh-home'), reloadIntervalMs: 0,
  })
  return { root, cwd, core }
}

describe('self-protection', () => {
  const blocked: [string, (root: string, cwd: string) => ToolCall][] = [
    ['a write into .dsh-guard/', (_root, cwd) => ({ tool: 'write', input: { file_path: '.dsh-guard/rules.yaml', content: 'rules: []' }, cwd })],
    ['an absolute edit in .dsh-guard.local/', (_root, cwd) => ({ tool: 'edit', input: { file_path: join(cwd, '.dsh-guard.local', 'x.yaml'), old_string: 'a', new_string: 'b' }, cwd })],
    ['a str_replace_editor create in the user dir', (root, cwd) => ({ tool: 'str_replace_editor', input: { command: 'create', path: join(root, 'user', 'mine.yaml'), file_text: '' }, cwd })],
    ['an apply_patch touching project rules', (_root, cwd) => ({ tool: 'apply_patch', input: { input: '*** Begin Patch\n*** Delete File: .dsh-guard/rules.yaml\n*** End Patch' }, cwd })],
    ['a write to the decision log', (root, cwd) => ({ tool: 'write', input: { file_path: join(root, 'user', 'log.jsonl'), content: '' }, cwd })],
    ['an edit of a profile patch', (root, cwd) => ({ tool: 'edit', input: { file_path: join(root, 'dsh-home', 'profiles', 'tui', 'cordis.patch.yml'), old_string: 'dsh-guard', new_string: '' }, cwd })],
    ['an edit of the home patch', (root, cwd) => ({ tool: 'write', input: { file_path: join(root, 'dsh-home', 'cordis.patch.yml'), content: '' }, cwd })],
    ['a write into a configured pack directory', (root, cwd) => ({ tool: 'write', input: { file_path: join(root, 'packs', 'team.yaml'), content: '' }, cwd })],
    ['a write into the plugin code', (_root, cwd) => ({ tool: 'write', input: { file_path: join(import.meta.dirname, '..', 'src', 'index.ts'), content: '' }, cwd })],
    ['rm of the project rule dir', (_root, cwd) => ({ tool: 'bash', input: { command: 'rm -rf .dsh-guard' }, cwd })],
    ['a redirect into the local rule dir', (_root, cwd) => ({ tool: 'bash', input: { command: "echo '- id: x' > .dsh-guard.local/x.yaml" }, cwd })],
    ['sed -i on a user rule file', (root, cwd) => ({ tool: 'bash', input: { command: `sed -i s/block/warn/ ${join(root, 'user', 'rules.yaml').replace(/\\/g, '/')}` }, cwd })],
    ['Remove-Item in pwsh', (_root, cwd) => ({ tool: 'pwsh', input: { command: 'Remove-Item -Recurse .dsh-guard' }, cwd })],
    ['git checkout of the rule dir', (_root, cwd) => ({ tool: 'bash', input: { command: 'git checkout HEAD~3 -- .dsh-guard/' }, cwd })],
    ['plugin_manager disabling dsh-guard', () => ({ tool: 'plugin_manager', input: { action: 'set_plugin', target: 'dsh-guard', enabled: false } })],
    ['plugin_manager removing the bundle', () => ({ tool: 'plugin_manager', input: { action: 'remove_bundle', target: 'dsh-guard' } })],
  ]
  for (const [name, make] of blocked) {
    it(`blocks ${name}`, async () => {
      const { root, cwd, core } = setup()
      const call = make(root, cwd)
      const outcome = await core.pre(call)
      assert.equal(outcome.kind, 'deny', name)
      assert.match(outcome.reason ?? '', /\[dsh-guard\.self-protect\]/)
      // The monotonic guard denies it too.
      assert.match(core.guardSync(call) ?? '', /self-protect/)
    })
  }

  const passed: [string, (root: string, cwd: string) => ToolCall][] = [
    ['reading a rule file', (_root, cwd) => ({ tool: 'read', input: { file_path: '.dsh-guard/rules.yaml' }, cwd })],
    ['cat of a rule file', (_root, cwd) => ({ tool: 'bash', input: { command: 'cat .dsh-guard/rules.yaml' }, cwd })],
    ['dsh-guard CLI commands', (_root, cwd) => ({ tool: 'bash', input: { command: 'dsh-guard test --cwd .' }, cwd })],
    ['a normal write', (_root, cwd) => ({ tool: 'write', input: { file_path: 'src/app.ts', content: '' }, cwd })],
    ['a file named like the dir elsewhere', (_root, cwd) => ({ tool: 'write', input: { file_path: 'docs/dsh-guard.md', content: '' }, cwd })],
    ['listing plugins', () => ({ tool: 'plugin_manager', input: { action: 'list_plugins' } })],
    ['disabling another plugin', () => ({ tool: 'plugin_manager', input: { action: 'set_plugin', target: 'otel', enabled: false } })],
  ]
  for (const [name, make] of passed) {
    it(`allows ${name}`, async () => {
      const { root, cwd, core } = setup()
      assert.equal((await core.pre(make(root, cwd))).kind, 'allow', name)
    })
  }

  it('cannot be overridden or disabled by any layer', async () => {
    const disable = 'rules:\n  - id: dsh-guard.self-protect\n    disabled: true\n    reason: in the way\n  - id: dsh-guard.self-protect\n    action: warn\n'
    const { cwd, core } = setup({ 'user/off.yaml': disable, 'project/.dsh-guard.local/off.yaml': disable, 'project/.dsh-guard/off.yaml': disable })
    const set = await core.ruleSetFor(cwd)
    const reserved = set.issues.filter(issue => issue.id === 'dsh-guard.self-protect')
    assert.equal(reserved.length, 6)
    assert.ok(reserved.every(issue => /reserved for built-in rules/.test(issue.message)))
    const rule = set.rules.find(item => item.id === 'dsh-guard.self-protect')
    assert.equal(rule?.action, 'block')
    assert.equal((await core.pre({ tool: 'write', input: { file_path: '.dsh-guard/x.yaml', content: '' }, cwd })).kind, 'deny')
  })
})
