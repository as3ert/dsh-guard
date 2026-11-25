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

const SCRIPT = [
  { name: SHELL, args: { description: 'Guard block marker', command: 'echo dsh-guard-it-block-marker' } },
  { name: 'read', args: { file_path: 'notes.txt' } },
  { name: 'read', args: { file_path: 'secret.txt' } },
  { name: SHELL, args: { description: 'Guard ask marker', command: 'echo dsh-guard-it-ask-marker' } },
]

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
