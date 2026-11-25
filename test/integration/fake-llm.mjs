/**
 * Scripted LLM adapter for the integration test. It answers every agent
 * request with the next tool call of a fixed script, then with a final text,
 * and records each request's messages to the file named by
 * DSH_GUARD_IT_RECORD. No network access.
 */
import { appendFileSync } from 'node:fs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-guard-fake-llm'
export const inject = ['llm']

const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'

const GUARD_SCRIPT = [
  { name: SHELL, args: { description: 'Guard block marker', command: 'echo dsh-guard-it-block-marker' } },
  { name: 'read', args: { file_path: 'notes.txt' } },
  { name: 'read', args: { file_path: 'secret.txt' } },
  { name: SHELL, args: { description: 'Guard ask marker', command: 'echo dsh-guard-it-ask-marker' } },
]

/** Rule the authoring script drafts, tests, replays and applies. */
const OBSERVE_RULE = {
  id: 'it.observe',
  tool: 'shell',
  match: { command: 'dsh-guard-it-observe-marker' },
  action: 'block',
  message: 'integration observe marker',
  examples: { block: ['echo dsh-guard-it-observe-marker'], pass: ['echo something else'] },
}
const CHANGE = { op: 'add', layer: 'project', rule: OBSERVE_RULE }

/** Second rule, applied in enforce mode, so the next marker call asks. */
const ASK_RULE = {
  id: 'it.ask',
  tool: 'shell',
  match: { command: 'dsh-guard-it-ask-marker' },
  action: 'ask',
  message: 'integration ask marker',
  examples: { block: ['echo dsh-guard-it-ask-marker'], pass: ['echo something else'] },
}

const AUTHORING_SCRIPT = [
  { name: SHELL, args: { description: 'Observe marker before the rule', command: 'echo dsh-guard-it-observe-marker first' } },
  { name: 'guard_list', args: {} },
  { name: 'guard_draft', args: CHANGE },
  { name: 'guard_test', args: CHANGE },
  { name: 'guard_replay', args: CHANGE },
  { name: 'guard_apply', args: CHANGE },
  { name: SHELL, args: { description: 'Observe marker after the rule', command: 'echo dsh-guard-it-observe-marker second' } },
  { name: 'write', args: { file_path: '.dsh-guard/rules.yaml', content: 'rules: []' } },
  { name: SHELL, args: { description: 'Delete guard rules', command: process.platform === 'win32' ? 'Remove-Item -Recurse -Force .dsh-guard' : 'rm -rf .dsh-guard' } },
  { name: 'guard_apply', args: { op: 'add', layer: 'project', rule: ASK_RULE, mode: 'enforce' } },
  { name: SHELL, args: { description: 'Guard ask marker', command: 'echo dsh-guard-it-ask-marker' } },
]

/** Used by the `dsh plugin add` check: the plugin is active and its tools are registered. */
const PROBE_SCRIPT = [
  { name: SHELL, args: { description: 'Delete guard rules', command: process.platform === 'win32' ? 'Remove-Item -Recurse -Force .dsh-guard' : 'rm -rf .dsh-guard' } },
  { name: 'guard_list', args: { layer: 'builtin' } },
]

const SCRIPTS = { guard: GUARD_SCRIPT, authoring: AUTHORING_SCRIPT, probe: PROBE_SCRIPT }
const SCRIPT = SCRIPTS[process.env.DSH_GUARD_IT_SCRIPT ?? 'guard'] ?? GUARD_SCRIPT

function toolCallsSoFar(messages) {
  let count = 0
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) if (block.type === 'tool-call') count += 1
  }
  return count
}

class ScriptedAdapter extends LlmAdapter {
  async * stream(options) {
    const record = process.env.DSH_GUARD_IT_RECORD
    if (record) appendFileSync(record, `${JSON.stringify({ purpose: options.purpose ?? null, tools: (options.tools ?? []).map(tool => tool.name), messages: options.messages })}\n`)
    const agentRequest = (options.tools ?? []).length > 0
    const step = agentRequest ? toolCallsSoFar(options.messages) : -1
    const call = SCRIPT[step]
    if (call !== undefined) {
      const id = `call_${step}`
      const args = JSON.stringify(call.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = agentRequest ? 'dsh-guard integration script finished' : 'Guard test'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 128000 } })
  }
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['guard-fake'], new ScriptedAdapter())
}
