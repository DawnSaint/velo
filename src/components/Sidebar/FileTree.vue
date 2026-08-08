<script setup lang="ts">
// 文件树 UI 组件(v0.5.0)。
// 数据 / IO → useTreeData,纯函数 → treeUtils,
// 拖拽 → useDragMove,行内编辑 → useInlineEdit,
// 虚拟滚动 → useVirtualScroll,复制粘贴 → useCopyPaste,
// 根行按钮 → RootActionButtons。本文件只剩 UI 状态机 + 事件接线 + 模板。

import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch, type CSSProperties } from 'vue'
import { ChevronRight, File, Image } from '@lucide/vue'
import { remove as fsRemove } from '@/tauri/fs'
import { join, sep } from '@/tauri/path'
import { confirm as nativeConfirm } from '@/tauri/dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { tauriOnly } from '@/tauri/fs'
import { newAppWindow } from '@/tauri/window'
import { useWorkspaceStore } from '@/stores/workspace'
import { useRecentFilesStore } from '@/stores/recentFiles'
import { useDocumentStore } from '@/stores/document'
import { useNotifyStore } from '@/stores/notify'
import { useContextMenu, clampToViewport } from '@/composables/useContextMenu'
import FileTreeContextMenu from './FileTreeContextMenu.vue'
import RootActionButtons from './RootActionButtons.vue'
import { useTreeData, type TreeNode } from './useTreeData'
import { useDragMove } from './useDragMove'
import { useInlineEdit } from './useInlineEdit'
import { useVirtualScroll, type VisualItem } from './useVirtualScroll'
import { useCopyPaste } from './useCopyPaste'
import {
  MD_EXT_RE,
  basename,
  formatFsError,
  isImageName,
  parentDirOfPath,
} from './treeUtils'

const workspace = useWorkspaceStore()
const recentFiles = useRecentFilesStore()
const documentStore = useDocumentStore()
const notify = useNotifyStore()

const { rootNode, dirIndex, rebuildFromRoot, loadDirChildren, refreshDir, pruneDirIndexPrefix } = useTreeData()

/** 根节点折叠态(v0.5.1+,组件本地状态):
 *  - 不持久化 —— 切工作区 / 重启都视觉默认展开,折叠是临时 UI 操作
 *  - 切工作区时(activeRoot 变化)显式重置 false,因为 FileTree 不会被 unmount/remount,
 *    rebuildFromRoot 之后用户期望看到新工作区展开状态,而不是从上一个工作区继承折叠
 *  - 折叠后 flatItems 只渲染根 row 自身,子目录 / inline new / 空目录占位全跳过 */
const rootCollapsed = ref(false)

watch(() => workspace.activeRoot, (r) => {
  rootCollapsed.value = false
  void rebuildFromRoot(r)
}, { immediate: true })

function isRootNode(node: TreeNode): boolean {
  return workspace.activeRoot !== null && node.fullPath === workspace.activeRoot
}

const rootDisplay = computed(() => {
  const r = workspace.activeRoot
  if (!r) return ''
  const s = sep()
  const trimmed = r.endsWith(s) ? r.slice(0, -s.length) : r
  return basename(trimmed) || trimmed
})

// ========== 右键菜单状态 ==========
// 早于 composables 定义:useInlineEdit / useDragMove / useCopyPaste 都需要 closeContextMenu 回调。

interface ContextMenuState {
  node: TreeNode
  /** 视口坐标,fixed 定位用 */
  x: number
  y: number
  /** true = 容器空白处右键,语义"在根目录操作",菜单仅显示新建项(无重命名 / 删除 / reveal) */
  rootContext?: boolean
}
const contextMenu = ref<ContextMenuState | null>(null)
const contextMenuRef = ref<InstanceType<typeof FileTreeContextMenu> | null>(null)

function closeContextMenu() {
  contextMenu.value = null
}

useContextMenu({
  isOpen: () => contextMenu.value !== null,
  getMenuEl: () => contextMenuRef.value?.rootEl ?? null,
  close: () => { contextMenu.value = null },
})

// ========== composables ==========

const {
  inlineNew, inlineRename,
  bindInlineInputEl,
  openInlineNew, openInlineRename, cancelInline, submitInline,
} = useInlineEdit({ dirIndex, loadDirChildren, closeContextMenu })

const {
  dragOverTarget, clearHoverExpandTimer,
  onRowDragStart, onRowDragOver, onRowDrop,
  onContainerDragOver, onContainerDrop, onGlobalDragEnd,
} = useDragMove({ dirIndex, loadDirChildren, pruneDirIndexPrefix, rootCollapsed, isRootNode, closeContextMenu, cancelInline })

const { clipboard, copyNode, pasteInto } = useCopyPaste({ dirIndex, loadDirChildren, closeContextMenu })

// ========== flatItems:渲染拍平,免递归组件 ==========
//
// inlineNew 项混在 flatItems 里(在目标目录子树末尾追加一个 input 行);
// 模板用 v-if 分支区分普通行 / 行内新建 / 行内重命名。

const flatItems = computed<VisualItem[]>(() => {
  const out: VisualItem[] = []
  if (!rootNode.value) return out
  const inline = inlineNew.value
  // 根节点作为 depth=0 第一行进入树本身(v0.5.1):允许右键 / 显示与子目录一致的图标。
  // expanded = !rootCollapsed,折叠时下面的 children walk 跳过 → 只保留根 row 自身。
  const rootExpanded = !rootCollapsed.value
  out.push({ kind: 'node', node: rootNode.value, depth: 0, expanded: rootExpanded })
  if (!rootExpanded) return out
  function walk(children: TreeNode[] | undefined, depth: number) {
    if (!children) return
    for (const c of children) {
      const expanded = c.isDir && workspace.isDirExpanded(c.fullPath)
      out.push({ kind: 'node', node: c, depth, expanded })
      if (expanded && c.children) walk(c.children, depth + 1)
      if (inline && c.isDir && c.fullPath === inline.parentDir) {
        out.push({ kind: 'inlineNew', parentDir: c.fullPath, depth: depth + 1, subKind: inline.kind })
      }
    }
  }
  walk(rootNode.value.children, 1)
  if (inline && rootNode.value.fullPath === inline.parentDir) {
    out.push({ kind: 'inlineNew', parentDir: rootNode.value.fullPath, depth: 1, subKind: inline.kind })
  }
  return out
})

const {
  ROW_HEIGHT, scrollContainerRef, stickyHeaders, visibleRange, visibleItems,
  onScroll, updateViewport, stickyIsExpanded, stickyDisplayName, cancelRaf, reset,
} = useVirtualScroll({ flatItems, rootCollapsed, isRootNode, rootDisplay })

// ========== 目录展开 / 文件点击 ==========

/** 用户点击展开 / 折叠目录:同步持久化 + 懒加载子。
 *  根节点走 rootCollapsed(组件本地态,不持久化),不走 workspace.expandedDirs。 */
async function toggleDir(node: TreeNode) {
  if (!node.isDir) return
  if (isRootNode(node)) {
    rootCollapsed.value = !rootCollapsed.value
    return
  }
  const wasExpanded = workspace.isDirExpanded(node.fullPath)
  workspace.setDirExpanded(node.fullPath, !wasExpanded)
  if (!wasExpanded && node.children === undefined) {
    await loadDirChildren(node)
  }
}

async function onFileClick(node: TreeNode) {
  if (node.isDir) {
    await toggleDir(node)
    return
  }
  if (!MD_EXT_RE.test(node.name)) return
  const ok = await documentStore.openPathInTab(node.fullPath)
  if (!ok) return
  workspace.setLastFile(node.fullPath)
}

/** 文件行中键点击(auxclick.middle):与 click 不同,**始终**在新标签打开 —— 即便该
 *  path 已被打开过也强制再开一个标签(VSCode 资源管理器中键行为)。允许同一文件
 *  在多个标签中并存,各自独立 undo / 滚动 / 光标(每标签 EditorState 缓存)。
 *
 *  - 目录 / 非 .md 文件 / 根行:no-op(目录不存在"打开新标签"语义;图片打开走拖拽
 *    到编辑器或 ImagePastePlugin,不在这里重复实现)。
 *  - 与 click 同款 setLastFile:打开仍是"用户意图最近"信号,工作区重开恢复最近文件
 *    不区分开标签方式,避免 click / middle-click 之间产生"最近"分歧。 */
async function onRowAuxClick(node: TreeNode) {
  if (node.isDir) return
  if (!MD_EXT_RE.test(node.name)) return
  const ok = await documentStore.openPathInNewTab(node.fullPath)
  if (!ok) return
  workspace.setLastFile(node.fullPath)
}

defineExpose({ refreshDir, rebuildFromRoot, revealFile })

const activeFile = computed(() => documentStore.currentFilePath)

// ========== indentStyle ==========

// 按 depth 缓存 indentStyle:同 depth → 同对象引用 → Vue patch 跳过 style 更新,
// 避免每行每次重渲都重新拼接 gradient 字符串。
const indentStyleCache = new Map<number, CSSProperties>()

function indentStyle(depth: number): CSSProperties {
  const cached = indentStyleCache.get(depth)
  if (cached) return cached
  // 层级指示线:每个深度画一条 1px 竖线,对齐祖先行 chevron 图标的中心(12*i+8)。
  // 用 background-image (solid color) + background-size:1px 100% + background-position
  // 而非 gradient 硬停止 —— 后者在 transparent↔color 同位置切换时会被浏览器抗锯齿,
  // 不同 x 位置因子像素对齐差异导致线条视觉粗细不一。
  const images: string[] = []
  const sizes: string[] = []
  const positions: string[] = []
  for (let i = 1; i <= depth; i++) {
    const x = 12 * i + 8
    images.push('linear-gradient(var(--surface-border), var(--surface-border))')
    sizes.push('1px 100%')
    positions.push(`${x}px 0`)
  }
  const result: CSSProperties = {
    paddingLeft: `${12 + depth * 12}px`,
    ...(images.length && {
      backgroundImage: images.join(', '),
      backgroundSize: sizes.join(', '),
      backgroundPosition: positions.join(', '),
      backgroundRepeat: 'no-repeat',
    }),
  }
  indentStyleCache.set(depth, result)
  return result
}

async function chooseWorkspace() {
  await workspace.pickWorkspace()
}

// ========== 容器空白双击 → 根目录新建 MD(v0.5.1)==========
//
// 对齐 VSCode "EXPLORER 面板空白处双击新建文件"。`@dblclick.self` 让
// 事件只在容器自身命中(子行有自己的 click,不会冒泡触发);若有行内
// input 或菜单激活则不打断(由 openInlineNew 内部 closeContextMenu /
// inlineRename=null 兜底)。无活跃工作区时静默丢弃 —— UI 空态此时显示
// "打开一个文件夹作为工作区"按钮,空白容器根本不渲染。
function onContainerDblClick() {
  if (!workspace.activeRoot) return
  void openInlineNew(workspace.activeRoot, 'newFile')
}

// ========== 根行工具按钮状态 ==========

/** 全部折叠:清空所有子目录展开状态,根保持展开(用户仍可见顶层文件)。 */
function collapseAll() {
  const root = workspace.activeRoot
  if (!root) return
  const ws = workspace.workspaces[root]
  if (ws) {
    for (const d of [...ws.expandedDirs]) workspace.setDirExpanded(d, false)
  }
  rootCollapsed.value = false
}

/** 鼠标是否悬停在工作区文件列表区域 → 控制根行工具按钮的显隐 */
const workspaceHovered = ref(false)

/** 刷新按钮状态:idle → loading(旋转)→ success(✓)→ idle */
const refreshState = ref<'idle' | 'loading' | 'success'>('idle')
let refreshTimer: ReturnType<typeof setTimeout> | null = null

/** 刷新工作区根:重新读取根目录子项。保证最小 500ms 旋转可见,完成后闪✓,延时恢复。 */
async function refreshRoot() {
  if (refreshState.value !== 'idle') return
  if (!workspace.activeRoot) return
  refreshState.value = 'loading'
  try {
    await Promise.all([
      refreshDir(workspace.activeRoot),
      new Promise(resolve => setTimeout(resolve, 500)),
    ])
  }
  finally {
    refreshState.value = 'success'
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => { refreshState.value = 'idle' }, 1200)
  }
}

// ========== 右键菜单触发 ==========

function onRowContextMenu(event: MouseEvent, node: TreeNode) {
  event.preventDefault()
  const { x, y } = clampToViewport(event.clientX, event.clientY, 160, 220)
  // 根节点:走"根上下文"——只显示新建项,不暴露重命名 / 删除 / reveal / 作为工作区打开
  // (与空白处右键统一)。重命名 / 删除根直接破坏工作区,reveal 根价值低于走系统标题栏。
  if (isRootNode(node)) {
    contextMenu.value = { node, x, y, rootContext: true }
  }
  else {
    contextMenu.value = { node, x, y }
  }
  cancelInline()
}

// ========== 容器空白处右键 → 根目录上下文菜单(v0.5.1)==========
//
// 语义:文件树空白处右键 = 在工作区根操作。只保留"新建文件 / 新建文件夹"——
// 重命名 / 删除 / reveal / "在新窗口中打开" / "在编辑器中打开" 对根都无意义
// (根 row 本身不弹菜单,空白菜单与之对齐:工作区根上不暴露这些操作)。
// `@contextmenu.self` 确保只在容器自身命中,子行的右键继续走 onRowContextMenu。
function onContainerContextMenu(event: MouseEvent) {
  if (!workspace.activeRoot || !rootNode.value) return
  event.preventDefault()
  const { x, y } = clampToViewport(event.clientX, event.clientY, 160, 220)
  contextMenu.value = { node: rootNode.value, x, y, rootContext: true }
  cancelInline()
}

/** 「新建 X」的目标目录:目录节点 = 自身;文件节点 = 父目录(创建兄弟项)。 */
function targetDirForNew(node: TreeNode): string {
  return node.isDir ? node.fullPath : parentDirOfPath(node.fullPath)
}

// ========== 删除 + 联动当前打开文件 ==========

/** pathToDelete 是否包含任意打开标签的路径(多标签下查全部标签,非仅活动)。 */
function deleteContainsOpenFile(pathToDelete: string): boolean {
  return documentStore.countOpenTabsUnder(pathToDelete) > 0
}

async function confirmAndDelete(node: TreeNode) {
  const isDir = node.isDir
  const name = node.name
  let message: string
  if (isDir) {
    const dirtyOpen = documentStore.countDirtyTabsUnder(node.fullPath)
    message = dirtyOpen > 0
      ? `「${name}」中有 ${dirtyOpen} 个正在编辑且未保存的文件,删除后修改将丢失。\n确定要继续吗？`
      : `确定要删除目录「${name}」及其所有内容吗？`
  }
  else {
    const dirtyOpen = documentStore.countDirtyTabsUnder(node.fullPath)
    message = dirtyOpen > 0
      ? `「${name}」有未保存修改,删除后修改将丢失。\n确定要继续吗？`
      : `确定要删除「${name}」吗？`
  }
  const ok = await nativeConfirm(message, { title: '确认删除', kind: 'warning' })
  if (!ok) return
  const parentDir = parentDirOfPath(node.fullPath)
  try {
    await fsRemove(node.fullPath, { recursive: isDir })
    // 内部删除是强失效信号:清理工作区与全局最近文件里的死路径
    workspace.removePathPrefix(node.fullPath)
    recentFiles.removePathPrefix(node.fullPath)
    // children 更新 + 联动关闭文件同 microtask
    const parent = dirIndex.get(parentDir)
    if (parent) await loadDirChildren(parent)
    if (deleteContainsOpenFile(node.fullPath)) {
      // 多标签:删除路径下的所有标签(含活动标签);不弹脏盘确认 —— 删除已在外层 confirm
      await documentStore.closeTabsUnderPath(node.fullPath)
    }
    closeContextMenu()
  }
  catch (e) {
    notify.error(formatFsError(e, '删除失败'))
  }
}

// ========== 在资源管理器中显示 ==========

async function revealInExplorer(node: TreeNode) {
  try { await revealItemInDir(node.fullPath) }
  catch (e) {
    notify.error(formatFsError(e, '打开文件管理器失败'))
  }
  finally { closeContextMenu() }
}

// ========== 外部 reveal:在文件树中高亮某文件(v0.6.x 标签菜单用)==========
//
// 入口:App.vue 收 TabBar 的 reveal-in-tree emit → workspaceStore.setSidebarTab('files')
// + sidebarRef.revealFile(path)。这里逐级 setDirExpanded + loadDirChildren(必要时)
// 把父目录全部打开,等到 nextTick 后用 [title="<fullPath>"] 精确定位 row,
// scrollIntoView + 短暂 .reveal-flash 蓝高亮。
//
// 边界:
//  - path 不在工作区根下 → 直接 return(外部应在 TabContextMenu 已过滤,但兜底)
//  - path === root → 滚动到根 row
//  - 任意父目录 loadDirChildren 抛错 → 静默继续(高亮仍可能在已加载的祖先上生效)
//  - DOM 未找到 → 静默 no-op(罕见:用户已经把这文件从树里删了)

const treeRootRef = ref<HTMLDivElement | null>(null)

/** 把 path 在文件树中高亮定位。已展开 / 已加载的子树无副作用。
 *  flash=true(默认)加短暂蓝高亮;flash=false 仅展开目录 + 滚动定位,不闪。 */
async function revealFile(filePath: string, options?: { flash?: boolean }): Promise<void> {
  const root = workspace.activeRoot
  if (!root) return
  if (filePath !== root && !filePath.startsWith(root + '/') && !filePath.startsWith(root + '\\')) return

  // root 自身作为 flatItems depth=0 的一行:它不依赖 expandedDirs,只在 rootCollapsed
  // 被折叠时不可见。直接展开根再定位即可(根永远在 DOM 里)。
  if (rootCollapsed.value) rootCollapsed.value = false

  const rel = filePath.slice(root.length).replace(/^[\\/]+/, '')
  if (rel) {
    const segments = rel.split(/[\\/]+/)
    let cur = root
    // 倒数第二段之前的每个目录 = 文件的某层祖先,逐级 setDirExpanded + 必要时 loadDirChildren。
    // 必须用 join() 构建路径(不能用 `/` 拼接):Windows 上 fullPath 用 \ 分隔,
    // `/` 拼接的路径与 dirIndex / expandedDirs 里的 key 不匹配 → 展开无效。
    for (let i = 0; i < segments.length - 1; i++) {
      cur = await join(cur, segments[i])
      workspace.setDirExpanded(cur, true)
      const parent = dirIndex.get(cur)
      if (parent && parent.children === undefined) {
        try { await loadDirChildren(parent) }
        catch { /* 单层失败不影响其它层级 */ }
      }
    }
  }

  await nextTick()
  // 再补一次 nextTick:某些情况下 children 的渲染在 flatItems 上还要再 flush 一次
  await nextTick()

  // 虚拟滚动:目标行可能不在 DOM 里,先算出目标索引 → 手动设 scrollTop
  // 居中定位 → 同步 updateViewport 让 visibleRange 包含目标行 → nextTick
  // 后行渲染到 DOM → querySelector 定位 + flash 高亮。
  const items = flatItems.value
  const targetIdx = items.findIndex(
    item => item.kind === 'node' && item.node.fullPath === filePath,
  )
  if (targetIdx === -1) return

  const container = scrollContainerRef.value
  if (container) {
    const viewportH = container.clientHeight
    const targetTop = targetIdx * ROW_HEIGHT
    container.scrollTop = Math.max(0, targetTop - Math.floor(viewportH / 2) + Math.floor(ROW_HEIGHT / 2))
    updateViewport()
  }

  await nextTick()

  const row = treeRootRef.value?.querySelector(`[title="${CSS.escape(filePath)}"]`) as HTMLElement | null
  if (!row) return
  if (options?.flash !== false) {
    row.classList.add('reveal-flash')
    window.setTimeout(() => row.classList.remove('reveal-flash'), 1500)
  }
}

// ========== 右键菜单:在编辑器中打开 / 作为工作区打开(v0.5.1)==========

/** .md 文件 → 在编辑器中打开。与 onFileClick 共用同一条路径(脏盘确认 + openPath + setLastFile)。 */
async function openInEditor(node: TreeNode) {
  closeContextMenu()
  if (node.isDir || !MD_EXT_RE.test(node.name)) return
  const ok = await documentStore.openPathInTab(node.fullPath)
  if (!ok) return
  workspace.setLastFile(node.fullPath)
}

/** 子目录 → 在新窗口中打开为该工作区根。走 newAppWindow({ dirs:[...] }),
 *  新窗口 onMounted 领到 payload 后路由 setActiveRoot,与当前窗口状态隔离。
 *  web 端(无 Tauri)降级为当前窗口内 setActiveRoot,与旧行为一致。 */
function openAsWorkspace(node: TreeNode) {
  closeContextMenu()
  if (!node.isDir) return
  if (tauriOnly()) {
    void newAppWindow({ dirs: [node.fullPath] })
  }
  else {
    workspace.setActiveRoot(node.fullPath)
  }
}

// emit「search-in-folder」给 App.vue(v0.6.0 工作区搜索 scope)——
// App.vue 切到 search tab 并把该目录设为 scope。FileTree 不持有搜索状态,
// 避免两处状态镜像;App.vue 的 workspaceSearchScopeDir 是单一来源。
const emit = defineEmits<{
  (e: 'search-in-folder', dirPath: string): void
}>()

function onSearchInFolder(node: TreeNode) {
  closeContextMenu()
  if (!node.isDir) return
  emit('search-in-folder', node.fullPath)
}

// ========== 全局点击 / 键盘 / dragend ==========

function onGlobalPointerDown(event: PointerEvent) {
  // 行内编辑激活:点外部 = 提交
  // (菜单的「点外部关闭」由 useContextMenu composable 的独立 listener 管)
  if (inlineNew.value || inlineRename.value) {
    const target = event.target as Node | null
    if (target) {
      let n: Node | null = target
      while (n) {
        if (n instanceof Element && n.hasAttribute('data-inline-row')) return
        n = n.parentNode
      }
    }
    // 行内新建 + 空值 + blur → 静默取消(不对空名弹错误);Enter 空值仍走 submitInline 报错误
    if (inlineNew.value && !inlineNew.value.value.trim()) {
      cancelInline()
      return
    }
    void submitInline()
    return
  }
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (inlineNew.value || inlineRename.value) cancelInline()
  // 菜单的 Escape 关闭由 useContextMenu composable 的独立 listener 管
}

let globalListenersAttached = false

function attachGlobalListeners() {
  if (globalListenersAttached) return
  document.addEventListener('pointerdown', onGlobalPointerDown, true)
  document.addEventListener('keydown', onGlobalKeydown)
  // dragend 兜底:行级 @dragend 在拖拽源被脱开 DOM 时可能丢,文档级保险一份
  document.addEventListener('dragend', onGlobalDragEnd)
  globalListenersAttached = true
}

function detachGlobalListeners() {
  if (!globalListenersAttached) return
  document.removeEventListener('pointerdown', onGlobalPointerDown, true)
  document.removeEventListener('keydown', onGlobalKeydown)
  document.removeEventListener('dragend', onGlobalDragEnd)
  globalListenersAttached = false
}

function resetTransientUi() {
  dragOverTarget.value = null
  closeContextMenu()
  cancelInline()
  clearHoverExpandTimer()
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
  refreshState.value = 'idle'
  reset()
  cancelRaf()
}

onMounted(() => {
  attachGlobalListeners()
  nextTick(updateViewport)
})
onActivated(() => {
  attachGlobalListeners()
  nextTick(updateViewport)
})
onDeactivated(() => {
  detachGlobalListeners()
  resetTransientUi()
})
onBeforeUnmount(() => {
  detachGlobalListeners()
  resetTransientUi()
})

/** 行渲染的显示名:根 row 走 rootDisplay(去尾分隔符 + basename),其余 = node.name。
 *  根的 node.name 在 useTreeData.rebuildFromRoot 里也按 basename(root) 设过,这里保留
 *  独立逻辑只为兜底 root 路径形如 "/" / "C:\\" 等 edge case。 */
function displayName(node: TreeNode): string {
  return isRootNode(node) ? rootDisplay.value : node.name
}
</script>

<template>
  <!-- min-w-0(v0.5.5):替换原 min-w-64,允许 splitter 拉到 200px。行内 truncate 由
       各 row 自己处理。overflow-hidden 防窄态溢出。 -->
  <div ref="treeRootRef" class="relative flex h-full min-w-0 flex-col overflow-hidden" @mouseenter="workspaceHovered = true" @mouseleave="workspaceHovered = false">
    <!-- 空态:没选工作区(根名已下沉成 flatItems 第一行,v0.5.1) -->
    <div v-if="!workspace.activeRoot" class="flex flex-1 items-center justify-center px-4">
      <button
        class="rounded-md border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-700 dark:border-gray-700 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200"
        @click="chooseWorkspace"
      >
        打开一个文件夹作为工作区
      </button>
    </div>

    <!-- 文件列表 -->
    <div
      v-else
      v-velo-scroll
      ref="scrollContainerRef"
      class="min-h-0 flex-1 overflow-y-auto"
      :class="{ 'bg-blue-50/40 dark:bg-blue-950/20': dragOverTarget !== null && dragOverTarget === workspace.activeRoot }"
      @scroll.passive="onScroll"
      @dragover.self="onContainerDragOver"
      @drop.self="onContainerDrop"
      @dragleave.self="dragOverTarget = null"
      @dblclick.self="onContainerDblClick"
      @contextmenu.self="onContainerContextMenu"
    >
      <div v-if="rootNode?.loading" class="px-4 py-0.5 text-xs text-gray-400">
        加载中…
      </div>
      <div v-else-if="rootNode?.error" class="px-4 py-0.5 text-xs text-red-500" :title="rootNode.error">
        读取目录失败
      </div>
      <div v-else>
        <!-- 虚拟滚动:上下 spacer 撑住总高度,中间只渲染可见行 -->
        <div :style="{ height: `${visibleRange.start * ROW_HEIGHT}px` }"></div>
        <template v-for="item in visibleItems" :key="item.kind === 'inlineNew' ? `inlineNew-${item.parentDir}` : item.node.fullPath">
          <!-- ============ 行内新建(挂目标目录末尾)============ -->
          <div
            v-if="item.kind === 'inlineNew'"
            data-inline-row
            :style="indentStyle(item.depth)"
            class="flex items-center gap-1 h-8 pr-2 text-xs"
          >
            <span v-if="item.subKind === 'newDir'" class="flex size-4 shrink-0 items-center justify-center">
              <ChevronRight class="size-3 text-gray-400" :stroke-width="2.5" />
            </span>
            <template v-else>
              <span class="flex size-4 shrink-0" />
              <File class="size-3.5 shrink-0 text-gray-400" />
            </template>
            <input
              :ref="bindInlineInputEl"
              v-model="inlineNew!.value"
              type="text"
              spellcheck="false"
              class="min-w-0 flex-1 rounded-sm border border-[var(--surface-border)] bg-transparent px-1 py-1 text-gray-800 outline-none transition-colors focus:border-[var(--md-primary-color)] dark:text-gray-100"
              :title="inlineNew!.error ?? ''"
              data-testid="inline-input"
              @keydown.enter.prevent="submitInline"
              @keydown.esc.prevent="cancelInline"
            >
            <span v-if="item.subKind === 'newFile'" class="shrink-0 text-gray-500">.md</span>
          </div>

          <!-- ============ 行内重命名(替换原行)============ -->
          <div
            v-else-if="inlineRename && inlineRename.node === item.node"
            data-inline-row
            :style="indentStyle(item.depth)"
            class="flex items-center gap-1 h-8 pr-2 text-xs"
          >
            <span v-if="item.node.isDir" class="flex size-4 shrink-0 items-center justify-center">
              <ChevronRight class="size-3 text-gray-400" :stroke-width="2.5" />
            </span>
            <template v-else>
              <span class="flex size-4 shrink-0" />
              <Image v-if="isImageName(item.node.name)" class="size-4 shrink-0 text-gray-400" />
              <File v-else class="size-4 shrink-0 text-gray-400" />
            </template>
            <input
              :ref="bindInlineInputEl"
              v-model="inlineRename!.value"
              type="text"
              spellcheck="false"
              class="min-w-0 flex-1 rounded-sm border border-[var(--surface-border)] bg-transparent px-1 py-1 text-gray-800 outline-none transition-colors focus:border-[var(--md-primary-color)] dark:text-gray-100"
              :title="inlineRename!.error ?? ''"
              data-testid="inline-input"
              @keydown.enter.prevent="submitInline"
              @keydown.esc.prevent="cancelInline"
            >
            <span v-if="!item.node.isDir && /\.md$/i.test(item.node.name)" class="shrink-0 text-gray-500">.md</span>
          </div>

          <!-- ============ 普通行 ============ -->
          <div
            v-else
            :style="indentStyle(item.depth)"
            class="group flex cursor-pointer items-center gap-1 h-7.5 pr-2 text-sm transition-colors hover:bg-[var(--surface-hover)]"
            :class="{
              'bg-[var(--surface-pressed)]': !item.node.isDir && item.node.fullPath === activeFile,
              'ring-1 ring-blue-400 dark:ring-blue-500': item.node.isDir && item.node.fullPath === dragOverTarget,
            }"
            :title="item.node.fullPath"
            :data-testid="isRootNode(item.node) ? 'workspace-root' : `file-row-${item.node.name}`"
            :data-row-depth="item.depth"
            :data-row-path="item.node.fullPath"
            :data-row-is-dir="item.node.isDir"
            draggable="true"
            @click="onFileClick(item.node)"
            @auxclick.middle.prevent="onRowAuxClick(item.node)"
            @dragstart="onRowDragStart($event, item.node)"
            @dragover="onRowDragOver($event, item.node)"
            @drop="onRowDrop($event, item.node)"
            @dragend="dragOverTarget = null"
            @contextmenu.prevent="onRowContextMenu($event, item.node)"
          >
            <!-- 展开箭头 / 文件占位
                 - 根:始终显示(根永远是目录,即使为空也保留折叠/展开 affordance)
                 - 子目录:已加载且为空 → 不显示箭头(避免误导用户可展开);其余照常
                 旋转跟随 item.expanded:根折叠时 rotate=0,展开时 rotate-90 -->
            <span class="flex size-4 shrink-0 items-center justify-center">
              <ChevronRight
                v-if="item.node.isDir"
                class="size-3 text-gray-400 transition-transform"
                :class="{ 'rotate-90': item.expanded }"
                :stroke-width="2.5"
              />
            </span>
            <!-- 图标(图片 / .md 文件;目录不显示图标) -->
            <Image v-if="!item.node.isDir && isImageName(item.node.name)" class="size-3.5 shrink-0 text-gray-400" />
            <File v-else-if="!item.node.isDir" class="size-3.5 shrink-0 text-gray-400" />
            <span class="truncate text-gray-700 dark:text-gray-200">
              {{ displayName(item.node) }}
            </span>
            <!-- 根行工具按钮:hover 工作区时显示 -->
            <RootActionButtons
              v-if="isRootNode(item.node)"
              :visible="workspaceHovered"
              :refresh-state="refreshState"
              with-test-ids
              @new-file="openInlineNew(workspace.activeRoot!, 'newFile')"
              @new-dir="openInlineNew(workspace.activeRoot!, 'newDir')"
              @refresh="refreshRoot"
              @collapse-all="collapseAll"
            />
          </div>
        </template>
        <div :style="{ height: `${Math.max(0, flatItems.length - visibleRange.end) * ROW_HEIGHT}px` }"></div>
        <!-- 根子项为空时显示占位(根 row 已先行渲染,这里只补"空目录"提示)。
             根折叠时不渲染(占位也跟着收起,保持折叠纯粹)。 -->
        <div
          v-if="!rootCollapsed && rootNode && rootNode.children && rootNode.children.length === 0"
          class="py-0.5 pl-6 text-xs text-gray-400"
        >
          空目录
        </div>
      </div>
    </div>

    <!-- Sticky 目录头 overlay:滚动时级联粘贴根 → 子目录 → 子子目录...
         overlay 在 scrollContainer 外层(treeRootRef 内),absolute top-0 不随滚动移动。
         最后一行带 shadow 模拟"浮起"层级分隔。 -->
    <div
      v-if="stickyHeaders.length"
      class="pointer-events-none absolute inset-x-0 top-0 z-10"
    >
      <div
        v-for="(h, idx) in stickyHeaders"
        :key="h.node.fullPath"
        :style="indentStyle(h.depth)"
        class="sticky-row pointer-events-auto flex cursor-pointer items-center gap-1 h-7.5 border-b border-transparent pr-2 text-sm bg-[var(--surface-1)] hover:bg-[var(--surface-0)]"
        :class="{ 'sticky-shadow': idx === stickyHeaders.length - 1 }"
        :title="h.node.fullPath"
        @click="onFileClick(h.node)"
      >
        <span class="flex size-4 shrink-0 items-center justify-center">
          <ChevronRight
            class="size-3 text-gray-400 transition-transform"
            :class="{ 'rotate-90': stickyIsExpanded(h.node) }"
            :stroke-width="2.5"
          />
        </span>
        <span class="truncate text-gray-700 dark:text-gray-200">
          {{ stickyDisplayName(h.node) }}
        </span>
        <!-- 根行工具按钮:sticky 根也展示,hover 工作区时可见 -->
        <RootActionButtons
          v-if="isRootNode(h.node)"
          :visible="workspaceHovered"
          :refresh-state="refreshState"
          @new-file="openInlineNew(workspace.activeRoot!, 'newFile')"
          @new-dir="openInlineNew(workspace.activeRoot!, 'newDir')"
          @refresh="refreshRoot"
          @collapse-all="collapseAll"
        />
      </div>
    </div>
  </div>

  <!-- 右键菜单(Teleport 在子组件内)。
       - 子节点(.md / 图片 / 子目录):弹完整菜单(在编辑器中打开 / 作为工作区打开 / 新建 / 重命名 / 删除 / reveal)
       - 根节点 + 容器空白处:rootContext=true,只显示新建项(根不能重命名 / 删除 / reveal) -->
  <FileTreeContextMenu
    v-if="contextMenu"
    ref="contextMenuRef"
    :x="contextMenu.x"
    :y="contextMenu.y"
    :node="contextMenu.node"
    :root-context="contextMenu.rootContext"
    :can-paste="clipboard !== null"
    @open-in-editor="openInEditor(contextMenu.node)"
    @open-as-workspace="openAsWorkspace(contextMenu.node)"
    @search-in-folder="onSearchInFolder(contextMenu.node)"
    @new-file="openInlineNew(targetDirForNew(contextMenu.node), 'newFile')"
    @new-dir="openInlineNew(targetDirForNew(contextMenu.node), 'newDir')"
    @copy="copyNode(contextMenu.node)"
    @paste="pasteInto(targetDirForNew(contextMenu.node))"
    @rename="openInlineRename(contextMenu.node)"
    @delete="confirmAndDelete(contextMenu.node)"
    @reveal="revealInExplorer(contextMenu.node)"
  />
</template>

<style scoped lang="scss">
/* sticky 目录头:最后一行底部加浅 shadow,模拟"浮起"层级分隔。
 * 亮色用淡墨色,暗色用淡黑,与 splitter shadow 同色系。 */
.sticky-shadow {
  box-shadow: 0 4px 6px -4px rgba(16, 24, 40, 0.12);
  border-bottom-color: var(--surface-border);
}
.dark .sticky-shadow {
  box-shadow: 0 4px 8px -4px rgba(0, 0, 0, 0.6);
}
/* sticky 行过渡:颜色 + box-shadow 一起过渡。
   border-transparent 常驻 border-b 占位,sticky-shadow 只改 border-color
   (transparent → surface-border),避免 transition-colors 从 currentColor
   (文字深色)过渡到 surface-border 时闪一帧深色"黑线"。
   box-shadow 也纳入过渡,避免 sticky-shadow 在行间移动时阴影瞬现/瞬消。 */
.sticky-row {
  transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease, box-shadow 150ms ease;
}

/* revealFile 加的临时高亮 class —— 1500ms 后由 revealFile 内部移除。
 * 蓝色 outline + 浅蓝底,够醒目但不抢焦点(对比 active-file 行的 surface-pressed 更亮)。 */
.reveal-flash {
  background-color: rgb(219 234 254);   /* blue-100 */
  outline: 2px solid rgb(59 130 246);  /* blue-500 */
  outline-offset: -2px;
  transition: background-color 600ms ease-out, outline-color 600ms ease-out;
}
.dark .reveal-flash {
  background-color: rgb(30 58 138 / 0.4);   /* blue-900 @ 40% */
  outline-color: rgb(96 165 250);          /* blue-400 */
}
</style>
