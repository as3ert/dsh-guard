/** Regex helpers: top-level alternatives and unbounded token prefixes in redact patterns. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compilePattern, topAlternatives, unboundedTokenPrefixes } from '../src/core/regex.ts'

describe('token prefixes', () => {
  it('splits only at top-level bars', () => {
    assert.deepEqual(topAlternatives('(?i)a|(b|c)|[|]d|e\\|f'), ['a', '(b|c)', '[|]d', 'e\\|f'])
  })

  it('flags a prefix without a left boundary and accepts \\b or a lookbehind', () => {
    assert.deepEqual(unboundedTokenPrefixes('sk-[A-Za-z0-9_-]{16,}'), ['sk-[A-Za-z0-9_-]{16,}'])
    assert.deepEqual(unboundedTokenPrefixes('(?i)\\bsk-[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{20,}|Bearer\\s+\\S+'), ['hf_[A-Za-z0-9]{20,}'])
    assert.deepEqual(unboundedTokenPrefixes('(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}|\\bgh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]+'), [])
  })

  it('shows why: the unbounded prefix masks inside a word, the bounded one does not', () => {
    const text = 'desk-lamp-controller-service started'
    assert.equal(compilePattern('sk-[A-Za-z0-9_-]{16,}').test(text), true)
    assert.equal(compilePattern('\\bsk-[A-Za-z0-9_-]{16,}').test(text), false)
  })
})
