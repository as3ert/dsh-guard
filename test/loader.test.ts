import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadRules } from '../src/loader.ts'
import type { LoadOptions } from '../src/loader.ts'
import { tempDir, writeTree } from './helpers.ts'

const BASE = `
rules:
  - id: demo.push
    tool: shell
    match: { command: 'git push' }
    action: warn
    message: pushing
    examples: { block: [git push], pass: [git status] }
`

function setup(files: Record<string, string>): LoadOptions {
  const root = tempDir()
  writeTree(root, files)
  return {
    cwd: join(root, 'project'),
    packs: [join(root, 'base.yaml')],
    userDir: join(root, 'user'),
  }
}

describe('loader', () => {
  it('loads the bundled packs without issues', async () => {
    const set = await loadRules({ cwd: tempDir(), userDir: null })
    assert.equal(set.issues.length, 0, JSON.stringify(set.issues))
    assert.ok(set.rules.some(rule => rule.id === 'safety.rm-rf-root'))
    assert.ok(set.rules.some(rule => rule.id === 'git.force-push'))
    assert.ok(set.rules.some(rule => rule.id === 'secrets.redact-output'))
  })

  it('skips a broken YAML file and reports it, keeping the other files', async () => {
    const options = setup({ 'base.yaml': BASE, 'user/broken.yaml': 'rules: [ { id: x, action: block\n' })
    const set = await loadRules(options)
    assert.equal(set.rules.length, 1)
    assert.ok(set.issues.some(issue => issue.level === 'error' && issue.file.endsWith('broken.yaml') && issue.message.includes('invalid YAML')))
  })

  it('skips an invalid rule but keeps valid rules of the same file', async () => {
    const options = setup({
      'base.yaml': BASE,
      'user/mixed.yaml': `
- id: bad.field
  action: block
  colour: red
- id: bad.phase
  action: redact
  match: { output: x }
- id: bad.regex
  action: block
  match: { command: '(' }
- id: good.one
  action: warn
  match: { command: ok }
`,
    })
    const set = await loadRules(options)
    const ids = set.rules.map(rule => rule.id).sort()
    assert.deepEqual(ids, ['demo.push', 'good.one'])
    assert.ok(set.issues.some(issue => issue.id === 'bad.field' && issue.message.includes('unknown field')))
    assert.ok(set.issues.some(issue => issue.id === 'bad.phase' && issue.message.includes('not valid for `pre_tool`')))
    assert.ok(set.issues.some(issue => issue.id === 'bad.regex' && issue.message.includes('match.command')))
  })

  it('rejects a redact rule without output patterns', async () => {
    const set = await loadRules(setup({ 'base.yaml': '- { id: r, when: post_tool, action: redact, match: { command: x } }' }))
    assert.equal(set.rules.length, 0)
    assert.ok(set.issues[0].message.includes('match.output'))
  })
})

describe('layering', () => {
  it('lets a later layer tighten the action', async () => {
    const set = await loadRules(setup({ 'base.yaml': BASE, 'user/u.yaml': '- { id: demo.push, action: block }' }))
    const rule = set.rules.find(r => r.id === 'demo.push')
    assert.equal(rule?.action, 'block')
    assert.equal(rule?.message, 'pushing')
    assert.equal(rule?.sources.length, 2)
  })

  it('rejects loosening with a warning and keeps the earlier rule', async () => {
    const set = await loadRules(setup({
      'base.yaml': BASE,
      'user/u.yaml': '- { id: demo.push, action: block }',
      'project/.dsh-guard/p.yaml': '- { id: demo.push, action: ask }',
    }))
    assert.equal(set.rules.find(r => r.id === 'demo.push')?.action, 'block')
    assert.ok(set.issues.some(issue => issue.level === 'warning' && issue.message.includes('loosens action block to ask')))
  })

  it('rejects turning on override and changing the scope', async () => {
    const set = await loadRules(setup({
      'base.yaml': BASE,
      'project/.dsh-guard/p.yaml': `
- { id: demo.push, override: true }
- { id: demo.push, match: { command: never-matches } }
`,
    }))
    const rule = set.rules.find(r => r.id === 'demo.push')
    assert.equal(rule?.override, false)
    assert.deepEqual(rule?.match, { command: ['git push'] })
    assert.equal(set.issues.filter(issue => issue.level === 'warning').length, 2)
  })

  it('allows disabling from the user and local layers only, and only with a reason', async () => {
    const fromUser = await loadRules(setup({ 'base.yaml': BASE, 'user/u.yaml': '- { id: demo.push, disabled: true, reason: noisy here }' }))
    assert.equal(fromUser.rules.length, 0)
    assert.equal(fromUser.all.length, 1)
    assert.ok(fromUser.issues.some(issue => issue.level === 'notice' && issue.message.includes('noisy here')))

    const fromLocal = await loadRules(setup({ 'base.yaml': BASE, 'project/.dsh-guard.local/l.yaml': '- { id: demo.push, disabled: true, reason: local test }' }))
    assert.equal(fromLocal.rules.length, 0)

    const fromProject = await loadRules(setup({ 'base.yaml': BASE, 'project/.dsh-guard/p.yaml': '- { id: demo.push, disabled: true, reason: repo says so }' }))
    assert.equal(fromProject.rules.length, 1)
    assert.ok(fromProject.issues.some(issue => issue.level === 'warning' && issue.message.includes('may not disable')))

    const noReason = await loadRules(setup({ 'base.yaml': BASE, 'user/u.yaml': '- { id: demo.push, disabled: true }' }))
    assert.equal(noReason.rules.length, 1)
    assert.ok(noReason.issues.some(issue => issue.level === 'error' && issue.message.includes('reason')))
  })

  it('appends override examples to the earlier ones', async () => {
    const set = await loadRules(setup({ 'base.yaml': BASE, 'user/u.yaml': '- { id: demo.push, action: ask, examples: { block: [git push origin main] } }' }))
    assert.deepEqual(set.rules[0].examples?.block, ['git push', 'git push origin main'])
  })

  it('loads layers in order bundled, user, project, local, extra', async () => {
    const options = setup({
      'base.yaml': BASE,
      'user/u.yaml': '- { id: a, action: warn, match: { command: a } }',
      'project/.dsh-guard/p.yaml': '- { id: a, action: ask }',
      'project/.dsh-guard.local/l.yaml': '- { id: a, action: block }',
    })
    const set = await loadRules(options)
    const rule = set.rules.find(r => r.id === 'a')
    assert.deepEqual(rule?.sources.map(source => source.layer), ['user', 'project', 'local'])
    assert.equal(rule?.action, 'block')
  })

  it('loads check hooks from trusted layers and refuses them from the project layer', async () => {
    const hook = 'export function long(call) { return (call.fields.command ?? "").length > 20 }\n'
    const trusted = await loadRules(setup({
      'base.yaml': BASE,
      'user/checks.mjs': hook,
      'user/u.yaml': '- { id: long.cmd, tool: shell, action: warn, check: ./checks.mjs:long }',
    }))
    assert.equal(typeof trusted.rules.find(r => r.id === 'long.cmd')?.checkFn, 'function')

    const project = await loadRules(setup({
      'base.yaml': BASE,
      'project/.dsh-guard/checks.mjs': hook,
      'project/.dsh-guard/p.yaml': '- { id: long.cmd, tool: shell, action: warn, check: ./checks.mjs:long }',
    }))
    assert.equal(project.rules.find(r => r.id === 'long.cmd'), undefined)
    assert.ok(project.issues.some(issue => issue.message.includes('may not name check hooks')))
  })
})
