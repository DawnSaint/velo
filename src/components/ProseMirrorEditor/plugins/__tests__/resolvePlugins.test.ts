// resolvePlugins 解析器测试。
//
// 测例覆盖:
// 1. 正常排序 — 物理顺序打乱,输出按 canonical order 排序
// 2. 重复 id — 抛错
// 3. 集合不匹配 — missing / extra 抛错
// 4. requires 引用未知 id — 抛错
// 5. requires 在 canonical order 中靠后 — 抛错
// 6. requires 正确声明 — 通过

import { describe, expect, it } from 'vitest'
import { Plugin, PluginKey } from 'prosemirror-state'
import type { PluginEntry } from '../types'
import { resolvePlugins } from '../resolvePlugins'
import { CANONICAL_PLUGIN_ORDER } from '../order'

/** Create a minimal dummy plugin for testing. */
function dummyPlugin(id: string): Plugin {
  return new Plugin({ key: new PluginKey(id) })
}

/** Create entries for every canonical id, in reversed order to test sorting. */
function reversedEntries(): PluginEntry[] {
  return CANONICAL_PLUGIN_ORDER
    .slice()
    .reverse()
    .map((id): PluginEntry => ({ id, plugin: dummyPlugin(id) }))
}

describe('resolvePlugins', () => {
  it('sorts entries by canonical order regardless of input order', () => {
    const entries = reversedEntries()
    const resolved = resolvePlugins(entries)

    expect(resolved).toHaveLength(CANONICAL_PLUGIN_ORDER.length)
    // The output should follow canonical order, not the reversed input
    for (let i = 0; i < CANONICAL_PLUGIN_ORDER.length; i++) {
      const expectedId = CANONICAL_PLUGIN_ORDER[i]
      // Verify via the entries mapping — the resolved plugin at index i
      // should be the entry whose id matches the canonical order
      const entry = entries.find((e) => e.plugin === resolved[i])
      expect(entry?.id).toBe(expectedId)
    }
  })

  it('throws on duplicate ids', () => {
    const entries: PluginEntry[] = [
      { id: CANONICAL_PLUGIN_ORDER[0], plugin: dummyPlugin('a') },
      { id: CANONICAL_PLUGIN_ORDER[0], plugin: dummyPlugin('b') },
      ...CANONICAL_PLUGIN_ORDER.slice(1).map((id): PluginEntry => ({ id, plugin: dummyPlugin(id) })),
    ]
    expect(() => resolvePlugins(entries)).toThrow(/duplicate plugin id/)
  })

  it('throws on missing plugins (entry set smaller than canonical)', () => {
    const entries: PluginEntry[] = CANONICAL_PLUGIN_ORDER.slice(1).map((id): PluginEntry => ({
      id,
      plugin: dummyPlugin(id),
    }))
    expect(() => resolvePlugins(entries)).toThrow(/missing/)
  })

  it('throws on extra plugins (entry set larger than canonical)', () => {
    const entries: PluginEntry[] = [
      ...CANONICAL_PLUGIN_ORDER.map((id): PluginEntry => ({ id, plugin: dummyPlugin(id) })),
      { id: 'nonExistent', plugin: dummyPlugin('extra') },
    ]
    expect(() => resolvePlugins(entries)).toThrow(/extra/)
  })

  it('throws when requires references an unknown id', () => {
    const entries: PluginEntry[] = CANONICAL_PLUGIN_ORDER.map((id): PluginEntry => ({
      id,
      plugin: dummyPlugin(id),
    }))
    // Add a requires referencing an id not in the canonical list
    const firstIdx = entries.findIndex(
      (e) => e.id === CANONICAL_PLUGIN_ORDER[0],
    )
    entries[firstIdx] = {
      ...entries[firstIdx],
      requires: ['nonExistent'],
    }
    expect(() => resolvePlugins(entries)).toThrow(/requires unknown plugin/)
  })

  it('throws when requires references a plugin that comes after in canonical order', () => {
    const entries: PluginEntry[] = CANONICAL_PLUGIN_ORDER.map((id): PluginEntry => ({
      id,
      plugin: dummyPlugin(id),
    }))
    // First plugin requires the last — invalid
    entries[0] = {
      ...entries[0],
      requires: [CANONICAL_PLUGIN_ORDER[CANONICAL_PLUGIN_ORDER.length - 1]],
    }
    expect(() => resolvePlugins(entries)).toThrow(/comes after it/)
  })

  it('passes when requires is satisfied (dependency comes before)', () => {
    const entries: PluginEntry[] = CANONICAL_PLUGIN_ORDER.map((id): PluginEntry => ({
      id,
      plugin: dummyPlugin(id),
    }))
    // tableEditing requires tableColumnResizing + tableCellInputGuard — both come before
    const tableEditingIdx = entries.findIndex((e) => e.id === 'tableEditing')
    entries[tableEditingIdx] = {
      ...entries[tableEditingIdx],
      requires: ['tableColumnResizing', 'tableCellInputGuard'],
    }
    expect(() => resolvePlugins(entries)).not.toThrow()
  })
})
