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
  return { expandedDirs: [], lastFile: null, sidebarTab: 'outline', recentFiles: [] }
}

/** 最近打开文件列表上限。VSCode 同款体量,够 Ctrl+P 面板用又不至于把"其他"区挤掉。 */
const RECENT_FILES_CAP = 10

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
   *
   * **不动 sidebarTab**:用户主动切工作区时(顶栏"打开文件夹"按钮 / 二次启动
   * dir argv / pickWorkspace),保留当前 UI tab 状态,让 tab 选择贯穿切换。
   * 启动期恢复持久化 tab 走 `loadFrom`,自己读 ws.sidebarTab 应用。
   * 把当前 tab 同步写回新 workspace 记忆,这样下次启动重开该工作区时
   * 恢复到同一 tab(语义闭环:用户切到新工作区那一刻的 UI 状态被持久化)。
   *
   * root=null(关闭工作区)时强制 'outline':无工作区时 'files' tab 没意义
   * (FileTree 渲染空态按钮),回到 outline 是派生约束。
   */
  function setActiveRoot(root: string | null) {
    activeRoot.value = root
    if (root) {
      const ws = ensureWorkspace(root)
      ws.sidebarTab = sidebarTab.value
    }
    else {
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

  /** 记录该工作区下"上次打开的文件",用于重开工作区时恢复。
   *  同时推到 recentFiles 头部 —— Ctrl+P 双分区"最近打开"段从这里读。
   *  path=null(关闭文件 / 新建未保存)不入 recent。 */
  function setLastFile(filePath: string | null) {
    if (!activeRoot.value) return
    const ws = ensureWorkspace(activeRoot.value)
    ws.lastFile = filePath
    if (filePath) pushRecentFile(filePath)
  }

  /** 把 filePath 推入当前工作区 recentFiles 头部:dedupe(同路径删旧位)+ unshift + cap.
   *  无活跃工作区 no-op。直接对外暴露也无害,但目前只有 setLastFile 内部调用. */
  function pushRecentFile(filePath: string) {
    if (!activeRoot.value) return
    const ws = ensureWorkspace(activeRoot.value)
    const list = (ws.recentFiles ?? []).filter(p => p !== filePath)
    list.unshift(filePath)
    if (list.length > RECENT_FILES_CAP) list.length = RECENT_FILES_CAP
    ws.recentFiles = list
  }

  /**
   * 把 oldPath 在工作区局部状态里出现的位置(expandedDirs / lastFile)
   * 全量改成 newPath。文件树跨目录拖拽 move(v0.5.1)用 —— 同盘 mv 完成后
   * 工作区记忆里所有以 oldPath 为前缀的展开目录 / lastFile 都失效,
   * 必须前缀重写,否则下次重开工作区拿旧路径恢复展开 → 节点早已不存在,
   * isDirExpanded 命中后 readDir 抛错(目录消失),整树降级到只展开根。
   *
   * 双分隔符判定(/ + \)避免引入 `sep()` 异步调用;旧值末尾 + 分隔符判 prefix,
   * 保证 `/a/b1` 不会被 `/a/b` 匹中。
   */
  function renamePathPrefix(oldPath: string, newPath: string) {
    if (!activeRoot.value) return
    if (oldPath === newPath) return
    const ws = ensureWorkspace(activeRoot.value)
    const oldSep1 = oldPath + '/'
    const oldSep2 = oldPath + '\\'
    ws.expandedDirs = ws.expandedDirs.map((d) => {
      if (d === oldPath) return newPath
      if (d.startsWith(oldSep1) || d.startsWith(oldSep2)) return newPath + d.slice(oldPath.length)
      return d
    })
    const lf = ws.lastFile
    if (lf === oldPath) ws.lastFile = newPath
    else if (lf && (lf.startsWith(oldSep1) || lf.startsWith(oldSep2))) {
      ws.lastFile = newPath + lf.slice(oldPath.length)
    }
    // recentFiles 同样需要前缀重写,否则 Ctrl+P 双分区里的"最近"项指向死路径
    if (ws.recentFiles?.length) {
      ws.recentFiles = ws.recentFiles.map((p) => {
        if (p === oldPath) return newPath
        if (p.startsWith(oldSep1) || p.startsWith(oldSep2)) return newPath + p.slice(oldPath.length)
        return p
      })
    }
  }

  function setSidebarTab(tab: SidebarTab) {
    sidebarTab.value = tab
    if (activeRoot.value) {
      const ws = ensureWorkspace(activeRoot.value)
      ws.sidebarTab = tab
    }
  }

  /** 启动时从磁盘灌入(覆盖现有)。**只有这条路径**会把持久化的 sidebarTab
   *  应用到当前 UI —— 用户主动切工作区由 setActiveRoot 保留当前 tab。 */
  function loadFrom(data: PersistedWorkspaces) {
    // 旧 JSON 可能没有 recentFiles 字段,统一兜底为空数组,免得调用方需要判 undefined
    const ws: Record<string, WorkspaceState> = {}
    for (const [k, v] of Object.entries(data.workspaces)) {
      ws[k] = { ...v, recentFiles: v.recentFiles ?? [] }
    }
    workspaces.value = ws
    if (data.active && workspaces.value[data.active]) {
      activeRoot.value = data.active
      const w = workspaces.value[data.active]
      if (w.sidebarTab) sidebarTab.value = w.sidebarTab
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
        recentFiles: [...(v.recentFiles ?? [])],
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
    pushRecentFile,
    renamePathPrefix,
    setSidebarTab,
    loadFrom,
    snapshot,
  }
})
