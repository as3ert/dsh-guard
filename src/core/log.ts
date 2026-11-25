/** Append-only JSONL decision log. @module */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultUserDir } from './loader.ts'

/** One logged decision. */
export interface LogRecord {
  readonly time: string
  readonly rule: string
  readonly verdict: string
  readonly tool: string
  readonly summary: string
  readonly cwd: string
  readonly reason?: string
  readonly callId?: string
  /** Harness that made the decision (`dsh`, `claude-code`); absent in older records. */
  readonly harness?: string
  /** Session id, when the harness reports one. */
  readonly session?: string
}

/** Default log path, `~/.dsh-guard/log.jsonl`. */
export function defaultLogPath(): string {
  return join(defaultUserDir(), 'log.jsonl')
}

/** Serialized, failure-tolerant JSONL writer. */
export class DecisionLog {
  private chain: Promise<void> = Promise.resolve()
  private dirReady = false
  readonly path: string
  readonly harness?: string

  /**
   * @param path - log file; an empty string disables logging.
   * @param harness - written into every record when set.
   */
  constructor(path: string, harness?: string) {
    this.path = path
    if (harness !== undefined) this.harness = harness
  }

  /**
   * Queue one record. Never throws; write errors are reported once to `onError`.
   * @param record - record without its timestamp.
   * @param onError - receives write failures.
   */
  write(record: Omit<LogRecord, 'time'>, onError?: (error: unknown) => void): void {
    if (this.path === '') return
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...this.harness !== undefined ? { harness: this.harness } : {}, ...record })}\n`
    this.chain = this.chain.then(async () => {
      if (!this.dirReady) {
        await mkdir(dirname(this.path), { recursive: true })
        this.dirReady = true
      }
      await appendFile(this.path, line, 'utf8')
    }).catch(error => onError?.(error))
  }

  /** Resolve when every queued record has been written. */
  flush(): Promise<void> {
    return this.chain
  }
}
