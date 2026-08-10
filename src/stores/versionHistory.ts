// 本地版本时间线 store(#local-timeline)
//
// 管理 UI 层状态:当前文件版本快照列表的懒加载缓存 + 选中态 + diff 视图开关。
// IO 逻辑在 persistence.ts;document.ts 的 saveDoc 在写盘成功后直接调
// persistence 的 saveVersionSnapshot + pruneVersionSnapshots,不经此 store,
// 避免循环依赖。本 store 只在 UI 需要展示时从磁盘懒加载。
//
// UI 形态(v0.8):左侧 ActivityBar「版本历史」入口 → 侧栏 VersionHistoryPanel
// 列出快照条目;点击条目 → 编辑器区切换为 DiffView(覆盖编辑器),diff 展示
// 该版本与当前内容的行级差异;DiffView 顶部「恢复」一键还原。

import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useDocumentStore } from './document'
import {
  loadVersionSnapshots as loadVersionSnapshotsFromFs,
  deleteVersionSnapshot as deleteVersionSnapshotFromFs,
  clearAllVersionSnapshots as clearAllVersionSnapshotsFromFs,
  VERSION_SNAPSHOT_CAP,
  type VersionSnapshot,
} from './persistence'

export const useVersionHistoryStore = defineStore('versionHistory', () => {
  const documentStore = useDocumentStore()

  /** 按文件路径缓存的快照列表(倒序,最新在前)。null = 未加载。 */
  const snapshotsByFile = ref<Map<string, VersionSnapshot[]>>(new Map())

  /** diff 视图是否激活(编辑器区显示 DiffView 而非编辑器) */
  const diffViewActive = ref(false)

  /** 当前选中的快照 id(null = 未选中) */
  const selectedSnapshotId = ref<string | null>(null)

  /** 当前文件的版本快照列表(从缓存或 null) */
  const currentFileSnapshots = computed<VersionSnapshot[] | null>(() => {
    const path = documentStore.currentFilePath
    if (!path) return null
    return snapshotsByFile.value.get(path) ?? null
  })

  /** 当前选中的快照对象 */
  const selectedSnapshot = computed<VersionSnapshot | null>(() => {
    const id = selectedSnapshotId.value
    if (!id) return null
    const list = currentFileSnapshots.value
    if (!list) return null
    return list.find(s => s.id === id) ?? null
  })

  /** 懒加载某文件的版本快照到缓存。返回快照数组。 */
  async function loadSnapshots(filePath: string): Promise<VersionSnapshot[]> {
    const snapshots = await loadVersionSnapshotsFromFs(filePath)
    snapshotsByFile.value.set(filePath, snapshots)
    return snapshots
  }

  /** 加载当前文件的快照(如果当前有文件的话) */
  async function loadCurrentFileSnapshots(): Promise<VersionSnapshot[]> {
    const path = documentStore.currentFilePath
    if (!path) return []
    return loadSnapshots(path)
  }

  /** 使某文件的缓存失效(下次 load 会从磁盘重读) */
  function invalidate(filePath: string): void {
    snapshotsByFile.value.delete(filePath)
  }

  /** 使所有缓存失效 */
  function invalidateAll(): void {
    snapshotsByFile.value.clear()
  }

  /** 删除单个快照(从磁盘 + 缓存同步移除) */
  async function deleteSnapshot(filePath: string, id: string): Promise<void> {
    await deleteVersionSnapshotFromFs(filePath, id)
    const cached = snapshotsByFile.value.get(filePath)
    if (cached) {
      snapshotsByFile.value.set(filePath, cached.filter(s => s.id !== id))
    }
    if (selectedSnapshotId.value === id) {
      selectedSnapshotId.value = null
      diffViewActive.value = false
    }
  }

  /** 清空某文件的全部版本历史 */
  async function clearHistory(filePath: string): Promise<void> {
    await clearAllVersionSnapshotsFromFs(filePath)
    snapshotsByFile.value.set(filePath, [])
    selectedSnapshotId.value = null
    diffViewActive.value = false
  }

  /** 打开版本历史:加载当前文件快照 + 选中最新一条 + 激活 diff 视图 */
  async function openVersionHistory(): Promise<void> {
    const path = documentStore.currentFilePath
    if (!path) return
    const snapshots = await loadCurrentFileSnapshots()
    selectedSnapshotId.value = snapshots.length > 0 ? snapshots[0].id : null
    diffViewActive.value = snapshots.length > 0
  }

  /** 关闭 diff 视图(回到编辑器) */
  function closeDiffView(): void {
    diffViewActive.value = false
    selectedSnapshotId.value = null
  }

  /** 选中某快照并激活 diff 视图(点击侧栏列表项时调) */
  function selectSnapshot(id: string): void {
    selectedSnapshotId.value = id
    diffViewActive.value = true
  }

  return {
    snapshotsByFile,
    diffViewActive,
    selectedSnapshotId,
    currentFileSnapshots,
    selectedSnapshot,
    VERSION_SNAPSHOT_CAP,
    loadSnapshots,
    loadCurrentFileSnapshots,
    invalidate,
    invalidateAll,
    deleteSnapshot,
    clearHistory,
    openVersionHistory,
    closeDiffView,
    selectSnapshot,
  }
})
