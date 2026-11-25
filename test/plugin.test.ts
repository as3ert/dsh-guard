/** Plugin wiring against a stub Cordis context: listener order, guard fallback, fail modes. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { apply } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { tempDir, writeTree } from './helpers.ts'

type Listener = (...args: any[]) => Promise<any>

function stubContext() {
  const listeners: Record<string, { fn: Listener, prepend: boolean }[]> = {}
  const guards: ((exec: object) => unknown)[] = []
  const warnings: string[] = []
  const ctx = {
    on(name: string, fn: Listener, options?: boolean | { prepend?: boolean }) {
      const prepend = typeof options === 'boolean' ? options : options?.prepend === true;
      (listeners[name] ??= []).push({ fn, prepend })
      return () => true
    },
    tools: { guard(fn: (exec: object) => unknown) { guards.push(fn); return () => {} } },
    logger: { warn(message: string) { warnings.push(message) }, info() {} },
    effect() {},
    get() { return undefined },
  }
  return { ctx, listeners, guards, warnings }
}

const RULES = `
- { id: b, tool: shell, match: { command: 'rm -rf' }, action: block, message: no deletes }
- { id: a, tool: shell, match: { command: deploy }, action: ask, message: confirm deploy }
- { id: r, when: post_tool, action: redact, match: { output: 'sk-[a-z0-9]{8,}' } }
`

async function setup(config: Partial<Config> = {}) {
  const root = tempDir()
  writeTree(root, { 'r.yaml': RULES })
  const stub = stubContext()
  apply(stub.ctx as never, { packs: [join(root, 'r.yaml')], userDir: '', logPath: '', cwd: root, ...config })
  // let the initial rule load settle
  await new Promise(done => setTimeout(done, 50))
  const pre = stub.listeners['tools/pre-execute'][0]
  const post = stub.listeners['tools/post-execute'][0]
  return { ...stub, pre, post, guard: stub.guards[0] }
}

const exec = (command: string) => ({ name: 'bash', arguments: { command }, callId: 'c1' })
const allow = () => Promise.resolve({ kind: 'allow' })

describe('plugin wiring', () => {
  it('registers a prepended pre-execute listener, a guard and a post-execute listener', async () => {
    const { pre, post, guard } = await setup()
    assert.equal(pre.prepend, true)
    assert.equal(typeof post.fn, 'function')
    assert.equal(typeof guard, 'function')
  })

  it('denies block hits before delegating and keeps the guard denying', async () => {
    const { pre, guard } = await setup()
    const call = exec('rm -rf build')
    let delegated = false
    const decision = await pre.fn(call, () => { delegated = true; return allow() })
    assert.equal(decision.kind, 'deny')
    assert.equal(delegated, false)
    // A listener ahead of ours that ignores the denial still meets the guard.
    assert.match((guard(call) as { reason: string }).reason, /no deletes/)
  })

  it('guards calls that pre-execute never saw', async () => {
    const { guard } = await setup()
    assert.match((guard(exec('rm -rf /tmp/x')) as { reason: string }).reason, /no deletes/)
    assert.equal(guard(exec('ls')), undefined)
  })

  it('asks after delegating, but keeps a downstream denial', async () => {
    const { pre } = await setup()
    assert.equal((await pre.fn(exec('deploy prod'), allow)).kind, 'ask')
    const denied = await pre.fn(exec('deploy prod'), () => Promise.resolve({ kind: 'deny', reason: 'sandbox' }))
    assert.deepEqual(denied, { kind: 'deny', reason: 'sandbox' })
  })

  it('redacts the downstream content', async () => {
    const { post } = await setup()
    const call = exec('env')
    const result = { isError: false, content: [{ type: 'text', text: 'KEY=sk-abcdefgh12' }] }
    const decision = await post.fn(call, result, () => Promise.resolve({ kind: 'accept' }))
    assert.deepEqual(decision, { kind: 'accept', content: [{ type: 'text', text: 'KEY=[REDACTED:r]' }] })
  })

  it('fails open or closed when evaluation throws', async () => {
    const open = await setup()
    const broken = { name: 'bash', get arguments(): never { throw new Error('boom') }, callId: 'c2' }
    assert.equal((await open.pre.fn(broken, allow)).kind, 'allow')
    assert.ok(open.warnings.some(message => message.includes('pre-execute failed')))
    const closed = await setup({ failMode: 'closed' })
    const decision = await closed.pre.fn(broken, allow)
    assert.equal(decision.kind, 'deny')
    assert.equal(decision.info.code, 'GUARD_INTERNAL_ERROR')
  })
})
