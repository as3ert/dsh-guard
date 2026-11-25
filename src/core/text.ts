/** Text helpers shared by every adapter's authoring surface (dsh tools, CLI). @module */
import { isObserve, onlyBuiltin } from './authoring.ts'
import { readLogStats } from './stats.ts'
import type { Rule } from './types.ts'

/**
 * One line per rule, as guard_list and `dsh-guard list` print it; while no rule
 * file defines any rule, `noRulesText` comes first.
 * @param rules - every loaded rule.
 * @param logPath - decision log for the hit counts.
 * @param filter - optional layer and observe-only filter.
 * @param noRulesText - the adapter's explanation for an empty rule set.
 */
export function listText(rules: readonly Rule[], logPath: string, filter: { layer?: string, observeOnly?: boolean } = {}, noRulesText = ''): string {
  const table = rulesTable(rules, logPath, filter)
  return onlyBuiltin(rules) && filter.layer !== 'builtin' && noRulesText !== '' ? `${noRulesText}
${table}` : table
}

function rulesTable(rules: readonly Rule[], logPath: string, filter: { layer?: string, observeOnly?: boolean }): string {
  const stats = readLogStats(logPath)
  const lines: string[] = []
  for (const rule of rules) {
    const layers = rule.sources.map(source => source.layer)
    if (filter.layer !== undefined && !layers.includes(filter.layer as never)) continue
    if (filter.observeOnly === true && !isObserve(rule)) continue
    const stat = stats.get(rule.id)
    const action = rule.disabled === true ? `disabled (${rule.reason})` : isObserve(rule) ? `warn [observe, promote_to ${rule.promote_to}]` : rule.action
    const counts = stat === undefined ? 'hits 0' : `hits ${stat.hits}, overrides ${stat.overrides}`
    const file = rule.sources[rule.sources.length - 1].file
    lines.push(`${rule.id} | ${layers.join('>')} | ${rule.when} ${rule.tool.join(',')} | ${action} | ${counts} | ${file}`)
  }
  return lines.length === 0 ? 'No rules match.' : ['id | layers (definition>overrides) | phase tools | action | log counts | file', ...lines].join('\n')
}
