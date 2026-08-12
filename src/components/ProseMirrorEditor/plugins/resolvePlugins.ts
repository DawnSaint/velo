import type { Plugin } from 'prosemirror-state'
import type { PluginEntry } from './types'
import { CANONICAL_PLUGIN_ORDER } from './order'

/**
 * Resolve an unordered array of `PluginEntry` into a correctly ordered
 * `Plugin[]`, validating against the canonical order list.
 *
 * Validations (any failure throws):
 * 1. **Duplicate ids** — the same id appears more than once.
 * 2. **Set equality** — registered ids must exactly match the canonical list
 *    (no missing, no extra). Prevents drift when plugins are added/removed.
 * 3. **Requires existence** — every `requires` entry must reference a known id.
 * 4. **Requires satisfaction** — every `requires` entry must appear **before**
 *    this plugin in the canonical order.
 *
 * After validation, entries are sorted by their canonical index, so the
 * physical order of the input array is irrelevant.
 */
export function resolvePlugins(entries: PluginEntry[]): Plugin[] {
  // 1 — duplicate ids
  const seen = new Set<string>()
  for (const { id } of entries) {
    if (seen.has(id)) {
      throw new Error(`[resolvePlugins] duplicate plugin id: "${id}"`)
    }
    seen.add(id)
  }

  // 2 — set equality
  const entryIds = new Set(entries.map((e) => e.id))
  const canonicalIds = new Set(CANONICAL_PLUGIN_ORDER)
  const missing = [...canonicalIds].filter((id) => !entryIds.has(id))
  const extra = [...entryIds].filter((id) => !canonicalIds.has(id))
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = []
    if (missing.length > 0) parts.push(`missing [${missing.join(', ')}]`)
    if (extra.length > 0) parts.push(`extra [${extra.join(', ')}]`)
    throw new Error(
      `[resolvePlugins] plugin set mismatch — ${parts.join('; ')}. ` +
        'Update CANONICAL_PLUGIN_ORDER or the entries array to match.',
    )
  }

  // build index map for sorting & requires validation
  const orderIndex = new Map<string, number>()
  CANONICAL_PLUGIN_ORDER.forEach((id, i) => orderIndex.set(id, i))

  // 3 & 4 — requires existence + satisfaction
  for (const { id, requires } of entries) {
    if (!requires) continue
    for (const req of requires) {
      if (!orderIndex.has(req)) {
        throw new Error(
          `[resolvePlugins] plugin "${id}" requires unknown plugin "${req}"`,
        )
      }
      if (orderIndex.get(id)! < orderIndex.get(req)!) {
        throw new Error(
          `[resolvePlugins] plugin "${id}" requires "${req}" but "${req}" ` +
            'comes after it in the canonical order — fix order.ts',
        )
      }
    }
  }

  // sort by canonical index
  return entries
    .slice()
    .sort((a, b) => orderIndex.get(a.id)! - orderIndex.get(b.id)!)
    .map((e) => e.plugin)
}
