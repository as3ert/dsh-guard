/** Authoring: draft, test, replay, apply, promotion, rule on/off, stats and history. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { GuardAuthoring, approvalPrompt, promotionRequest } from '../src/authoring.ts'
import type { ApprovalAnswer, DraftRequest } from '../src/authoring.ts'
import { GuardCore } from '../src/core.ts'
import { sessionHistory } from '../src/history.ts'
import type { HistoricCall } from '../src/history.ts'
import { readLogStats } from '../src/stats.ts'
import { tempDir, writeTree } from './helpers.ts'

const PACK = `
rules:
  - id: base.push
    tool: shell
    match: { command: 'git push' }
    action: ask
    override: true
    message: pushing
    examples: { block: [git push], pass: [git status] }
`

const NEW_RULE = {
  id: 'team.npm-publish',
  tool: 'shell',
  match: { command: '\\bnpm\\s+publish\\b' },
  action: 'block',
  message: 'Publishing goes through CI.',
  examples: { block: ['npm publish', 'npm publish --tag next'], pass: ['npm pack', 'npm run publish-docs'] },
}

function setup(files: Record<string, string> = {}) {
  const root = tempDir()
  writeTree(root, { 'pack.yaml': PACK, 'project/.keep': '', ...files })
  const cwd = join(root, 'project')
  const logPath = join(root, 'log.jsonl')
  const core = new GuardCore({ packs: [join(root, 'pack.yaml')], userDir: join(root, 'user'), logPath, cwd, dshHome: join(root, 'dsh-home'), reloadIntervalMs: 0 })
  return { root, cwd, core, logPath, authoring: new GuardAuthoring(core) }
}

const call = (command: string, time: number, sessionId = 's1'): HistoricCall => ({ tool: 'bash', input: { command }, sessionId, callId: `c${time}`, time })
const history = (calls: HistoricCall[]) => async (limit: number) => ({ calls: calls.slice(0, limit), sessions: 1 })
const answer = (value: ApprovalAnswer, seen: string[] = []) => async (prompt: string) => {
  seen.push(prompt)
  return value
}

describe('guard_draft', () => {
  it('normalizes a new rule into observe mode and writes nothing', async () => {
    const { authoring, cwd } = setup()
    const draft = await authoring.draft({ op: 'add', layer: 'project', rule: NEW_RULE }, cwd)
    assert.equal(draft.ok, true, draft.problems.join('; '))
    assert.equal(draft.entry?.action, 'warn')
    assert.equal(draft.entry?.promote_to, 'block')
    assert.equal(draft.effective?.action, 'warn')
    assert.match(draft.file.replace(/\\/g, '/'), /project\/\.dsh-guard\/rules\.yaml$/)
    assert.equal(existsSync(draft.file), false)
  })

  it('keeps the drafted action in enforce mode', async () => {
    const { authoring, cwd } = setup()
    const draft = await authoring.draft({ op: 'add', layer: 'user', rule: NEW_RULE, mode: 'enforce' }, cwd)
    assert.equal(draft.ok, true)
    assert.equal(draft.effective?.action, 'block')
    assert.equal(draft.effective?.promote_to, undefined)
  })

  const refusals: [string, DraftRequest, RegExp][] = [
    ['an existing id', { op: 'add', layer: 'user', rule: { ...NEW_RULE, id: 'base.push' } }, /already exists/],
    ['a schema error', { op: 'add', layer: 'user', rule: { ...NEW_RULE, colour: 'red' } }, /unknown field `colour`/],
    ['a bad regex', { op: 'add', layer: 'user', rule: { ...NEW_RULE, match: { command: '(' } } }, /match\.command/],
    ['a check hook', { op: 'add', layer: 'user', rule: { ...NEW_RULE, check: './x.mjs:f' } }, /check/],
    ['a reserved id', { op: 'add', layer: 'user', rule: { ...NEW_RULE, id: 'dsh-guard.mine' } }, /built-in/],
    ['a scope change of a lower-layer rule', { op: 'modify', layer: 'user', rule: { id: 'base.push', match: { command: 'git' } } }, /cannot change/],
    ['a loosened action', { op: 'modify', layer: 'user', rule: { id: 'base.push', action: 'warn' } }, /loosens action ask to warn/],
    ['a project-layer disable', { op: 'remove', layer: 'project', id: 'base.push', reason: 'noisy' }, /project layer may not disable/],
    ['a disable without reason', { op: 'remove', layer: 'user', id: 'base.push' }, /needs a `reason`/],
    ['a missing rule', { op: 'remove', layer: 'user', id: 'nope' }, /no rule with id/],
    ['the built-in rule', { op: 'remove', layer: 'user', id: 'dsh-guard.self-protect', reason: 'x' }, /built-in/],
  ]
  for (const [name, request, pattern] of refusals) {
    it(`refuses ${name}`, async () => {
      const { authoring, cwd } = setup()
      const draft = await authoring.draft(request, cwd)
      assert.equal(draft.ok, false)
      assert.match(draft.problems.join('\n'), pattern)
    })
  }

  it('accepts a tightening override of a lower-layer rule', async () => {
    const { authoring, cwd } = setup()
    const draft = await authoring.draft({ op: 'modify', layer: 'project', rule: { id: 'base.push', action: 'block' } }, cwd)
    assert.equal(draft.ok, true, draft.problems.join('; '))
    assert.equal(draft.effective?.action, 'block')
    assert.deepEqual(draft.entry, { id: 'base.push', action: 'block' })
  })

  it('writes a disable entry when the user layer removes a pack rule', async () => {
    const { authoring, cwd } = setup()
    const draft = await authoring.draft({ op: 'remove', layer: 'user', id: 'base.push', reason: 'pushes are fine here' }, cwd)
    assert.equal(draft.ok, true, draft.problems.join('; '))
    assert.deepEqual(draft.entry, { id: 'base.push', disabled: true, reason: 'pushes are fine here' })
  })
})

describe('guard_test', () => {
  it('passes good examples and reports failing ones', async () => {
    const { authoring, cwd } = setup()
    const good = authoring.test(await authoring.draft({ op: 'add', layer: 'user', rule: NEW_RULE }, cwd))
    assert.equal(good.ok, true)
    assert.equal(good.passed, 4)
    const bad = authoring.test(await authoring.draft({ op: 'add', layer: 'user', rule: { ...NEW_RULE, examples: { block: ['npm pack'], pass: ['npm publish'] } } }, cwd))
    assert.equal(bad.ok, false)
    assert.equal(bad.failures.length, 2)
  })

  it('requires block and pass examples on a new rule', async () => {
    const { authoring, cwd } = setup()
    const test = authoring.test(await authoring.draft({ op: 'add', layer: 'user', rule: { ...NEW_RULE, examples: { block: ['npm publish'] } } }, cwd))
    assert.equal(test.ok, false)
    assert.match(test.problems.join('\n'), /examples\.pass/)
  })
})

describe('guard_replay', () => {
  it('counts the past calls a new rule would hit, newest first', async () => {
    const { authoring, cwd } = setup()
    const draft = await authoring.draft({ op: 'add', layer: 'user', rule: NEW_RULE }, cwd)
    const replay = authoring.replay(draft, await history([call('npm publish', 3), call('npm pack', 2), call('npm publish --dry-run', 1)])(500))
    assert.equal(replay.scanned, 3)
    assert.equal(replay.firing, 2)
    assert.equal(replay.newlyFiring, 2)
    assert.equal(replay.action, 'block')
    assert.deepEqual(replay.samples.map(sample => sample.time), [3, 1])
  })

  it('shows calls that a change stops or starts hitting', async () => {
    const { authoring, cwd } = setup()
    const draft = await authoring.draft({ op: 'remove', layer: 'user', id: 'base.push', reason: 'fine' }, cwd)
    const replay = authoring.replay(draft, { calls: [call('git push origin main', 2), call('ls', 1)], sessions: 1 })
    assert.equal(replay.noLongerFiring, 1)
    assert.equal(replay.firing, 0)
  })

  it('caps the replay at 500 calls', async () => {
    const { authoring, cwd } = setup()
    const draft = await authoring.draft({ op: 'add', layer: 'user', rule: NEW_RULE }, cwd)
    const calls = Array.from({ length: 700 }, (_, index) => call('npm publish', 700 - index))
    const replay = authoring.replay(draft, { calls, sessions: 1 })
    assert.equal(replay.scanned, 500)
    assert.equal(replay.firing, 500)
    assert.equal(replay.samples.length, 20)
  })
})

describe('guard_apply', () => {
  it('writes nothing when the approval is rejected or unavailable', async () => {
    const { authoring, cwd } = setup()
    for (const outcome of ['rejected', 'unavailable'] as const) {
      const result = await authoring.apply({ op: 'add', layer: 'project', rule: NEW_RULE }, cwd, history([]), answer(outcome))
      assert.equal(result.applied, false)
      assert.equal(result.outcome, outcome)
      assert.equal(existsSync(join(cwd, '.dsh-guard', 'rules.yaml')), false)
    }
  })

  it('refuses before asking when examples fail', async () => {
    const { authoring, cwd } = setup()
    const seen: string[] = []
    const result = await authoring.apply({ op: 'add', layer: 'project', rule: { ...NEW_RULE, examples: { block: ['npm pack'], pass: ['ls'] } } }, cwd, history([]), answer('allowed-once', seen))
    assert.equal(result.outcome, 'refused')
    assert.equal(seen.length, 0)
  })

  it('shows rule, examples and replay hits in the prompt, then writes the rule in observe mode', async () => {
    const { authoring, core, cwd } = setup()
    const seen: string[] = []
    const result = await authoring.apply({ op: 'add', layer: 'project', rule: NEW_RULE }, cwd, history([call('npm publish', 5)]), answer('allowed-once', seen))
    assert.equal(result.applied, true, result.message)
    assert.match(seen[0], /Add rule team\.npm-publish in the project layer/)
    assert.match(seen[0], /Mode: OBSERVE/)
    assert.match(seen[0], /promote_to: block/)
    assert.match(seen[0], /Examples: 4 passed, 0 failed/)
    assert.match(seen[0], /would fire on 1 call\(s\) as block/)
    assert.match(seen[0], /\[new\] .* bash: npm publish/)
    const text = readFileSync(join(cwd, '.dsh-guard', 'rules.yaml'), 'utf8')
    assert.match(text, /action: warn/)
    assert.match(text, /promote_to: block/)
    // The running core sees the new rule at once: a matching call now warns.
    const outcome = await core.pre({ tool: 'bash', input: { command: 'npm publish' }, cwd })
    assert.equal(outcome.kind, 'allow')
    assert.match(outcome.warnings.join('\n'), /observe \[team\.npm-publish\]: this call was allowed.*: Publishing goes through CI/)
  })

  it('keeps comments and other rules of an existing file', async () => {
    const { authoring, cwd } = setup({ 'project/.dsh-guard.local/rules.yaml': '# my local rules\nrules:\n  - id: mine.x\n    tool: shell\n    match: { command: xyz }\n    action: warn\n' })
    const result = await authoring.apply({ op: 'add', layer: 'local', rule: NEW_RULE, mode: 'enforce' }, cwd, history([]), answer('allowed-once'))
    assert.equal(result.applied, true, result.message)
    const text = readFileSync(join(cwd, '.dsh-guard.local', 'rules.yaml'), 'utf8')
    assert.match(text, /^# my local rules/)
    assert.match(text, /id: mine\.x/)
    assert.match(text, /action: block/)
  })

  it('promotes an observe-mode rule, then removes it', async () => {
    const { authoring, cwd } = setup()
    await authoring.apply({ op: 'add', layer: 'user', rule: NEW_RULE }, cwd, history([]), answer('allowed-once'))
    const observed = (await authoring.load(cwd)).rules.find(rule => rule.id === NEW_RULE.id)
    assert.ok(observed !== undefined)
    const promote = promotionRequest(observed)
    assert.deepEqual(promote, { op: 'modify', layer: 'user', rule: { id: NEW_RULE.id, action: 'block' } })
    const promoted = await authoring.apply(promote, cwd, history([]), answer('allowed-once'))
    assert.equal(promoted.applied, true, promoted.message)
    const rule = (await authoring.load(cwd)).rules.find(item => item.id === NEW_RULE.id)
    assert.equal(rule?.action, 'block')
    assert.equal(rule?.promote_to, undefined)
    const removed = await authoring.apply({ op: 'remove', layer: 'user', id: NEW_RULE.id }, cwd, history([]), answer('allowed-once'))
    assert.equal(removed.applied, true, removed.message)
    assert.equal((await authoring.load(cwd)).all.some(item => item.id === NEW_RULE.id), false)
  })

  it('does not write when the file changed while the approval was open', async () => {
    const { authoring, cwd } = setup()
    const file = join(cwd, '.dsh-guard', 'rules.yaml')
    const result = await authoring.apply({ op: 'add', layer: 'project', rule: NEW_RULE }, cwd, history([]), async () => {
      writeTree(cwd, { '.dsh-guard/rules.yaml': 'rules: []\n' })
      return 'allowed-once'
    })
    assert.equal(result.outcome, 'failed')
    assert.equal(readFileSync(file, 'utf8'), 'rules: []\n')
  })

  it('logs the change', async () => {
    const { authoring, core, cwd, logPath } = setup()
    await authoring.apply({ op: 'add', layer: 'user', rule: NEW_RULE }, cwd, history([]), answer('allowed-once'))
    await core.log.flush()
    assert.match(readFileSync(logPath, 'utf8'), /"rule":"team\.npm-publish","verdict":"authoring-add","tool":"guard_apply"/)
  })

  it('builds a prompt for removals', async () => {
    const { authoring, cwd } = setup()
    const draft = await authoring.draft({ op: 'remove', layer: 'user', id: 'base.push', reason: 'fine' }, cwd)
    const prompt = approvalPrompt(draft, authoring.test(draft), authoring.replay(draft, { calls: [], sessions: 0 }))
    assert.match(prompt, /Disable rule base\.push in the user layer/)
  })
})

describe('switching a rule off and on', () => {
  it('disables a pack rule from the user layer and enables it again through apply', async () => {
    const { authoring, cwd } = setup()
    const enabled = async () => (await authoring.load(cwd)).all.find(rule => rule.id === 'base.push')?.disabled !== true
    const seen: string[] = []
    const off = await authoring.apply({ op: 'modify', layer: 'user', rule: { id: 'base.push', disabled: true, reason: 'not needed here' } }, cwd, history([]), answer('allowed-once', seen))
    assert.equal(off.applied, true, off.message)
    assert.match(seen[0], /Change rule base\.push/)
    assert.equal(await enabled(), false)
    const on = await authoring.apply({ op: 'modify', layer: 'user', rule: { id: 'base.push', disabled: false } }, cwd, history([]), answer('allowed-once'))
    assert.equal(on.applied, true, on.message)
    assert.equal(await enabled(), true)
  })
})

describe('log stats', () => {
  it('counts verdicts and keeps overridden calls as false-positive candidates', () => {
    const dir = tempDir()
    const path = join(dir, 'log.jsonl')
    writeFileSync(path, [
      { time: 't1', rule: 'r', verdict: 'warn', summary: 'a' },
      { time: 't2', rule: 'r', verdict: 'override', summary: 'b # guard: allow ok', reason: 'ok' },
      { time: 't3', rule: '-', verdict: 'ask-denied' },
      'not json',
    ].map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n'))
    const stats = readLogStats(path)
    assert.equal(stats.get('r')?.hits, 1)
    assert.equal(stats.get('r')?.overrides, 1)
    assert.equal(stats.get('r')?.falsePositives[0].reason, 'ok')
    assert.equal(stats.has('-'), false)
    assert.equal(readLogStats(join(dir, 'missing.jsonl')).size, 0)
  })
})

describe('session history', () => {
  it('reads tool calls with their results, newest first, up to the limit', async () => {
    const query = {
      async listSessions() {
        return [{ header: { id: 'new', cwd: '/w' } }, { header: { id: 'old' } }]
      },
      async readSession(id: string) {
        const events = id === 'new'
          ? [
              { type: 'tool/call', time: 30, data: { callId: 'a', name: 'bash', arguments: '{"command":"ls"}' } },
              { type: 'tool/result', time: 31, data: { message: { toolCallId: 'a', content: [{ type: 'text', text: 'out' }] } } },
              { type: 'tool/call', time: 40, data: { callId: 'b', name: 'read', arguments: '{"file_path":"x"}' } },
            ]
          : [{ type: 'tool/call', time: 10, data: { callId: 'c', name: 'bash', arguments: 'not json' } }]
        return { session: id === 'new' ? { cwd: '/w' } : {}, events }
      },
    }
    const all = await sessionHistory(query)(500)
    assert.deepEqual(all.calls.map(item => item.callId), ['b', 'a', 'c'])
    assert.equal(all.calls[1].output, 'out')
    assert.equal(all.calls[1].cwd, '/w')
    assert.deepEqual(all.calls[2].input, { arguments: 'not json' })
    assert.equal(all.sessions, 2)
    const two = await sessionHistory(query)(2)
    assert.equal(two.calls.length, 2)
    assert.equal(two.sessions, 1)
  })
})

describe('dsh-guard stats', () => {
  it('lists observe-mode rules with would-have counts and false-positive candidates, and never writes', async () => {
    const { spawnSync } = await import('node:child_process')
    const root = tempDir()
    const rule = 'rules:\n  - id: obs.publish\n    tool: shell\n    match: { command: publish }\n    action: warn\n    promote_to: block\n    override: true\n  - id: obs.quiet\n    tool: shell\n    match: { command: never-seen }\n    action: warn\n    promote_to: ask\n'
    writeTree(root, { 'user/rules.yaml': rule, 'project/.keep': '' })
    const log = join(root, 'log.jsonl')
    writeFileSync(log, [
      { time: 't1', rule: 'obs.publish', verdict: 'warn', summary: 'npm publish' },
      { time: 't2', rule: 'obs.publish', verdict: 'warn', summary: 'npm publish --tag x' },
      { time: 't3', rule: 'obs.publish', verdict: 'override', summary: 'npm publish # guard: allow release', reason: 'release' },
    ].map(item => JSON.stringify(item)).join('\n'))
    const cli = join(import.meta.dirname, '..', 'src', 'cli.ts')
    const out = spawnSync(process.execPath, [cli, 'stats', '--packs', '', '--user-dir', join(root, 'user'), '--cwd', join(root, 'project'), '--log', log], { encoding: 'utf8' })
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /obs\.publish .*\n\s+would have blocked 2 call\(s\); false-positive candidates \(overridden calls\): 1/)
    assert.match(out.stdout, /t3 npm publish # guard: allow release \(reason: release\)/)
    assert.match(out.stdout, /review the overridden calls/)
    assert.match(out.stdout, /obs\.quiet .*\n\s+would have asked on 0 call\(s\)/)
    assert.match(out.stdout, /dsh-guard stats: 2 observe-mode rules/)
    assert.equal(readFileSync(join(root, 'user', 'rules.yaml'), 'utf8'), rule)
  })
})
