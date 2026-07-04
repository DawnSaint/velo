// 块级折叠状态(v0.5.12)—— 按文件路径 key 存储"哪些块被折叠"。
//
// 选用稳定 key(由 block 类型 + 内容指纹派生)而非 doc 绝对 pos:
// 关闭 / 重开文件后,doc 重建 → 一切 pos 失效;pos 当 key 等于"折叠状态全丢"。
// 稳定 key 牺牲:用户改了 heading 文本 / 改了代码块内容,指纹就变了,折叠态不会跟随。
// 这是合理取舍:折叠是"大块内容视图",用户编辑块内容本就该 unfold 重看。
//
// 数据结构:reactive 包装的 plain object(string[]),与 outline store 同形态
// (reactive Set 在 Vue 3 里有反直觉行为,outline 注释里写得很细)。
// UI 侧需要 Set 视图时 `new Set(arr)` 出来。

import { reactive } from 'vue'
import { defineStore } from 'pinia'
import { saveFoldState } from './persistence'

export const useFoldStore = defineStore('folding', () => {
  const collapsedByPath = reactive<Record<string, string[]>>({})

  function getKeysFor(path: string | null): string[] {
    if (!path) return []
    return collapsedByPath[path] ?? []
  }

  /** 写某文件的折叠 key 集合(覆盖式)。path 为 null 直接忽略,不污染持久化层。 */
  function setKeysFor(path: string | null, keys: string[] | Set<string>) {
    if (!path) return
    collapsedByPath[path] = Array.from(keys)
  }

  /**
   * 单个 key 的 toggle / 写入 / 删除。供 plugin 同步调用。
   * - add=true → 把 key 加入折叠集
   * - add=false → 从折叠集移除
   * 未变化则 noop(避免无谓 mutation 触发 watch 落盘)。
   */
  function setKey(path: string | null, key: string, add: boolean) {
    if (!path) return
    const cur = collapsedByPath[path] ?? []
    const has = cur.includes(key)
    if (add === has) return
    if (add) collapsedByPath[path] = [...cur, key]
    else collapsedByPath[path] = cur.filter(k => k !== key)
  }

  /** 应用启动时从磁盘灌入(覆盖现有)。 */
  function loadFrom(data: Record<string, string[]>) {
    for (const k of Object.keys(collapsedByPath)) delete collapsedByPath[k]
    Object.assign(collapsedByPath, data)
  }

  /** 落盘前取全量深拷贝,防止后续 mutation 渗到快照里。 */
  function snapshot(): Record<string, string[]> {
    return Object.fromEntries(
      Object.entries(collapsedByPath).map(([k, v]) => [k, [...v]]),
    )
  }

  /**
   * 异步落盘(由 App.vue watch 触发)。
   * 复用 outline store 的同步策略:失败仅日志,不抛 —— 折叠态写盘失败
   * 不应阻塞主编辑流程。
   */
  async function persist() {
    const data = snapshot()
    await saveFoldState({
      version: 1,
      files: data,
    })
  }

  return {
    collapsedByPath,
    getKeysFor,
    setKeysFor,
    setKey,
    loadFrom,
    snapshot,
    persist,
  }
})
