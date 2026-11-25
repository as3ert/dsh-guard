/**
 * Records where the plugin's peer dependencies resolve from inside the
 * linked dsh-guard checkout, for the `dsh plugin add` check. Written to the
 * file named by DSH_GUARD_IT_PROBE.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-guard-peer-probe'

const PEERS = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools', 'yaml']

export function apply() {
  const out = {}
  for (const peer of PEERS) {
    try {
      out[peer] = fileURLToPath(import.meta.resolve(peer))
    } catch (error) {
      out[peer] = `unresolved: ${error.message}`
    }
  }
  if (process.env.DSH_GUARD_IT_PROBE) writeFileSync(process.env.DSH_GUARD_IT_PROBE, JSON.stringify(out))
}
