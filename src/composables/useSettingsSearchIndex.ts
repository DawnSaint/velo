// 设置页搜索索引（设置搜索功能）
//
// 管所有 <SettingsItem> 的注册 / 注销 / 查询。<SettingsItem> 在 onMounted 时
// 经 provide/inject 调 register() 自动登记自身 label + keywords，onBeforeUnmount
// 调 unregister() 注销 —— 新增设置项只需用 <SettingsItem> 包裹即自动纳入搜索，
// 无需手动维护元数据。
//
// 搜索逻辑复用 fuzzyScore（src/utils/fuzzy.ts，Ctrl+P / 命令面板共用），
// 打分模式参照 commandPalette.ts：label 命中权重 +3 偏置，keywords 取最高分。

import { ref } from 'vue'
import { fuzzyScore } from '@/utils/fuzzy'

export interface SettingsSearchEntry {
  /** 唯一 id，用于 DOM 定位（data-settings-item 属性值） */
  id: string
  /** 设置项显示名称（用户看到的 label 文本） */
  label: string
  /** 搜索别名：英文、拼音、缩写等 label 之外的补充词 */
  keywords: string[]
  /** 所属分组 id */
  groupId: string
}

export interface SettingsSearchResult {
  entry: SettingsSearchEntry
  score: number
  /** label 上的命中下标，用于高亮 */
  labelIndices: number[]
  /** 所属分组标题（从 groupTitleMap 查得，供结果列表展示） */
  groupTitle: string
}

export function useSettingsSearchIndex(groupTitleMap: Map<string, string>) {
  const items = ref<Map<string, SettingsSearchEntry>>(new Map())

  function register(item: SettingsSearchEntry): void {
    items.value.set(item.id, item)
  }

  function unregister(id: string): void {
    items.value.delete(id)
  }

  function search(query: string): SettingsSearchResult[] {
    const q = query.trim()
    if (!q) return []
    const results: SettingsSearchResult[] = []

    for (const entry of items.value.values()) {
      // label 命中（权重高，+3 偏置），保留 indices 供高亮
      const labelHit = fuzzyScore(entry.label, q)
      let best: { score: number, labelIndices?: number[] } | null =
        labelHit ? { score: labelHit.score + 3, labelIndices: labelHit.indices } : null

      // keywords 命中（权重正常，不保留 indices —— 高亮只标 label）
      for (const kw of entry.keywords) {
        const hit = fuzzyScore(kw, q)
        if (!hit) continue
        if (!best || hit.score > best.score) best = { score: hit.score }
      }

      if (best) {
        results.push({
          entry,
          score: best.score,
          labelIndices: best.labelIndices ?? [],
          groupTitle: groupTitleMap.get(entry.groupId) ?? '',
        })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results
  }

  return { register, unregister, search }
}
