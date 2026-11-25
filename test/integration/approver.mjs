/**
 * Scripted approval answerer for the integration test: answers every
 * `approval/request` with `allowed-once` and records the request to the file
 * named by DSH_GUARD_IT_APPROVALS. Stands in for a human at the prompt.
 */
import { appendFileSync } from 'node:fs'

export const name = 'dsh-guard-it-approver'

export function apply(ctx) {
  ctx.on('approval/request', async req => {
    const file = process.env.DSH_GUARD_IT_APPROVALS
    if (file) appendFileSync(file, `${JSON.stringify({ toolName: req.toolName, callId: req.callId ?? null, reason: req.reason ?? null, display: req.displayReason?.en ?? null })}\n`)
    return 'allowed-once'
  })
}
