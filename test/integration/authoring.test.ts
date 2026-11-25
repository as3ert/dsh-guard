import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'
import { NO_RULES, runHeadless } from './run-headless.ts'
import type { HeadlessRun } from './run-headless.ts'

/**
 * Full authoring flow in real dsh headless, starting from a fresh install
 * with no rules at all: an ordinary call passes, guard_list says no rules
 * exist yet, the scripted model drafts, tests, replays and applies the first
 * rule; a scripted answerer approves the prompt; the rule is written in
 * observe mode and the next matching call warns; generic tools cannot touch
 * the rule files; a second rule applied in enforce mode asks, and the ask is
 * answered allowed-once.
 */
describe('dsh headless: conversational rule authoring', { timeout: 300_000 }, () => {
  let run: HeadlessRun
  const results = (): Record<string, Record<string, unknown>> => Object.fromEntries(
    run.events.filter(event => event.type === 'tool_result').map(event => [event.callId as string, event]),
  )
  const resultText = (callId: string): string => String(results()[callId]?.result ?? '')
  const seenByModel = (index: number): string => JSON.stringify(run.requests[index]?.messages ?? [])

  before(() => {
    run = runHeadless({ script: 'authoring', approver: true, rules: NO_RULES })
  })

  it('boots with the guard tools and the authoring guidance, and completes', () => {
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(run.events.find(event => event.type === 'final')?.reason, { kind: 'completed' })
    assert.equal(run.requests.length, 12)
    for (const tool of ['guard_list', 'guard_draft', 'guard_test', 'guard_replay', 'guard_apply']) assert.ok(run.requests[0].tools.includes(tool), tool)
    assert.match(seenByModel(0), /Guard rules \(dsh-guard\)/)
    assert.match(seenByModel(0), /never try to write rule files any other way/)
  })

  it('passes an ordinary call while no rules exist', () => {
    assert.equal(results().call_0.status, 'completed')
    assert.match(resultText('call_0'), /dsh-guard-it-observe-marker\s+first/)
  })

  it('lists no rules yet and points the user to describing them in the conversation', () => {
    assert.match(resultText('call_1'), /^No guard rules exist yet/)
    assert.match(resultText('call_1'), /describe in this conversation what should be guarded/)
    assert.match(resultText('call_1'), /dsh-guard\.self-protect \| builtin/)
  })

  it('drafts, tests and replays the first rule without writing', () => {
    assert.match(resultText('call_2'), /Draft add it\.observe in the project layer .*: OK/)
    assert.match(resultText('call_3'), /Examples: 2 passed, 0 failed/)
    const replay = resultText('call_4')
    assert.match(replay, /Replay over the newest \d+ tool calls from 1 session\(s\)/)
    assert.match(replay, /would fire on 1 call\(s\) as block/)
    assert.match(replay, /\[new\] .*: echo dsh-guard-it-observe-marker first/)
  })

  it('asks for approval with the rule, the examples result and the replay hits, then writes the rule in warn mode', () => {
    const prompt = run.approvals.find(item => item.toolName === 'guard_apply')
    assert.equal(prompt?.callId, 'call_5')
    assert.match(prompt?.reason ?? '', /Add rule it\.observe in the project layer/)
    assert.match(prompt?.reason ?? '', /Mode: OBSERVE/)
    assert.match(prompt?.reason ?? '', /Examples: 2 passed, 0 failed/)
    assert.match(prompt?.reason ?? '', /\[new\] .*: echo dsh-guard-it-observe-marker first/)
    assert.match(resultText('call_5'), /Rule it\.observe added; in force as action warn \(observe mode, promote_to block\)/)
    const file = readFileSync(join(run.workspace, '.dsh-guard', 'rules.yaml'), 'utf8')
    assert.match(file, /id: it\.observe/)
    assert.match(file, /action: warn/)
    assert.match(file, /promote_to: block/)
  })

  it('warns on a matching call once the rule is written', () => {
    assert.equal(results().call_6.status, 'completed')
    assert.match(seenByModel(7), /dsh-guard warning \[it\.observe\]: integration observe marker/)
    assert.ok(!seenByModel(6).includes('dsh-guard warning [it.observe]'))
  })

  it('blocks generic tools from writing or deleting the rule files', () => {
    for (const callId of ['call_7', 'call_8']) {
      const result = results()[callId]
      assert.equal(result.status, 'error', callId)
      assert.deepEqual(result.error, { name: 'GuardError', code: 'GUARD_BLOCKED' })
      assert.match(String(result.result), /\[dsh-guard\.self-protect\]/)
    }
    assert.match(readFileSync(join(run.workspace, '.dsh-guard', 'rules.yaml'), 'utf8'), /id: it\.observe/)
  })

  it('applies a second rule in enforce mode and runs its ask when answered allowed-once', () => {
    assert.match(resultText('call_9'), /Rule it\.ask added; in force as action ask/)
    assert.match(run.approvals.find(item => item.callId === 'call_9')?.reason ?? '', /Mode: ENFORCE/)
    assert.equal(results().call_10.status, 'completed')
    assert.match(resultText('call_10'), /dsh-guard-it-ask-marker/)
    const asked = run.approvals.find(item => item.callId === 'call_10')
    assert.match(asked?.reason ?? '', /dsh-guard asks for confirmation: \[it\.ask\]/)
  })

  it('logs the change and every decision', () => {
    assert.deepEqual(run.log.map(record => `${record.rule}:${record.verdict}`), [
      'it.observe:authoring-add', 'it.observe:warn', 'dsh-guard.self-protect:block', 'dsh-guard.self-protect:block', 'it.ask:authoring-add', 'it.ask:ask', '-:ask-allowed',
    ])
  })
})
