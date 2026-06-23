// 工作区状态 store(v0.5.0):
//
// 从"单文件编辑器"跃迁到"目录级工作区"——一个工作区根 = 一个目录,
// 用户可在多个工作区间切换。store 持有:
//   - 当前活跃的工作区根路径(null = 没打开工作区,沿用 v0.4.x 单文件模式)
//   - 历史工作区列表(用于"切换工作区"下拉)
//   - 每个工作区的局部状态(展开的目录、上次打开的文件、上次的 sidebar tab)
//   - 当前侧边栏 tab('outline' | 'files')
//
// 持久化走 `persistence.ts:loadWorkspaces/saveWorkspaces`,本 store 内
// 落盘交给 App.vue 的 debounce watch(与 settings / outline 同款)。

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { open as openDialog } from '@/tauri/dialog'
import type { PersistedWorkspaces, SidebarTab, WorkspaceState } from './persistence'

function emptyWorkspaceState(): WorkspaceState {
  return { expandedDirs: [], lastFile: null, sidebarTab: 'outline' }
}

export const useWorkspaceStore = defineStore('workspace', () => {
  /** 当前活跃的工作区根路径(null = 无工作区) */
  const activeRoot = ref<string | null>(null)

  /** rootPath → 局部状态。reactive 形式,深层访问触发依赖追踪。 */
  const workspaces = ref<Record<string, WorkspaceState>>({})

  /** 当前侧边栏看的 tab。无工作区时强制 'outline'。 */
  const sidebarTab = ref<SidebarTab>('outline')

  /** 历史工作区根路径列表(派生自 workspaces 的 keys),用于切换下拉。 */
  const knownRoots = computed<string[]>(() => Object.keys(workspaces.value))

  /** 取当前工作区的局部状态;无活跃工作区返回空对象。 */
  const activeWorkspace = computed<WorkspaceState>(() => {
    if (!activeRoot.value) return emptyWorkspaceState()
    return workspaces.value[activeRoot.value] ?? emptyWorkspaceState()
  })

  function ensureWorkspace(root: string): WorkspaceState {
    if (!workspaces.value[root]) {
      workspaces.value[root] = emptyWorkspaceState()
    }
    return workspaces.value[root]
  }

  /**
   * 切换到指定工作区根。如果该 root 没记录过,初始化空状态。
   * 切换后 sidebarTab 跟着该工作区的偏好走(默认 'outline')。
   */
  function setActiveRoot(root: string | null) {
    activeRoot.value = root
    if (root) {
      const ws = ensureWorkspace(root)
      if (ws.sidebarTab) sidebarTab.value = ws.sidebarTab
    }
    else {
      // 无工作区时,文件树 tab 没有意义,回到大纲
      sidebarTab.value = 'outline'
    }
  }

  /** 弹原生目录选择对话框,选中后切到该工作区。取消返回 null。 */
  async function pickWorkspace(): Promise<string | null> {
    const selected = await openDialog({ directory: true, multiple: false })
    if (typeof selected !== 'string') return null
    setActiveRoot(selected)
    return selected
  }

  /** 关闭当前工作区,回到"无工作区"模式(仍可用单文件 open/saveAs)。 */
  function closeWorkspace() {
    setActiveRoot(null)
  }

  /**
   * 把一个目录标记为展开 / 折叠。pathSet 只为当前活跃工作区维护。
   * 无活跃工作区时静默丢弃 —— 没工作区也就没文件树展开状态。
   */
  function setDirExpanded(dirPath: string, expanded: boolean) {
    if (!activeRoot.value) return
    const ws = ensureWorkspace(activeRoot.value)
    const set = new Set(ws.expandedDirs)
    if (expanded) set.add(dirPath)
    else set.delete(dirPath)
    ws.expandedDirs = Array.from(set)
  }

  function isDirExpanded(dirPath: string): boolean {
    if (!activeRoot.value) return false
    return workspaces.value[activeRoot.value]?.expandedDirs.includes(dirPath) ?? false
  }

  /** 记录该工作区下"上次打开的文件",用于重开工作区时恢复。 */
  function setLastFile(filePath: string | null) {
    if (!activeRoot.value) return
    const ws = ensureWorkspace(activeRoot.value)
    ws.lastFile = filePath
  }

  function setSidebarTab(tab: SidebarTab) {
    sidebarTab.value = tab
    if (activeRoot.value) {
      const ws = ensureWorkspace(activeRoot.value)
      ws.sidebarTab = tab
    }
  }

  /** 启动时从磁盘灌入(覆盖现有) */
  function loadFrom(data: PersistedWorkspaces) {
    workspaces.value = { ...data.workspaces }
    if (data.active && workspaces.value[data.active]) {
      setActiveRoot(data.active)
    }
    else {
      setActiveRoot(null)
    }
  }

  /** 落盘前取全量深拷贝,防止后续 mutation 渗到快照。 */
  function snapshot(): PersistedWorkspaces {
    const ws: Record<string, WorkspaceState> = {}
    for (const [k, v] of Object.entries(workspaces.value)) {
      ws[k] = {
        expandedDirs: [...v.expandedDirs],
        lastFile: v.lastFile ?? null,
        sidebarTab: v.sidebarTab,
      }
    }
    return {
      version: 1,
      active: activeRoot.value,
      workspaces: ws,
    }
  }

  return {
    activeRoot,
    workspaces,
    sidebarTab,
    knownRoots,
    activeWorkspace,
    setActiveRoot,
    pickWorkspace,
    closeWorkspace,
    setDirExpanded,
    isDirExpanded,
    setLastFile,
    setSidebarTab,
    loadFrom,
    snapshot,
  }
})
