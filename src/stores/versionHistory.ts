// 本地版本时间线 store(#local-timeline)
//
// 管理 UI 层状态:当前文件版本快照列表的懒加载缓存 + 选中态 + diff 视图开关。
// IO 逻辑在 persistence.ts;document.ts 的 saveDoc 在写盘成功后调
// persistence 的 saveVersionSnapshot + pruneVersionSnapshots 落盘,
// 再调本 store 的 appendSnapshot 同步更新内存缓存,使 UI 即时刷新。
//
// UI 形态(v0.8):左侧 ActivityBar「版本历史」入口 → 侧栏 VersionHistoryPanel
// 列出快照条目;点击条目 → 编辑器区切换为 DiffView(覆盖编辑器),diff 展示
// 该版本与上一版本的行级差异;DiffView 顶部「恢复」一键还原。
//
// diff 语义(同 VSCode Local History):每个快照与它的**前一版本**做 diff,
// 而非与当前编辑器内容做 diff。前一版本 = 列表中该条目后面那个(列表倒序,
// 最新在前)。未保存条目的前一版本 = 最新已保存快照(或磁盘基线,无快照时);
// 最旧的快照无前一版本 → diff old = 空字符串(全部为新增)。
//
// 虚拟"未保存"条目:文档 dirty 时在列表头部插入 UNSAVED_ID 虚拟条目,
// content = 当前编辑器内容,不可删除 / 不可恢复。

import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useDocumentStore } from './document'
import {
  loadVersionSnapshots as loadVersionSnapshotsFromFs,
  VERSION_SNAPSHOT_CAP,
  VERSION_SNAPSHOT_MAX_AGE_DAYS,
  type VersionSnapshot,
} from './persistence'

/** 虚拟"未保存"条目 id —— 不落盘,仅在 UI 列表中展示 */
export const UNSAVED_ID = '__unsaved__'

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

  /** 虚拟"未保存"条目;dirty 时生成,代表当前编辑器内容 */
  const unsavedSnapshot = computed<VersionSnapshot | null>(() => {
    if (!documentStore.dirty) return null
    const path = documentStore.currentFilePath
    if (!path) return null
    return {
      version: 1,
      id: UNSAVED_ID,
      filePath: path,
      content: documentStore.content,
      savedAt: Date.now(),
      trigger: 'manual',
    }
  })

  /** 当前文件的展示列表 = [未保存虚拟条目?] + [磁盘快照...] */
  const displaySnapshots = computed<VersionSnapshot[] | null>(() => {
    const snaps = currentFileSnapshots.value
    if (snaps === null) return null
    const unsaved = unsavedSnapshot.value
    return unsaved ? [unsaved, ...snaps] : snaps
  })

  /** 当前选中的快照对象 */
  const selectedSnapshot = computed<VersionSnapshot | null>(() => {
    const id = selectedSnapshotId.value
    if (!id) return null
    // 虚拟条目
    if (id === UNSAVED_ID) return unsavedSnapshot.value
    const list = currentFileSnapshots.value
    if (!list) return null
    return list.find(s => s.id === id) ?? null
  })

  /** 获取某条目的前一版本内容(diff old 方)。
   *  列表倒序(最新在前),前一版本 = 该条目后面那个(idx+1)。
   *  - 未保存条目 → 最新已保存快照(无快照则磁盘基线)
   *  - 快照 idx → snaps[idx+1].content(更旧的一版)
   *  - 最旧快照(idx = last) → 空字符串(无前一版本,全部为新增) */
  function diffOldContent(snapshotId: string): string {
    const snaps = currentFileSnapshots.value
    if (!snaps) return ''
    if (snapshotId === UNSAVED_ID) {
      // 未保存条目的前一版本 = 最新已保存快照
      return snaps.length > 0 ? snaps[0].content : documentStore.lastSavedContent
    }
    const idx = snaps.findIndex(s => s.id === snapshotId)
    if (idx === -1) return ''
    if (idx + 1 < snaps.length) {
      return snaps[idx + 1].content
    }
    return ''
  }

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

  /** 保存后追加快照到内存缓存(若已加载)。
   *
   * saveDoc 写盘 + saveVersionSnapshot + pruneVersionSnapshots 之后调,
   * 把新快照 prepend 到缓存列表(保持倒序)并按 CAP + 过期天数修剪,使 UI 即时刷新。
   * 缓存未加载(null)时跳过 —— 下次打开 VersionHistoryPanel 时 loadSnapshots 从磁盘读。 */
  function appendSnapshot(filePath: string, snapshot: VersionSnapshot): void {
    const cached = snapshotsByFile.value.get(filePath)
    if (!cached) return
    const now = Date.now()
    const cutoff = now - VERSION_SNAPSHOT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    const next = [snapshot, ...cached]
      .filter(s => s.savedAt >= cutoff)
      .slice(0, VERSION_SNAPSHOT_CAP)
    snapshotsByFile.value.set(filePath, next)
  }

  /** 使所有缓存失效 */
  function invalidateAll(): void {
    snapshotsByFile.value.clear()
  }

  /** 打开版本历史:加载当前文件快照 + 选中最新一条 + 激活 diff 视图 */
  async function openVersionHistory(): Promise<void> {
    const path = documentStore.currentFilePath
    if (!path) return
    const snapshots = await loadCurrentFileSnapshots()
    // dirty 时默认选中未保存条目,否则选最新快照
    if (documentStore.dirty) {
      selectedSnapshotId.value = UNSAVED_ID
      diffViewActive.value = true
    } else if (snapshots.length > 0) {
      selectedSnapshotId.value = snapshots[0].id
      diffViewActive.value = true
    } else {
      selectedSnapshotId.value = null
      diffViewActive.value = false
    }
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
    displaySnapshots,
    unsavedSnapshot,
    selectedSnapshot,
    diffOldContent,
    VERSION_SNAPSHOT_CAP,
    UNSAVED_ID,
    loadSnapshots,
    loadCurrentFileSnapshots,
    appendSnapshot,
    invalidate,
    invalidateAll,
    openVersionHistory,
    closeDiffView,
    selectSnapshot,
  }
})
