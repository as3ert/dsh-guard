import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { FAKE_KEY, runHeadless } from './run-headless.ts'
import type { HeadlessRun } from './run-headless.ts'

describe('dsh headless with dsh-guard and a scripted model', { timeout: 300_000 }, () => {
  let run: HeadlessRun
  const results = (): Record<string, Record<string, unknown>> => Object.fromEntries(
    run.events.filter(event => event.type === 'tool_result').map(event => [event.callId as string, event]),
  )
  const seenByModel = (index: number): string => JSON.stringify(run.requests[index]?.messages ?? [])

  before(() => {
    run = runHeadless()
  })

  it('boots, runs the script and completes', () => {
    assert.equal(run.status, 0, run.stderr)
    const final = run.events.find(event => event.type === 'final')
    assert.deepEqual(final?.reason, { kind: 'completed' })
    assert.equal(run.requests.length, 5)
  })

  it('skips a blocked shell call and returns the denial to the model', () => {
    const blocked = results().call_0
    assert.equal(blocked.status, 'error')
    assert.deepEqual(blocked.error, { name: 'GuardError', code: 'GUARD_BLOCKED' })
    assert.match(blocked.result as string, /Blocked by dsh-guard: \[it\.block\]/)
    assert.ok(!(blocked.result as string).includes('dsh-guard-it-block-marker\n'), 'the command must not have run')
    assert.match(seenByModel(1), /Blocked by dsh-guard: \[it\.block\] integration block marker/)
  })

  it('adds warning context after the tool result', () => {
    assert.equal(results().call_1.status, 'completed')
    assert.ok(!seenByModel(1).includes('integration warn notes'))
    assert.match(seenByModel(2), /"source":\{"kind":"dsh-guard","form":"notice"/)
    assert.match(seenByModel(2), /dsh-guard warning \[it\.warn\]: integration warn notes/)
  })

  it('masks a fake secret in tool output before the model sees it', () => {
    const read = results().call_2
    assert.equal(read.status, 'completed')
    assert.match(read.result as string, /DEEPSEEK_API_KEY=\[REDACTED:secrets\.redact-output\]/)
    for (let index = 0; index < run.requests.length; index++) assert.ok(!seenByModel(index).includes(FAKE_KEY))
  })

  it('denies an ask when nobody can answer', () => {
    const asked = results().call_3
    assert.equal(asked.status, 'error')
    assert.deepEqual(asked.error, { name: 'ApprovalError', code: 'APPROVAL_UNAVAILABLE' })
    assert.ok(!(asked.result as string).includes('dsh-guard-it-ask-marker\n'))
  })

  it('logs every decision with the session directory', () => {
    const verdicts = run.log.map(record => `${record.rule}:${record.verdict}`)
    assert.deepEqual(verdicts, ['it.block:block', 'it.warn:warn', 'secrets.redact-output:redact', 'it.ask:ask', '-:ask-denied'])
    for (const record of run.log) assert.match(record.cwd as string, /workspace$/)
  })
})
