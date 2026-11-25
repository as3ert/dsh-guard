/** Test helpers: temporary rule trees. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Create a fresh temporary directory. */
export function tempDir(prefix = 'dsh-guard-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Write files below a root; keys are relative paths. */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
}
