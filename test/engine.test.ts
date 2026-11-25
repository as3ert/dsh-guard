import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { GuardCore } from '../src/core.ts'
import { evaluate, overrideReason, redact } from '../src/engine.ts'
import { runExamples } from '../src/examples.ts'
import { loadRules } from '../src/loader.ts'
import { viewOf } from '../src/tools.ts'
import type { RuleSet } from '../src/types.ts'
import { tempDir, writeTree } from './helpers.ts'

async function rulesFrom(yaml: string): Promise<RuleSet> {
  const root = tempDir()
  writeTree(root, { 'r.yaml': yaml })
  const set = await loadRules({ cwd: root, packs: [join(root, 'r.yaml')], userDir: null })
  assert.equal(set.issues.filter(issue => issue.level === 'error').length, 0, JSON.stringify(set.issues))
  return set
}

describe('tool mapping', () => {
  it('maps raw dsh tools onto canonical names and fields', () => {
    assert.equal(viewOf({ tool: 'pwsh', input: { command: 'dir' } }).canonical, 'shell')
    assert.equal(viewOf({ tool: 'bash', input: { command: 'ls' } }).fields.command, 'ls')
    const create = viewOf({ tool: 'str_replace_editor', input: { command: 'create', path: 'C:\\x\\a.txt', file_text: 'hi' } })
    assert.equal(create.canonical, 'write')
    assert.equal(create.fields.path, 'C:/x/a.txt')
    assert.equal(create.fields.content, 'hi')
    const edit = viewOf({ tool: 'edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } })
    assert.deepEqual([edit.canonical, edit.fields.old, edit.fields.new], ['edit', 'a', 'b'])
    const patch = viewOf({ tool: 'apply_patch', input: { input: '*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: b.ts\n*** End Patch' } })
    assert.equal(patch.fields.path, 'src/a.ts\nb.ts')
    assert.equal(viewOf({ tool: 'web_search', input: { queries: ['a', 'b'] } }).fields.query, 'a\nb')
    assert.equal(viewOf({ tool: 'mcp_x', input: {} }).canonical, 'mcp_x')
  })
})

describe('matcher', () => {
  it('requires every positive field and no negative field', async () => {
    const set = await rulesFrom(`
- id: env
  tool: read
  match: { path: '\\.env', not_path: 'example' }
  action: ask
`)
    assert.equal(evaluate(set.rules, { tool: 'read', input: { file_path: '.env' } }, 'pre_tool').action, 'ask')
    assert.equal(evaluate(set.rules, { tool: 'read', input: { file_path: '.env.example' } }, 'pre_tool').action, undefined)
    assert.equal(evaluate(set.rules, { tool: 'bash', input: { command: 'cat .env' } }, 'pre_tool').action, undefined)
  })

  it('supports a leading (?i) and lists of patterns', async () => {
    const set = await rulesFrom(`
- { id: ci, tool: shell, match: { command: ['(?i)drop table', 'truncate'] }, action: block }
`)
    assert.equal(evaluate(set.rules, { tool: 'bash', input: { command: 'psql -c "DROP TABLE x"' } }, 'pre_tool').action, 'block')
    assert.equal(evaluate(set.rules, { tool: 'bash', input: { command: 'truncate -s 0 f' } }, 'pre_tool').action, 'block')
  })

  it('matches any call of the tool when match is empty, and picks the strongest action', async () => {
    const set = await rulesFrom(`
- { id: fetch-warn, tool: fetch, action: warn }
- { id: fetch-ask, tool: web_fetch, match: { url: 'internal' }, action: ask }
`)
    const verdict = evaluate(set.rules, { tool: 'web_fetch', input: { url: 'http://internal/x' } }, 'pre_tool')
    assert.equal(verdict.action, 'ask')
    assert.deepEqual(verdict.hits.map(hit => hit.rule.id), ['fetch-warn', 'fetch-ask'])
  })

  it('checks head and tail of an oversized field and reports truncation', async () => {
    const set = await rulesFrom('- { id: tail, tool: shell, match: { command: SECRET }, action: block }')
    const command = `${'x'.repeat(500)} SECRET`
    const verdict = evaluate(set.rules, { tool: 'bash', input: { command } }, 'pre_tool', { maxFieldChars: 100 })
    assert.equal(verdict.action, 'block')
    assert.equal(verdict.truncated, true)
  })

  it('runs a check hook', async () => {
    const root = tempDir()
    writeTree(root, {
      'hook.mjs': 'export function many(call) { const n = (call.fields.command.match(/&&/g) ?? []).length; return n > 2 ? { hit: true, message: `${n} chained commands` } : false }',
      'r.yaml': '- { id: chain, tool: shell, action: warn, check: ./hook.mjs:many }',
    })
    const set = await loadRules({ cwd: root, packs: [join(root, 'r.yaml')], userDir: null })
    const verdict = evaluate(set.rules, { tool: 'bash', input: { command: 'a && b && c && d' } }, 'pre_tool')
    assert.equal(verdict.hits[0]?.message, '3 chained commands')
    assert.equal(evaluate(set.rules, { tool: 'bash', input: { command: 'a && b' } }, 'pre_tool').action, undefined)
  })
})

describe('override comment', () => {
  it('parses the reason', () => {
    assert.equal(overrideReason('git push -f # guard: allow user asked'), 'user asked')
    assert.equal(overrideReason('git push -f # guard: allow'), undefined)
    assert.equal(overrideReason('git push -f'), undefined)
  })

  it('lets an overridable rule pass and keeps a non-overridable one', async () => {
    const set = await rulesFrom(`
- { id: soft, tool: shell, match: { command: push }, action: block, override: true }
- { id: hard, tool: shell, match: { command: 'rm -rf /' }, action: block }
`)
    const soft = evaluate(set.rules, { tool: 'bash', input: { command: 'git push -f # guard: allow requested' } }, 'pre_tool')
    assert.equal(soft.action, undefined)
    assert.equal(soft.overridden[0]?.overrideReason, 'requested')
    const hard = evaluate(set.rules, { tool: 'bash', input: { command: 'rm -rf / # guard: allow please' } }, 'pre_tool')
    assert.equal(hard.action, 'block')
  })
})

describe('redact', () => {
  it('masks every match', async () => {
    const set = await rulesFrom(`
- { id: key, when: post_tool, action: redact, match: { output: 'sk-[a-z0-9]{8,}' } }
`)
    const verdict = evaluate(set.rules, { tool: 'bash', input: {}, output: 'a sk-abcdefgh1 b sk-zzzzzzzz2' }, 'post_tool')
    const masked = redact('a sk-abcdefgh1 b sk-zzzzzzzz2', verdict.hits)
    assert.equal(masked.text, 'a [REDACTED:key] b [REDACTED:key]')
    assert.equal(masked.count, 2)
  })
})

describe('examples', () => {
  it('reports examples that do not behave as declared', async () => {
    const set = await rulesFrom(`
- id: ex
  tool: shell
  match: { command: deploy }
  action: ask
  examples: { block: [deploy prod, build], pass: [test, deploy staging] }
`)
    const result = runExamples(set.rules[0])
    assert.equal(result.passed, 2)
    assert.deepEqual(result.failures.map(failure => `${failure.kind}:${failure.example}`), ['block:build', 'pass:deploy staging'])
  })
})

describe('GuardCore actions', () => {
  const yaml = `
- { id: b, tool: shell, match: { command: 'rm -rf' }, action: block, message: no deletes }
- { id: a, tool: shell, match: { command: deploy }, action: ask, message: confirm deploy }
- { id: w, tool: shell, match: { command: 'npm publish' }, action: warn, message: check the version }
- { id: r, when: post_tool, action: redact, match: { output: 'sk-[a-z0-9]{8,}' } }
- { id: pb, when: post_tool, tool: read, action: block, match: { output: 'BEGIN PRIVATE' }, message: private key in output }
`
  async function core(extra: Partial<ConstructorParameters<typeof GuardCore>[0]> = {}): Promise<{ core: GuardCore, log: string }> {
    const root = tempDir()
    writeTree(root, { 'r.yaml': yaml })
    const log = join(root, 'log.jsonl')
    return { core: new GuardCore({ packs: [join(root, 'r.yaml')], userDir: '', cwd: root, logPath: log, ...extra }), log }
  }

  it('denies, asks, warns and allows', async () => {
    const { core: guard, log } = await core()
    const deny = await guard.pre({ tool: 'bash', input: { command: 'rm -rf build' } })
    assert.equal(deny.kind, 'deny')
    assert.match(deny.reason ?? '', /\[b\] no deletes/)
    assert.equal((await guard.pre({ tool: 'bash', input: { command: './deploy.sh' } })).kind, 'ask')
    const warn = await guard.pre({ tool: 'bash', input: { command: 'npm publish' } })
    assert.equal(warn.kind, 'allow')
    assert.deepEqual(warn.warnings, ['dsh-guard warning [w]: check the version'])
    assert.equal((await guard.pre({ tool: 'bash', input: { command: 'ls' } })).kind, 'allow')
    assert.match(guard.guardSync({ tool: 'bash', input: { command: 'rm -rf x' } }) ?? '', /no deletes/)
    assert.equal(guard.guardSync({ tool: 'bash', input: { command: './deploy.sh' } }), undefined)
    await guard.log.flush()
    const records = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(records.map(record => `${record.rule}:${record.verdict}`), ['b:block', 'a:ask', 'w:warn'])
    assert.equal(records[0].tool, 'bash')
    assert.equal(records[0].summary, 'rm -rf build')
    assert.ok(typeof records[0].time === 'string' && typeof records[0].cwd === 'string')
  })

  it('redacts and blocks results', async () => {
    const { core: guard } = await core()
    const post = await guard.post({ tool: 'bash', input: { command: 'env' }, output: 'KEY=sk-abcdefgh123' })
    assert.equal(post.kind, 'accept')
    assert.equal(guard.redactText('KEY=sk-abcdefgh123', post.redactHits), 'KEY=[REDACTED:r]')
    const blocked = await guard.post({ tool: 'read', input: { file_path: 'k.pem' }, output: '-----BEGIN PRIVATE KEY-----' })
    assert.equal(blocked.kind, 'block')
  })

  it('fails open or closed on an exhausted budget', async () => {
    const open = (await core({ timeBudgetMs: -1 })).core
    assert.equal((await open.pre({ tool: 'bash', input: { command: 'rm -rf x' } })).kind, 'allow')
    const closed = (await core({ timeBudgetMs: -1, failMode: 'closed' })).core
    const outcome = await closed.pre({ tool: 'bash', input: { command: 'ls' } })
    assert.equal(outcome.kind, 'deny')
    assert.match(outcome.reason ?? '', /time budget/)
  })

  it('reloads rules when a file changes', async () => {
    const root = tempDir()
    writeTree(root, { 'project/.dsh-guard/p.yaml': '- { id: x, tool: shell, match: { command: foo }, action: warn }' })
    const guard = new GuardCore({ packs: [], userDir: '', cwd: join(root, 'project'), logPath: '', reloadIntervalMs: 1 })
    assert.equal((await guard.pre({ tool: 'bash', input: { command: 'foo' }, cwd: join(root, 'project') })).warnings.length, 1)
    await new Promise(done => setTimeout(done, 20))
    writeTree(root, { 'project/.dsh-guard/p.yaml': '- { id: x, tool: shell, match: { command: foo }, action: block }' })
    await new Promise(done => setTimeout(done, 20))
    assert.equal((await guard.pre({ tool: 'bash', input: { command: 'foo' }, cwd: join(root, 'project') })).kind, 'deny')
  })
})
