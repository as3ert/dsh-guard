/**
 * Data and actions of the dsh-guard settings card: rules per layer with
 * their on/off state where a layer may switch them, log counts, and
 * observe-mode rules with their promotion. Every action is a draft request
 * that goes through {@link GuardAuthoring.apply}, with the same checks and
 * the same approval prompt as `guard_apply`.
 * @module
 */
import { isObserve, onlyBuiltin, promotionRequest } from './authoring.ts'
import type { AuthoringLayer, DraftRequest, GuardAuthoring } from './authoring.ts'
import { readLogStats } from './stats.ts'
import type { LayerName, Rule } from './types.ts'

/** One rule row of the card. */
export interface SettingsRule {
  readonly id: string
  readonly layer: LayerName
  readonly action: string
  readonly promoteTo?: string
  readonly enabled: boolean
  /** Layer the on/off switch writes to, when the rule can be switched. */
  readonly toggleLayer?: AuthoringLayer
  readonly hits: number
  readonly overrides: number
  readonly file: string
}

/** One layer section of the card. */
export interface SettingsLayer {
  readonly layer: LayerName
  readonly rules: SettingsRule[]
}

/** Everything the card shows. */
export interface SettingsSnapshot {
  /** True while no rule file defines any rule; the card then shows {@link SettingsSnapshot.hint}. */
  readonly empty: boolean
  /** Hint for the empty state: rules are created by describing them in a conversation. */
  readonly hint?: string
  readonly layers: SettingsLayer[]
  /** Observe-mode rules, each with a promotion request. */
  readonly observe: { rule: SettingsRule, promote: DraftRequest }[]
}

/** Empty-state text of the card. */
export const EMPTY_HINT = 'No guard rules yet. dsh-guard ships none; describe what should be guarded in a conversation with the agent, which drafts the rule, tests it and writes it after your approval.'

const ORDER: readonly LayerName[] = ['builtin', 'packs', 'user', 'project', 'local', 'extra']

/**
 * Layer whose file switches a rule on or off, or undefined when none may.
 * Off writes `disabled: true` with a reason; on removes that entry again.
 */
function toggleLayer(rule: Rule, authoring: GuardAuthoring): AuthoringLayer | undefined {
  const allowed = new Set(authoring.core.options.disableLayers)
  const userOn = authoring.core.options.userDir !== ''
  const writable = (layer: LayerName): layer is AuthoringLayer => (layer === 'user' && userOn) || layer === 'local'
  if (rule.disabled === true) {
    const by = [...rule.sources].reverse().find(source => writable(source.layer))
    return by?.layer as AuthoringLayer | undefined
  }
  const first = rule.sources[0].layer
  const candidates: LayerName[] = first === 'builtin' || first === 'extra'
    ? []
    : first === 'project' ? ['local'] : first === 'local' ? ['local'] : first === 'user' ? ['user', 'local'] : ['user', 'local']
  return candidates.find(layer => writable(layer) && allowed.has(layer)) as AuthoringLayer | undefined
}

/**
 * Build the card's data for a project directory.
 * @param authoring - authoring over the running guard core.
 * @param cwd - project directory.
 */
export async function settingsSnapshot(authoring: GuardAuthoring, cwd: string): Promise<SettingsSnapshot> {
  const set = await authoring.load(cwd)
  const stats = readLogStats(authoring.core.options.logPath)
  const layers = new Map<LayerName, SettingsRule[]>(ORDER.map(layer => [layer, []]))
  const observe: SettingsSnapshot['observe'] = []
  for (const rule of set.all) {
    const stat = stats.get(rule.id)
    const toggle = toggleLayer(rule, authoring)
    const row: SettingsRule = {
      id: rule.id,
      layer: rule.sources[0].layer,
      action: rule.action,
      ...rule.promote_to !== undefined && rule.action === 'warn' ? { promoteTo: rule.promote_to } : {},
      enabled: rule.disabled !== true,
      ...toggle !== undefined ? { toggleLayer: toggle } : {},
      hits: stat?.hits ?? 0,
      overrides: stat?.overrides ?? 0,
      file: rule.sources[rule.sources.length - 1].file,
    }
    layers.get(row.layer)?.push(row)
    const promote = rule.disabled === true ? undefined : promotionRequest(rule)
    if (isObserve(rule) && promote !== undefined) observe.push({ rule: row, promote })
  }
  const empty = onlyBuiltin(set.all)
  return {
    empty,
    ...empty ? { hint: EMPTY_HINT } : {},
    layers: ORDER.map(layer => ({ layer, rules: layers.get(layer) ?? [] })),
    observe,
  }
}

/**
 * Draft request for the on/off switch of a row.
 * @param row - the rule row.
 * @param enabled - the requested state.
 */
export function toggleRequest(row: SettingsRule, enabled: boolean): DraftRequest | undefined {
  if (row.toggleLayer === undefined || row.enabled === enabled) return undefined
  return enabled
    ? { op: 'modify', layer: row.toggleLayer, rule: { id: row.id, disabled: false } }
    : { op: 'modify', layer: row.toggleLayer, rule: { id: row.id, disabled: true, reason: 'switched off in the dsh-guard settings card' } }
}
