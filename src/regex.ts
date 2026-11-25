/** Regex compilation for rule patterns. @module */

/**
 * Compile one rule pattern. A leading `(?i)` makes the whole pattern
 * case-insensitive, since JavaScript has no global inline flag.
 * @param pattern - source text.
 * @param extraFlags - additional flags such as `g` for redaction.
 * @returns the compiled expression.
 * @throws SyntaxError when the pattern does not compile.
 */
export function compilePattern(pattern: string, extraFlags = ''): RegExp {
  let source = pattern
  let flags = extraFlags
  if (source.startsWith('(?i)')) {
    source = source.slice(4)
    if (!flags.includes('i')) flags += 'i'
  }
  return new RegExp(source, flags)
}

/**
 * Cheap heuristic for patterns prone to catastrophic backtracking: a
 * quantified group whose body is itself quantified, such as `(a+)+`.
 * @param pattern - source text.
 * @returns whether the pattern looks risky.
 */
export function looksCatastrophic(pattern: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)
}

/**
 * Split a pattern into its top-level alternatives (outside groups and
 * character classes). A leading `(?i)` is dropped first.
 * @param pattern - source text.
 * @returns the alternatives in order.
 */
export function topAlternatives(pattern: string): string[] {
  const source = pattern.startsWith('(?i)') ? pattern.slice(4) : pattern
  const out: string[] = []
  let depth = 0
  let inClass = false
  let start = 0
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === '\\') {
      i += 1
      continue
    }
    if (inClass) {
      if (char === ']') inClass = false
      continue
    }
    if (char === '[') inClass = true
    else if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === '|' && depth === 0) {
      out.push(source.slice(start, i))
      start = i + 1
    }
  }
  out.push(source.slice(start))
  return out
}

/**
 * Alternatives of a redact pattern that start with a literal token prefix of
 * two to four letters followed by `-` or `_` (such as `sk-` or `hf_`) and have
 * no left boundary, so they also match inside ordinary words (`desk-...`).
 * @param pattern - source text.
 * @returns the offending alternatives.
 */
export function unboundedTokenPrefixes(pattern: string): string[] {
  return topAlternatives(pattern).filter(alternative => /^[A-Za-z]{2,4}[-_]/.test(alternative))
}

/** Remark for one unbounded token-prefix alternative. */
export function tokenPrefixRemark(alternative: string): string {
  const prefix = /^[A-Za-z]{2,4}[-_]/.exec(alternative)?.[0] ?? alternative
  const shown = alternative.length > 60 ? `${alternative.slice(0, 59)}…` : alternative
  return `redact alternative \`${shown}\` starts with the token prefix \`${prefix}\` without a left boundary, so it also masks where a longer word ends in it (\`desk-lamp\` contains \`sk-\`); write \`\\b${prefix}\` or \`(?<![A-Za-z0-9_-])${prefix}\``
}
