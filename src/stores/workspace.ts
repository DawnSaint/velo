// 工作区状态 store(v0.5.0):
//
// 从"单文件编辑器"跃迁到"目录级工作区"——一个工作区根 = 一个目录,
// 用户可在多个工作区间切换。store 持有:
//   - 当前活跃的工作区根路径(null = 没打开工作区,沿用 v0.4.x 单文件模式)
//   - 历史工作区列表(用于"切换工作区"下拉)
//   - 每个工作区的局部状态(展开的目录、上次打开的文件、上次的 sidebar tab)
//   - 当前侧边栏 tab('outline' | 'files')
//   - 当前侧栏宽度(v0.5.5;按 workspace 持久化,跟 sidebarTab 同语义)
//
// 持久化走 `persistence.ts:loadWorkspaces/saveWorkspaces`,本 store 内
// 落盘交给 App.vue 的 debounce watch(与 settings / outline 同款)。

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { open as openDialog } from '@/tauri/dialog'
import type { PersistedWorkspaces, SidebarTab, WorkspaceState, WorkspacePatch } from './persistence'

/** 侧栏宽度常量(v0.5.5)。在 store clamp 与 composable clamp 双处用到,
 *  与 plan「关键复用」一节对应;暴露为 named export 供 App.vue 直接 import,
 *  不在 UI 层重写一遍数字。
 *
 *  **双阈值(v0.5.5 后期调整)**:A = DRAG_COLLAPSE_BELOW(80,左阈值,拖到此处及以下收起),
 *  B = SIDEBAR_WIDTH_MIN(200,右阈值,稳定下限)。[A, B] 是死区 —— 拖到这个范围时
 *  视觉宽度 snap 到 B,不会显示 80-200 之间的瞬时值(避免用户报告的"线从中间位置
 *  开始动"的视觉错位)。这两个数字由 App.vue 通过 DRAG_COLLAPSE_BELOW / SIDEBAR_WIDTH_MIN
 *  各自引用。 */
export const SIDEBAR_WIDTH_MIN = 200
export const SIDEBAR_WIDTH_MAX = 600
export const SIDEBAR_WIDTH_DEFAULT = 256

function clampSidebarWidth(n: number): number {
  if (Number.isNaN(n)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(n)))
}

function isPathInRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root + '/') || path.startsWith(root + '\\')
}

function emptyWorkspaceState(): WorkspaceState {
  // openTabs 不给默认:不持久化"未开任何标签"和"开过标签已全部关闭"是两种状态,
  // 让 normalize 时回退到 [] 已足够,这里不显式写入,保持 mock 数据紧凑。
  return { expandedDirs: [], lastFile: null, sidebarTab: 'outline', recentFiles: [], sidebarWidth: SIDEBAR_WIDTH_DEFAULT }
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

  /** 当前激活 workspace 的侧栏宽度(px,v0.5.5)。切换 workspace 时由 setActiveRoot 同步。
   *  暴露给 UI/App.vue 直接渲染 aside 宽度;持久化由 activeWorkspace.sidebarWidth 承担。 */
  const sidebarWidth = ref<number>(SIDEBAR_WIDTH_DEFAULT)

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
   * **sidebarTab 行为(沿用旧语义)**:用户主动切工作区时,保留当前 UI tab,
   * 同步写到新 workspace —— 用户在哪个 tab 是他当下的偏好,新工作区继承。
   * 启动期持久化 tab 由 `loadFrom` 应用,见下方。
   *
   * **sidebarWidth 行为(v0.5.5,READ 语义)**:从新 workspace 读它的 width
   * 到 top-level,而不是把当前 top-level 写过去。两点取舍:
   *   - per-workspace 持久化要求每个工作区保留自己的宽度;
   *     切到新 workspace 不应被其他 workspace 的 UI 状态覆盖
   *     (round-trip 测试明确依赖此行为)。
   *   - 新 workspace 走 default 256,符合"无偏好就用默认"。
   * 如果未来要让新 workspace 继承当前 UI 宽度,改此处即可,但要和
   * 文档「文档同步」一节同步说明。
   *
   * root=null(关闭工作区)时强制 'outline':无工作区时 'files' tab 没意义
   * (FileTree 渲染空态按钮),回到 outline 是派生约束。sidebarWidth 保留
   * (下次切回任何 workspace 时不会闪)。
   */
  function setActiveRoot(root: string | null) {
    activeRoot.value = root
    if (root) {
      const ws = ensureWorkspace(root)
      ws.sidebarTab = sidebarTab.value
      sidebarWidth.value = ws.sidebarWidth ?? SIDEBAR_WIDTH_DEFAULT
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
    if (filePath && !isPathInRoot(filePath, activeRoot.value)) return
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
  /** 记录当前窗口的 openTabs + activeTab 到 active workspace。
   *  只在有 activeRoot 时生效(切回 root=null 也 no-op,不清空,
   *  与 sidebarTab / sidebarWidth 同款语义)。
   *  跨 root 的 path 自动过滤,避免"用户从 /A 工作区切到 /B 后
   *  /A 的文件路径被错误写到 /B"——App.vue 的 watcher 会传当前全部
   *  openFilePaths,store 内部按 activeRoot 裁剪。
   *  启动恢复(openPathInTab)走这套;空数组写回空数组,启动时
   *  不会误以为 openTabs 存在 vs 缺失。 */
  /** 持久化 openTabs 容量上限。
   *  openFilePaths 含重复项(`openPathInNewTab` 中键强制新开,UI 允许同 path 多 tab),
   *  但持久化层面需要 dedupe + cap 防止:
   *    1) 历史 velo-workspaces.json 已被污染(同一 path 出现 N 次)时,启动恢复
   *       `openPathsInTabs` 会把每条都 createTab → 桌面同时挂 N 个 tab → 主线程
   *       被渲染拖死;
   *    2) 用户中键狂点单个文件时,openTabs 持续 append 同一 path,落盘文件无界增长
   *       (虽然 setOpenTabsForActiveWorkspace 是 replace,但 dedupe 前每一份
   *       含重复项的 openFilePaths 落盘后会污染 velo-workspaces.json,
   *       下次启动被 openPathsInTabs 读取时再次爆炸)。
   *  50 = VSCode 同档体感,够实际用又不会失控。 */
  const OPEN_TABS_PERSIST_CAP = 50

  /** 数组去重保插入序(基础工具)。Set 写法在 V8 上对小数组够用,
   *  不为这条单独引入 lodash。 */
  function dedupePreserveOrder(arr: string[]): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const item of arr) {
      if (typeof item !== 'string' || seen.has(item)) continue
      seen.add(item)
      out.push(item)
    }
    return out
  }

  function setOpenTabsForActiveWorkspace(openTabs: string[], activeTabPath: string | null) {
    if (!activeRoot.value) return
    const root = activeRoot.value
    // 跨 root 过滤 → dedupe 保插入序(防中键狂点同一文件把同一 path
    // 重复落盘)→ cap 兜底(防 velo-workspaces.json 被污染后下次启动爆炸)。
    // 注意:openFilePaths 本身允许同 path 多 tab(openPathInNewTab 强制新开是显式语义),
    // 持久化层面丢重复项是**有意为之**——持久化只用于"重开工作区时恢复上次的标签集",
    // 重开不期望看到 5 个相同 .md 各占一个 tab,VSCode 重开也是按 path 去重。
    const filteredTabs = dedupePreserveOrder(
      (openTabs ?? []).filter(p => typeof p === 'string' && isPathInRoot(p, root)),
    ).slice(0, OPEN_TABS_PERSIST_CAP)
    const filteredActive = activeTabPath && isPathInRoot(activeTabPath, root) ? activeTabPath : null
    const ws = ensureWorkspace(root)
    ws.openTabs = filteredTabs
    ws.activeTab = filteredActive
  }

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
    // openTabs / activeTab 走同款重写:文件被外部 mv 之后,持久化路径同步更新,
    // 否则下次重启按旧路径 openPathInTab 会失败(白跳一个 tab)。
    if (ws.openTabs?.length) {
      ws.openTabs = ws.openTabs.map((p) => {
        if (p === oldPath) return newPath
        if (p.startsWith(oldSep1) || p.startsWith(oldSep2)) return newPath + p.slice(oldPath.length)
        return p
      })
    }
    const at = ws.activeTab
    if (at === oldPath) ws.activeTab = newPath
    else if (at && (typeof at === 'string') && (at.startsWith(oldSep1) || at.startsWith(oldSep2))) {
      ws.activeTab = newPath + at.slice(oldPath.length)
    }
  }

  function removePathPrefix(pathPrefix: string) {
    if (!activeRoot.value) return
    const ws = ensureWorkspace(activeRoot.value)
    ws.expandedDirs = ws.expandedDirs.filter(d => !isPathInRoot(d, pathPrefix))
    if (ws.lastFile && isPathInRoot(ws.lastFile, pathPrefix)) ws.lastFile = null
    if (ws.recentFiles?.length) {
      ws.recentFiles = ws.recentFiles.filter(p => !isPathInRoot(p, pathPrefix))
    }
    // openTabs / activeTab 同款裁剪(目录被删 → 落入该目录的 tab 文件也已无法恢复)。
    if (ws.openTabs?.length) {
      ws.openTabs = ws.openTabs.filter(p => !isPathInRoot(p, pathPrefix))
    }
    if (ws.activeTab && isPathInRoot(ws.activeTab as string, pathPrefix)) ws.activeTab = null
  }

  function setSidebarTab(tab: SidebarTab) {
    sidebarTab.value = tab
    if (activeRoot.value) {
      const ws = ensureWorkspace(activeRoot.value)
      ws.sidebarTab = tab
    }
  }

  /** 侧栏宽度变更(v0.5.5):clamp 到 [SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX],
   *  写 top-level ref 驱动 UI,同时持久化到当前 workspace。无活跃工作区时
   *  top-level ref 仍更新(下次切回该 workspace 时 hydrate),但不写持久化
   *  —— 与 setDirExpanded 同款"无工作区 no-op"语义。 */
  function setSidebarWidth(width: number) {
    // 单一阈值语义:[SIDEBAR_WIDTH_MIN, MAX] 都是合法稳定值;
    // App.vue 的 onCommit 已经先判了 `n >= SIDEBAR_WIDTH_MIN` 才调本函数,
    // 这里 clamp 是双层防御(防止其它调用点 / 旧 JSON 直接传 < MIN 的值)。
    const clamped = clampSidebarWidth(width)
    sidebarWidth.value = clamped
    if (activeRoot.value) {
      const ws = ensureWorkspace(activeRoot.value)
      ws.sidebarWidth = clamped
    }
  }

  function normalizeWorkspaceState(v: WorkspaceState): WorkspaceState {
    return {
      expandedDirs: [...(v.expandedDirs ?? [])],
      lastFile: v.lastFile ?? null,
      sidebarTab: v.sidebarTab ?? 'outline',
      recentFiles: [...(v.recentFiles ?? [])],
      sidebarWidth: v.sidebarWidth ?? SIDEBAR_WIDTH_DEFAULT,
      // v3 JSON 无 openTabs 时给空数组;无 activeTab 时给 null。openTabs 与
      // expandedDirs / recentFiles 同款"以数组形式持久化"。
      // 启动恢复阶段也走 dedupe + cap(via setOpenTabsForActiveWorkspace 的兜底):
      // 历史 v4 JSON 已被污染(同 path 出现 N 次)时,normalize 直接清洗,避免
      // openPathsInTabs 拿到脏数据后批量 createTab 把主线程拖死。
      openTabs: Array.isArray(v.openTabs) ? dedupePreserveOrder(v.openTabs).slice(0, OPEN_TABS_PERSIST_CAP) : [],
      activeTab: typeof v.activeTab === 'string' ? v.activeTab : null,
    }
  }

  /** 启动时从磁盘灌入(覆盖现有)。**只有 restoreActive=true 的路径**会把持久化的
   *  sidebarTab / sidebarWidth 应用到当前 UI;动态窗口只加载 known roots 和 per-root state。 */
  function loadFrom(data: PersistedWorkspaces, options: { restoreActive?: boolean } = {}) {
    const restoreActive = options.restoreActive ?? true
    // 旧 JSON 可能没有 recentFiles / sidebarWidth 字段,统一兜底,免得调用方需要判 undefined
    const ws: Record<string, WorkspaceState> = {}
    for (const [k, v] of Object.entries(data.workspaces)) {
      ws[k] = normalizeWorkspaceState(v)
    }
    workspaces.value = ws
    if (restoreActive && data.active && workspaces.value[data.active]) {
      activeRoot.value = data.active
      const w = workspaces.value[data.active]
      if (w.sidebarTab) sidebarTab.value = w.sidebarTab
      if (typeof w.sidebarWidth === 'number') sidebarWidth.value = w.sidebarWidth
    }
    else if (restoreActive) {
      setActiveRoot(null)
    }
    else {
      activeRoot.value = null
      sidebarTab.value = 'outline'
      sidebarWidth.value = SIDEBAR_WIDTH_DEFAULT
    }
  }

  function snapshotWorkspaceState(v: WorkspaceState): WorkspaceState {
    return normalizeWorkspaceState(v)
  }

  function snapshotActiveForPersistence(): WorkspacePatch {
    const active = activeRoot.value
    return {
      active,
      workspaces: active && workspaces.value[active]
        ? { [active]: snapshotWorkspaceState(workspaces.value[active]) }
        : {},
    }
  }

  /** 落盘前取全量深拷贝,防止后续 mutation 渗到快照。 */
  function snapshot(): PersistedWorkspaces {
    const ws: Record<string, WorkspaceState> = {}
    for (const [k, v] of Object.entries(workspaces.value)) {
      ws[k] = snapshotWorkspaceState(v)
    }
    return {
      version: 3,
      active: activeRoot.value,
      workspaces: ws,
    }
  }

  return {
    activeRoot,
    workspaces,
    sidebarTab,
    sidebarWidth,
    knownRoots,
    activeWorkspace,
    setActiveRoot,
    pickWorkspace,
    closeWorkspace,
    setDirExpanded,
    isDirExpanded,
    setLastFile,
    setOpenTabsForActiveWorkspace,
    renamePathPrefix,
    removePathPrefix,
    setSidebarTab,
    setSidebarWidth,
    loadFrom,
    snapshot,
    snapshotActiveForPersistence,
  }
})
