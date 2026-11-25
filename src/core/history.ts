/**
 * Past tool calls, for replaying a draft rule. Each harness adapter supplies
 * a {@link HistorySource}: dsh reads its session-query service, Claude Code
 * its transcripts.
 * @module
 */
import type { ToolCall } from './types.ts'

/** One past call with where and when it happened. */
export interface HistoricCall extends ToolCall {
  readonly sessionId: string
  readonly callId: string
  /** Unix epoch milliseconds of the `tool/call` event. */
  readonly time: number
}

/** Result of collecting history. */
export interface History {
  /** Newest call first. */
  readonly calls: HistoricCall[]
  /** Sessions read. */
  readonly sessions: number
  /** Why history is incomplete or missing, if it is. */
  readonly note?: string
}

/** Source of past calls, newest first, at most `limit`. */
export type HistorySource = (limit: number) => Promise<History>
