import { reactive } from 'vue'
import { defineStore } from 'pinia'

/**
 * 大纲折叠状态:按文件路径为 key 存储每篇文档哪些标题处于折叠态。
 *
 * 选用 `reactive` 包装的 plain object 而不是 `ref<Record<...>>` —— 后者在
 * 增删属性时不会自动通知依赖,前端需要写得很啰嗦。reactive 形式最稳。
 *
 * 内部统一存 `string[]`(set 边界处理),落盘直接 JSON.stringify 即可。
 * UI 侧需要的 Set 视图由 EditorOutline 自己 new Set(arr) 出来,避免响应式
 * Set 在 Vue 3 里的反直觉行为。
 */
export const useOutlineStore = defineStore('outline', () => {
  const collapsedByPath = reactive<Record<string, string[]>>({})

  function getKeysFor(path: string): string[] {
    return collapsedByPath[path] ?? []
  }

  /**
   * 写入某文件的折叠 key 集合。
   * path 为 null(未保存的新文档)时直接忽略,不污染持久化层。
   */
  function setKeysFor(path: string | null, keys: string[] | Set<string>) {
    if (!path) return
    collapsedByPath[path] = Array.from(keys)
  }

  /** 应用启动时从磁盘灌入(覆盖现有) */
  function loadFrom(data: Record<string, string[]>) {
    for (const k of Object.keys(collapsedByPath)) delete collapsedByPath[k]
    Object.assign(collapsedByPath, data)
  }

  /** 落盘前取全量深拷贝,防止后续 mutation 渗到快照里 */
  function snapshot(): Record<string, string[]> {
    return Object.fromEntries(
      Object.entries(collapsedByPath).map(([k, v]) => [k, [...v]]),
    )
  }

  return { collapsedByPath, getKeysFor, setKeysFor, loadFrom, snapshot }
})
