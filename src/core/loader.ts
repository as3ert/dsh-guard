/** Load and layer rule files. @module */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { compilePattern } from './regex.ts'
import { RESERVED_PREFIX } from './builtin.ts'
import { ACTION_RANK, checkEntry, completeSpec } from './schema.ts'
import type { PartialSpec } from './schema.ts'
import type { CheckFn, FieldMatcher, Issue, LayerName, Rule, RuleSet, RuleSource, RuleSpec } from './types.ts'

/** Options selecting the rule layers. */
export interface LoadOptions {
  /** Project directory whose `.dsh-guard/` and `.dsh-guard.local/` are read. */
  cwd: string
  /**
   * Rule packs loaded first, before the user layer: rule files or directories
   * of rule files, given by the user. The plugin ships no packs; default none.
   */
  packs?: readonly string[]
  /** User rule directory; `null` skips the user layer. Default `~/.dsh-guard`. */
  userDir?: string | null
  /** Extra rule files loaded last, after the local layer. */
  extraFiles?: readonly string[]
  /** Layers whose files may disable an earlier rule. Default user and local. */
  disableLayers?: readonly LayerName[]
  /** Layers whose files may name `check:` hooks, which run code. Default packs, user, local, extra. */
  checkLayers?: readonly LayerName[]
  /** File contents that replace (or add) files on disk, keyed by absolute path; used to simulate a draft. */
  virtualFiles?: Readonly<Record<string, string>>
  /** Built-in rules appended after every layer; they cannot be overridden or disabled. */
  builtin?: readonly Rule[]
}

/** Default user rule directory. */
export function defaultUserDir(): string {
  return process.env.DSH_GUARD_HOME ?? join(homedir(), '.dsh-guard')
}

/** Whether a path is an existing directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Rule files of one directory, sorted by name, including virtual files placed there. */
function yamlFiles(dir: string, virtualFiles?: Readonly<Record<string, string>>): string[] {
  // A missing directory contributes only its virtual files.
  const names: string[] = isDirectory(dir) ? readdirSync(dir) : []
  const wanted = new Set(names.filter(name => /\.ya?ml$/i.test(name)))
  for (const file of Object.keys(virtualFiles ?? {})) {
    if (resolve(dirname(file)) === resolve(dir) && /\.ya?ml$/i.test(file)) wanted.add(basename(file))
  }
  return [...wanted].sort().map(name => join(dir, name))
}

/**
 * Rule files in load order with their layer.
 * @param options - layer selection.
 * @returns files, packs first and extra last.
 */
export function layerFiles(options: LoadOptions): { layer: LayerName, file: string }[] {
  const files: { layer: LayerName, file: string }[] = []
  for (const pack of options.packs ?? []) {
    const path = resolve(pack)
    if (isDirectory(path)) for (const file of yamlFiles(path, options.virtualFiles)) files.push({ layer: 'packs', file })
    else files.push({ layer: 'packs', file: path })
  }
  const userDir = options.userDir === undefined ? defaultUserDir() : options.userDir
  if (userDir !== null) for (const file of yamlFiles(userDir, options.virtualFiles)) files.push({ layer: 'user', file })
  for (const file of yamlFiles(join(options.cwd, '.dsh-guard'), options.virtualFiles)) files.push({ layer: 'project', file })
  for (const file of yamlFiles(join(options.cwd, '.dsh-guard.local'), options.virtualFiles)) files.push({ layer: 'local', file })
  for (const file of options.extraFiles ?? []) files.push({ layer: 'extra', file: resolve(file) })
  return files
}

/** Parse one file into its list of entries. */
function readEntries(file: string, virtualFiles?: Readonly<Record<string, string>>): { entries?: unknown[], error?: string } {
  let text: string
  const virtual = virtualFiles === undefined
    ? undefined
    : Object.entries(virtualFiles).find(([path]) => resolve(path) === resolve(file))?.[1]
  try {
    text = virtual ?? readFileSync(file, 'utf8')
  } catch (error) {
    return { error: `cannot read file: ${(error as Error).message}` }
  }
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (error) {
    return { error: `invalid YAML: ${(error as Error).message.split('\n')[0]}` }
  }
  if (doc === null || doc === undefined) return { entries: [] }
  if (Array.isArray(doc)) return { entries: doc }
  if (typeof doc === 'object' && Array.isArray((doc as { rules?: unknown }).rules)) {
    const extra = Object.keys(doc).filter(key => key !== 'rules' && key !== 'version')
    if (extra.length > 0) return { error: `unknown top-level field(s): ${extra.join(', ')}` }
    return { entries: (doc as { rules: unknown[] }).rules }
  }
  return { error: 'a rule file must be a list of rules or a mapping with a `rules` list' }
}

/** Compile the match block of a spec. */
function compileMatchers(spec: RuleSpec): { matchers?: FieldMatcher[], error?: string } {
  const matchers: FieldMatcher[] = []
  for (const [key, patterns] of Object.entries(spec.match)) {
    const negate = key.startsWith('not_')
    const field = negate ? key.slice(4) : key
    const compiled: RegExp[] = []
    for (const pattern of patterns) {
      try {
        compiled.push(compilePattern(pattern))
      } catch (error) {
        return { error: `match.${key}: ${(error as Error).message}` }
      }
    }
    matchers.push({ field, negate, patterns: compiled })
  }
  return { matchers }
}

/** Resolve a `check: <module>:<fn>` hook relative to the rule file. */
async function loadCheck(check: string, file: string): Promise<CheckFn> {
  const split = check.lastIndexOf(':')
  const specifier = check.slice(0, split)
  const exportName = check.slice(split + 1)
  const target = specifier.startsWith('.') || isAbsolute(specifier)
    ? pathToFileURL(resolve(dirname(file), specifier)).href
    : specifier
  const module = await import(target) as Record<string, unknown>
  const fn = module[exportName]
  if (typeof fn !== 'function') throw new Error(`export \`${exportName}\` of ${specifier} is not a function`)
  return fn as CheckFn
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

interface Entry {
  merged: PartialSpec
  spec: RuleSpec
  sources: RuleSource[]
  /** File whose `check:` field is in effect, for module resolution. */
  checkFile?: string
  checkLayer?: LayerName
}

/**
 * Load every layer, apply the tighten-only override rule and compile.
 * A broken file or rule is skipped and reported; loading never throws.
 * @param options - layer selection.
 * @returns active rules, all rules and the issues found.
 */
export async function loadRules(options: LoadOptions): Promise<RuleSet> {
  const issues: Issue[] = []
  const entries = new Map<string, Entry>()
  const files: string[] = []
  const disableLayers = new Set<LayerName>(options.disableLayers ?? ['user', 'local'])
  const checkLayers = new Set<LayerName>(options.checkLayers ?? ['packs', 'user', 'local', 'extra'])

  for (const { layer, file } of layerFiles(options)) {
    files.push(file)
    const { entries: raws, error } = readEntries(file, options.virtualFiles)
    if (error !== undefined || raws === undefined) {
      issues.push({ level: 'error', file, message: `file skipped: ${error}` })
      continue
    }
    for (const raw of raws) {
      const { spec: stated, errors } = checkEntry(raw)
      const rawId = typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id : undefined
      if (stated === undefined) {
        issues.push({ level: 'error', file, ...rawId !== undefined ? { id: rawId } : {}, message: `rule skipped: ${errors.join('; ')}` })
        continue
      }
      const id = stated.id
      if (id.startsWith(RESERVED_PREFIX)) {
        issues.push({ level: 'warning', file, id, message: `rule skipped: ids starting with \`${RESERVED_PREFIX}\` are reserved for built-in rules, which cannot be overridden or disabled` })
        continue
      }
      const source: RuleSource = { layer, file }
      const previous = entries.get(id)
      if (stated.check !== undefined && !checkLayers.has(layer)) {
        issues.push({ level: 'warning', file, id, message: `rule skipped: the ${layer} layer may not name check hooks (they run code)` })
        continue
      }
      if (previous === undefined) {
        if (stated.disabled === true && Object.keys(stated).every(key => key === 'id' || key === 'disabled' || key === 'reason')) {
          issues.push({ level: 'notice', file, id, message: 'disables a rule that is not loaded; ignored' })
          continue
        }
        const { spec, errors: specErrors } = completeSpec(stated)
        if (spec === undefined) {
          issues.push({ level: 'error', file, id, message: `rule skipped: ${specErrors.join('; ')}` })
          continue
        }
        entries.set(id, {
          merged: stated,
          spec,
          sources: [source],
          ...stated.check !== undefined ? { checkFile: file, checkLayer: layer } : {},
        })
        continue
      }
      // Override of an existing id: tighten only.
      const prior = previous.spec
      const scopeChanges = (['when', 'tool', 'match', 'check'] as const)
        .filter(key => stated[key] !== undefined && !sameJson(stated[key], prior[key]))
      if (scopeChanges.length > 0) {
        issues.push({ level: 'warning', file, id, message: `override rejected: it changes ${scopeChanges.join(', ')} of an existing rule; define a new id instead` })
        continue
      }
      if (stated.action !== undefined && ACTION_RANK[stated.action] < ACTION_RANK[prior.action]) {
        issues.push({ level: 'warning', file, id, message: `override rejected: loosens action ${prior.action} to ${stated.action} (only warn < ask < block tightening is allowed; use disabled: true with a reason)` })
        continue
      }
      if (stated.override === true && !prior.override) {
        issues.push({ level: 'warning', file, id, message: 'override rejected: turning on `override` loosens the rule' })
        continue
      }
      if (stated.disabled === true) {
        if (stated.reason === undefined) {
          issues.push({ level: 'error', file, id, message: 'override rejected: `disabled: true` needs a `reason`' })
          continue
        }
        if (!disableLayers.has(layer)) {
          issues.push({ level: 'warning', file, id, message: `override rejected: the ${layer} layer may not disable rules (allowed: ${[...disableLayers].join(', ')})` })
          continue
        }
      }
      const merged: PartialSpec = {
        ...previous.merged,
        ...stated,
        ...previous.merged.examples !== undefined || stated.examples !== undefined
          ? {
              examples: {
                block: [...previous.merged.examples?.block ?? [], ...stated.examples?.block ?? []],
                pass: [...previous.merged.examples?.pass ?? [], ...stated.examples?.pass ?? []],
              },
            }
          : {},
      }
      if (stated.disabled === false) {
        delete merged.disabled
        delete merged.reason
      }
      const { spec, errors: specErrors } = completeSpec(merged)
      if (spec === undefined) {
        issues.push({ level: 'error', file, id, message: `override rejected: ${specErrors.join('; ')}` })
        continue
      }
      if (stated.disabled === true) issues.push({ level: 'notice', file, id, message: `rule disabled: ${stated.reason}` })
      entries.set(id, { ...previous, merged, spec, sources: [...previous.sources, source] })
    }
  }

  const all: Rule[] = []
  for (const [id, entry] of entries) {
    const { matchers, error } = compileMatchers(entry.spec)
    const file = entry.sources[entry.sources.length - 1].file
    if (matchers === undefined) {
      issues.push({ level: 'error', file, id, message: `rule skipped: ${error}` })
      continue
    }
    let checkFn: CheckFn | undefined
    if (entry.spec.check !== undefined && entry.checkFile !== undefined) {
      try {
        checkFn = await loadCheck(entry.spec.check, entry.checkFile)
      } catch (loadError) {
        issues.push({ level: 'error', file: entry.checkFile, id, message: `rule skipped: check hook failed to load: ${(loadError as Error).message}` })
        continue
      }
    }
    all.push({ ...entry.spec, sources: entry.sources, matchers, ...checkFn !== undefined ? { checkFn } : {} })
  }
  all.push(...options.builtin ?? [])
  return { rules: all.filter(rule => rule.disabled !== true), all, issues, files }
}
