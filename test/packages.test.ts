/** Package boundaries: the engine core depends on no harness, and the adapters do not depend on each other. */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** Module specifiers imported by every file of one package directory. */
function imports(pkg: string): { file: string, spec: string }[] {
  const out: { file: string, spec: string }[] = []
  for (const name of readdirSync(join(SRC, pkg))) {
    if (!name.endsWith('.ts')) continue
    const text = readFileSync(join(SRC, pkg, name), 'utf8')
    for (const match of text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)) out.push({ file: `${pkg}/${name}`, spec: match[1] })
  }
  return out
}

describe('package boundaries', () => {
  it('core imports only node built-ins, yaml and itself', () => {
    for (const { file, spec } of imports('core')) {
      assert.ok(spec.startsWith('node:') || spec === 'yaml' || /^\.\/[\w-]+\.ts$/.test(spec), `${file} imports ${spec}`)
    }
  })
  it('the Claude Code adapter imports no dsh code', () => {
    for (const { file, spec } of imports('claude-code')) {
      assert.ok(!spec.includes('@deepseek-ai') && !spec.startsWith('../dsh/'), `${file} imports ${spec}`)
    }
  })
  it('the dsh adapter imports no Claude Code code', () => {
    for (const { file, spec } of imports('dsh')) assert.ok(!spec.startsWith('../claude-code/'), `${file} imports ${spec}`)
  })
})
