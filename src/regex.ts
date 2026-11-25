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
