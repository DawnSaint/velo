<script setup lang="ts">
// 文件树最小可用版(v0.5.0) + 右键菜单 CRUD(v0.5.1) + 内部拖拽 move(v0.5.1):
//  - 工作区根固定显示;子目录懒加载(展开时才 readDir)
//  - 点击 .md 文件 → 打开到编辑器(走 documentStore.openPath,带 dirty 确认)
//  - 右键 → 新建 / 重命名 / 删除 / 在资源管理器中显示(每项 destructive op 必 confirm)
//  - 行 / 容器空白区接收"自家"拖拽(application/x-velo-tree-path) → fs.rename
//    (同盘 mv 语义) + 工作区状态前缀重写 + 当前打开文件路径热切换(不重载内容)
//  - 拖入折叠目录悬停 500ms 自动展开(VSCode 行为)
//  - 展开状态走 workspaceStore.expandedDirs,持久化到 velo-workspaces.json
//
// 性能取舍:**不虚拟化**。真撞性能墙再上虚拟滚动。
// 文件分类:lexicographic 排序,目录在文件前;隐藏文件(以 . 开头)默认显示
//
// 行内 input(新建 / 重命名)走「行内编辑」(对齐 VSCode / Finder),不再用 modal。
// 数据 / IO 抽到 `useTreeData` composable,纯函数抽到 `treeUtils`,本文件只剩 UI 状态机。

import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { ChevronRight, File, Folder, Image } from '@lucide/vue'
import {
  copyFile as fsCopyFile,
  mkdir as fsMkdir,
  readDir as fsReadDir,
  remove as fsRemove,
  rename as fsRename,
  writeTextFile,
} from '@/tauri/fs'
import { join, sep } from '@/tauri/path'
import { confirm as nativeConfirm } from '@/tauri/dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { tauriOnly } from '@/tauri/fs'
import { newAppWindow } from '@/tauri/window'
import { useWorkspaceStore } from '@/stores/workspace'
import { useRecentFilesStore } from '@/stores/recentFiles'
import { useDocumentStore } from '@/stores/document'
import { useNotifyStore } from '@/stores/notify'
import { TREE_DIR_PATH_MIME, TREE_PATH_MIME } from '@/components/ProseMirrorEditor/image/treeDrop'
import { useContextMenu, clampToViewport } from '@/composables/useContextMenu'
import FileTreeContextMenu from './FileTreeContextMenu.vue'
import { useTreeData, type TreeNode } from './useTreeData'
import {
  MD_EXT_RE,
  basename,
  finalName,
  formatFsError,
  isAncestorOrSelf,
  isImageName,
  parentDirOfPath,
  uniqueName,
  validateName,
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

// ========== flatItems:渲染拍平,免递归组件 ==========
//
// inlineNew 项混在 flatItems 里(在目标目录子树末尾追加一个 input 行);
// 模板用 v-if 分支区分普通行 / 行内新建 / 行内重命名。

type VisualItem =
  | { kind: 'node', node: TreeNode, depth: number, expanded: boolean }
  | { kind: 'inlineNew', parentDir: string, depth: number, subKind: 'newFile' | 'newDir' }

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

function indentStyle(depth: number): { paddingLeft: string } {
  return { paddingLeft: `${12 + depth * 12}px` }
}

async function chooseWorkspace() {
  await workspace.pickWorkspace()
}

// ========== 拖拽源 ==========
//
// 自定义 MIME(而非纯 text/plain)承载 fullPath,让 drop 处理器(自家树 +
// 编辑器)能区分"velo 内部拖拽"与"OS 拖文件进来"两种来源:
//  - 树拖**文件**(.md / 图片):写 TREE_PATH_MIME + text/plain
//    - 编辑器(imageUploadPlugin / SourceModeEditor)按 TREE_PATH_MIME 识别 → 打开 / 落盘插图
//    - 自家树同 MIME 接 drop → fs.rename 同盘 move
//  - 树拖**目录**:写 TREE_DIR_PATH_MIME(不写 text/plain,不写 TREE_PATH_MIME)
//    - 编辑器不识别此 MIME,目录拖入编辑器不触发任何动作(预期:目录无法拖编辑器)
//    - 自家树同时接受两种 MIME → fs.rename 同盘 move
//  - OS 拖:走原生 imageUploadPlugin(富文本)/ 文件型 drop 处理(源码模式)

function onRowDragStart(event: DragEvent, node: TreeNode) {
  if (!event.dataTransfer) return
  // 根节点不可拖(拖根 = 把工作区"移走",fs 层 ancestor 守卫会 reject,UI 上不应暴露)。
  if (isRootNode(node)) {
    event.preventDefault()
    return
  }
  // 互斥:dragstart 关掉可能挂着的菜单 / 行内 input —— 否则 drop 时全局 pointerdown
  // 可能把行内 input 误提交,菜单也会在拖拽中途残留。
  closeContextMenu()
  cancelInline()
  if (node.isDir) {
    // 目录:独立 MIME,不写 text/plain —— 防止目录被拖到编辑器后 PM 当文本插入路径串。
    event.dataTransfer.setData(TREE_DIR_PATH_MIME, node.fullPath)
  }
  else {
    event.dataTransfer.setData(TREE_PATH_MIME, node.fullPath)
    event.dataTransfer.setData('text/plain', node.fullPath)
  }
  // 'all' 而非 'copyLink':v0.5.1 起内部拖拽 move 需要 dropEffect='move' 在
  // effectAllowed 子集内;'copyLink' 不含 'move',浏览器会把 move 视为非法。
  // 编辑器侧自行计算 dropEffect(.md=link 跳转/copy 引用),不受 source 宽放影响。
  event.dataTransfer.effectAllowed = 'all'
}

// ========== 内部拖拽 move(v0.5.1) ==========
//
// 接收"自家树"拖拽(TREE_PATH_MIME),走 fs.rename 同盘 mv 语义。OS / 编辑器
// 拖出去这边不偷信号(types 不含 TREE_PATH_MIME 直接 fall through)。
//
// 高亮单点:dragOverTarget 存"解析后的目标目录路径"(不是悬停 row 路径)。
// 文件 row → 高亮其父目录;目录 row → 高亮自身;容器空白 → 高亮工作区根。
//
// hover-expand:拖到折叠目录上 500ms 自动展开(VSCode 行为),让用户能拖到
// 深层目录而无需先点开。展开后不再折叠(避免目标在拖动过程中消失)。
//
// 完成后的状态更新同 microtask 无 await 间隔(见 docs/architecture/file-tree.md):
// renamePathPrefix → loadContent(必要时)→ pruneDirIndexPrefix → 双侧 refresh。

const dragOverTarget = ref<string | null>(null)
const HOVER_EXPAND_MS = 500
let hoverExpandTimer: ReturnType<typeof setTimeout> | null = null
let hoverExpandPath: string | null = null

function clearHoverExpandTimer() {
  if (hoverExpandTimer) {
    clearTimeout(hoverExpandTimer)
    hoverExpandTimer = null
  }
  hoverExpandPath = null
}

/** 当拖动停在折叠目录上时,挂 500ms 定时器自动展开;切到别的目录 / 离开重置。 */
function armHoverExpand(dirPath: string) {
  if (hoverExpandPath === dirPath) return // 同一目标计时器已在跑,别重置
  clearHoverExpandTimer()
  // 根折叠态独立处理:用 rootCollapsed,不查 workspace.expandedDirs
  if (dirPath === workspace.activeRoot) {
    if (!rootCollapsed.value) return // 已展开,不挂 timer
    hoverExpandPath = dirPath
    hoverExpandTimer = setTimeout(() => {
      hoverExpandTimer = null
      hoverExpandPath = null
      rootCollapsed.value = false
    }, HOVER_EXPAND_MS)
    return
  }
  const node = dirIndex.get(dirPath)
  if (!node || !node.isDir) return
  if (workspace.isDirExpanded(dirPath)) return
  hoverExpandPath = dirPath
  hoverExpandTimer = setTimeout(() => {
    hoverExpandTimer = null
    hoverExpandPath = null
    // 重新判一遍(用户可能在 500ms 内手动展开 / 切到别处再回来),避免重复 readDir
    if (!workspace.isDirExpanded(dirPath)) {
      workspace.setDirExpanded(dirPath, true)
      const n = dirIndex.get(dirPath)
      if (n && n.children === undefined) void loadDirChildren(n)
    }
  }, HOVER_EXPAND_MS)
}

function resolveDropDir(node: TreeNode | null): string | null {
  if (!node) return workspace.activeRoot
  return node.isDir ? node.fullPath : parentDirOfPath(node.fullPath)
}

function dragHasTreePath(event: DragEvent): boolean {
  // dragover/drop 期 dataTransfer.getData 受浏览器安全约束(只允许 drop 内拿),
  // 但 types 集合一直可读 —— 用它判定"是自家树拖拽吗"。文件 / 目录两种 MIME 都接,
  // 内部 move 对 file/dir 同走 fs.rename。
  const types = event.dataTransfer?.types
  return !!types && (types.includes(TREE_PATH_MIME) || types.includes(TREE_DIR_PATH_MIME))
}

function onRowDragOver(event: DragEvent, node: TreeNode) {
  if (!dragHasTreePath(event)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const dst = resolveDropDir(node)
  dragOverTarget.value = dst
  // 文件 row 解析到的目标是父目录,父目录已展开(否则文件不可见),不会挂 timer
  if (dst && node.isDir) armHoverExpand(dst)
  else clearHoverExpandTimer()
}

/** 从 dataTransfer 取自家拖拽源路径,文件 / 目录 MIME 都试一遍。 */
function getTreeDragPath(event: DragEvent): string | null {
  const dt = event.dataTransfer
  if (!dt) return null
  return dt.getData(TREE_PATH_MIME) || dt.getData(TREE_DIR_PATH_MIME) || null
}

async function onRowDrop(event: DragEvent, node: TreeNode) {
  if (!dragHasTreePath(event)) return
  event.preventDefault()
  event.stopPropagation()
  clearHoverExpandTimer()
  const srcPath = getTreeDragPath(event)
  dragOverTarget.value = null
  if (!srcPath) return
  const dstDir = resolveDropDir(node)
  if (!dstDir) return
  await performMove(srcPath, dstDir)
}

function onContainerDragOver(event: DragEvent) {
  if (!dragHasTreePath(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverTarget.value = workspace.activeRoot
  // 容器空白 = 根目标;根可能被折叠,armHoverExpand 内部按 rootCollapsed 判要不要挂 timer
  if (workspace.activeRoot) armHoverExpand(workspace.activeRoot)
  else clearHoverExpandTimer()
}

async function onContainerDrop(event: DragEvent) {
  if (!dragHasTreePath(event)) return
  event.preventDefault()
  clearHoverExpandTimer()
  const srcPath = getTreeDragPath(event)
  dragOverTarget.value = null
  if (!srcPath || !workspace.activeRoot) return
  await performMove(srcPath, workspace.activeRoot)
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

/** 把 srcPath 移到 dstDir 下,沿用其 basename。校验失败弹原生 message,
 *  成功后状态更新一口气走完,Vue 单帧 flush。 */
async function performMove(srcPath: string, dstDir: string) {
  const srcParentDir = parentDirOfPath(srcPath)
  const srcParent = dirIndex.get(srcParentDir)
  const srcName = basename(srcPath)
  // src 必须在 dirIndex(目录)或父目录 children(文件)里找得到;
  // 拖拽源都是当前可见 row,理论必然命中,兜底 return。
  const srcNode: TreeNode | undefined
    = dirIndex.get(srcPath)
      ?? srcParent?.children?.find(c => c.fullPath === srcPath)
  if (!srcNode) return

  // 静默 noop:拖回自己父目录 / 拖到自身
  if (srcPath === dstDir) return
  if (srcParentDir === dstDir) return

  if (srcNode.isDir && isAncestorOrSelf(srcPath, dstDir)) {
    notify.warning('不能将目录拖入自身或其子目录')
    return
  }

  const newPath = await join(dstDir, srcName)
  if (newPath === srcPath) return

  try {
    await fsRename(srcPath, newPath)
  }
  catch (e) {
    notify.error(formatFsError(e, '移动失败'))
    return
  }

  // —— 写盘成功,接下来全部同步无 await 间隔(loadDirChildren 内的 await 在最后) ——

  // 1) 工作区状态前缀重写(expandedDirs / lastFile)
  workspace.renamePathPrefix(srcPath, newPath)
  recentFiles.renamePathPrefix(srcPath, newPath)

  // 2) 多标签联动:所有打开标签里命中 srcPath(文件)或其前缀(目录)的 path 换成 newPath,
  //    不动 content / dirty 基线(改名不该清 dirty)
  await documentStore.renameOpenPaths(srcPath, newPath)

  // 3) 旧路径下的 dirIndex 子树孤儿清理(否则 fs.watch 会撞到死路径置 node.error)
  pruneDirIndexPrefix(srcPath)

  // 4) 同时刷新源父目录 + 目标目录(未加载则跳过该侧)
  const dstNode = dirIndex.get(dstDir)
  const tasks: Array<Promise<void>> = []
  if (srcParent) tasks.push(loadDirChildren(srcParent))
  if (dstNode) tasks.push(loadDirChildren(dstNode))
  await Promise.all(tasks)
}

// ========== 右键菜单(v0.5.1) ==========
//
// 单实例菜单:右键 row → 记下 node + 鼠标位置 → 浮层定位到 (x,y);
// 点别处 / Escape 关闭。菜单 UI 在 `FileTreeContextMenu.vue`。

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

useContextMenu({
  isOpen: () => contextMenu.value !== null,
  getMenuEl: () => contextMenuRef.value?.rootEl ?? null,
  close: () => { contextMenu.value = null },
})

// ========== 复制 / 粘贴(v0.5.x) ==========
//
// 单实例"剪贴板":只记源路径 + 源是否目录。粘贴时:
//  - 文件:走 fs.copyFile 二进制复制
//  - 目录:递归 mkdir + copyFile
//  - 目标目录已有同名项:走 uniqueName 自动重命名("foo 副本.md" / "foo 副本 2.md" 等)
//  - 不能把目录粘贴到自身或子目录内(同 move 的 ancestor 守卫)
// 粘贴成功后刷新目标目录 children。clipcleard 不清,支持多次粘贴(对齐 VSCode)。

/** 剪贴板:已复制的源路径 + 是否目录;null = 未复制。 */
const clipboard = ref<{ srcPath: string, isDir: boolean } | null>(null)

function isRootNode(node: TreeNode): boolean {
  return workspace.activeRoot !== null && node.fullPath === workspace.activeRoot
}

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

function closeContextMenu() {
  contextMenu.value = null
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

// ========== 行内 input:新建 / 重命名(v0.5.1) ==========
//
// 不走 modal,改行内 input(对齐 VSCode / Finder):
//  - 新建:在目标目录末尾插入一行 input
//  - 重命名:把原行替换成 input(同 key,Vue 复用 DOM)
//  - Enter 提交、Esc 取消、点外部提交
//  - 校验失败不关 input,title 显示错误
//  - .md 后缀走静态 span,input 不含 .md —— 用户不可编辑后缀

interface InlineNewState {
  parentDir: string
  kind: 'newFile' | 'newDir'
  value: string
  error: string | null
}

interface InlineRenameState {
  node: TreeNode
  /** base name(.md 文件去掉 .md 后缀;其它含完整名) */
  value: string
  error: string | null
}

const inlineNew = ref<InlineNewState | null>(null)
const inlineRename = ref<InlineRenameState | null>(null)
const inlineInputEl = ref<HTMLInputElement | null>(null)

/** v-for 内拿 input ref:Vue 3 string ref 在 v-for 里收成数组,函数 ref 干净。 */
function bindInlineInputEl(el: Element | { $el?: unknown } | null) {
  inlineInputEl.value = el instanceof HTMLInputElement ? el : null
}

/** 取同目录已加载 children 的 name 集合给 validateName 当同名查重源;未加载返回 null
 *  让 validateName 跳过同名检查,交后端 reject 兜底。 */
function siblingNamesOf(parentDir: string): Set<string> | null {
  const parent = dirIndex.get(parentDir)
  if (!parent?.children) return null
  return new Set(parent.children.map(c => c.name))
}

async function openInlineNew(parentDir: string, kind: 'newFile' | 'newDir') {
  closeContextMenu()
  inlineRename.value = null
  // 父目录必须展开才能让行内 input 可见;右键时若未展开,先 expand + 拉子目录
  const isRoot = parentDir === workspace.activeRoot
  if (!isRoot) {
    const parent = dirIndex.get(parentDir)
    if (parent && !workspace.isDirExpanded(parentDir)) {
      workspace.setDirExpanded(parentDir, true)
      if (parent.children === undefined) await loadDirChildren(parent)
    }
  }
  inlineNew.value = {
    parentDir,
    kind,
    value: '',
    error: null,
  }
  await focusInlineNextTick()
  inlineInputEl.value?.scrollIntoView({ block: 'nearest' })
}

function openInlineRename(node: TreeNode) {
  closeContextMenu()
  inlineNew.value = null
  const isMd = !node.isDir && /\.md$/i.test(node.name)
  inlineRename.value = {
    node,
    value: isMd ? node.name.replace(/\.md$/i, '') : node.name,
    error: null,
  }
  void focusInlineNextTick()
}

async function focusInlineNextTick() {
  await nextTick()
  inlineInputEl.value?.focus()
  inlineInputEl.value?.select()
}

function cancelInline() {
  inlineNew.value = null
  inlineRename.value = null
  inlineInputEl.value = null
}

async function submitInline() {
  // 1) 行内新建
  if (inlineNew.value) {
    const { parentDir, kind, value } = inlineNew.value
    // 空名校验必须落在 input 原值上,不能在 finalName 上(.md 拼接后非空)
    if (!value.trim()) { inlineNew.value.error = '名称不能为空'; return }
    const fullName = finalName(value, { kind })
    const err = validateName(fullName, siblingNamesOf(parentDir), null)
    if (err) { inlineNew.value.error = err; return }
    const targetPath = await join(parentDir, fullName)
    try {
      if (kind === 'newFile') await writeTextFile(targetPath, '')
      else await fsMkdir(targetPath)
      // children 更新 + cancelInline 同 microtask,Vue 一次 flush(见 docs/architecture/file-tree.md)
      const parent = dirIndex.get(parentDir)
      if (parent) await loadDirChildren(parent)
      cancelInline()
    }
    catch (e) {
      inlineNew.value.error = formatFsError(e, kind === 'newFile' ? '新建文件失败' : '新建目录失败')
    }
    return
  }
  // 2) 行内重命名
  if (inlineRename.value) {
    const { node, value } = inlineRename.value
    if (!value.trim()) { inlineRename.value.error = '名称不能为空'; return }
    const isMdFile = !node.isDir && /\.md$/i.test(node.name)
    const fullName = finalName(value, { kind: isMdFile ? 'renameMdFile' : 'renameOther' })
    const parentDir = parentDirOfPath(node.fullPath)
    const err = validateName(fullName, siblingNamesOf(parentDir), node.name)
    if (err) { inlineRename.value.error = err; return }
    const newPath = await join(parentDir, fullName)
    if (newPath === node.fullPath) { cancelInline(); return }
    try {
      await fsRename(node.fullPath, newPath)
      // 联动工作区 / 全局最近文件里的旧路径,否则移动或重命名后菜单会指向死路径
      workspace.renamePathPrefix(node.fullPath, newPath)
      recentFiles.renamePathPrefix(node.fullPath, newPath)
      // 联动多标签:命中旧路径的打开标签只换 path,不动 content / dirty
      await documentStore.renameOpenPaths(node.fullPath, newPath)
      const parent = dirIndex.get(parentDir)
      if (parent) await loadDirChildren(parent)
      cancelInline()
    }
    catch (e) {
      inlineRename.value.error = formatFsError(e, '重命名失败')
    }
  }
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

  const row = treeRootRef.value?.querySelector(`[title="${CSS.escape(filePath)}"]`) as HTMLElement | null
  if (!row) return
  row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  if (options?.flash !== false) {
    row.classList.add('reveal-flash')
    window.setTimeout(() => row.classList.remove('reveal-flash'), 1500)
  }
}

// ========== 右键菜单新增:在编辑器中打开 / 作为工作区打开(v0.5.1)==========

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

/** 把节点记入剪贴板(不立刻读数据,粘贴时再读)。 */
function copyNode(node: TreeNode) {
  closeContextMenu()
  clipboard.value = { srcPath: node.fullPath, isDir: node.isDir }
}

/**
 * 递归复制目录。逐条目 mkdir + readDir + copyFile,失败即抛。
 * 用 fsReadDir 而非 dirIndex 子树(源可能未展开,children=undefined)。
 */
async function copyDirRecursive(srcDir: string, dstDir: string) {
  await fsMkdir(dstDir, { recursive: false }).catch((e) => {
    // 目标已存在(uniqueName 已避开,但 race 下仍可能)→ 复用;其它抛。
    const msg = e instanceof Error ? e.message : String(e)
    if (!msg.includes('already exists')) throw e
  })
  const entries = await fsReadDir(srcDir)
  for (const entry of entries) {
    const childSrc = `${srcDir}/${entry.name}`
    const childDst = `${dstDir}/${entry.name}`
    if (entry.isDirectory) {
      await copyDirRecursive(childSrc, childDst)
    }
    else {
      await fsCopyFile(childSrc, childDst)
    }
  }
}

/** 把剪贴板中的源粘贴到 dstDir。同名自动重命名;目录不能贴入自身后代。 */
async function pasteInto(dstDir: string) {
  const clip = clipboard.value
  if (!clip) return
  closeContextMenu()

  // 目录:不能贴入自身或子目录(同 move 的 ancestor 守卫)。
  if (clip.isDir && isAncestorOrSelf(clip.srcPath, dstDir)) {
    notify.warning('不能将目录粘贴到自身或其子目录')
    return
  }

  // 取目标目录已加载的 children name 集合作同名源;未加载则跳过,让后端兜底。
  const dstNode = dirIndex.get(dstDir)
  const siblingNames = dstNode?.children
    ? new Set(dstNode.children.map(c => c.name))
    : null
  const srcName = basename(clip.srcPath)
  const finalDstName = siblingNames ? uniqueName(srcName, siblingNames) : srcName
  const dstPath = await join(dstDir, finalDstName)

  // 同路径静默 noop(把项粘贴到原父目录且未重命名 → 会与源同名冲突,已在 uniqueName 处理;
  // 但如果 siblingNames=null 未加载则走到这里,fs 端会 reject 报"already exists")。
  try {
    if (clip.isDir) {
      await copyDirRecursive(clip.srcPath, dstPath)
    }
    else {
      await fsCopyFile(clip.srcPath, dstPath)
    }
  }
  catch (e) {
    notify.error(formatFsError(e, '粘贴失败'))
    return
  }

  // 刷新目标目录 children(未加载则跳过;展开态才可见新项)。
  const parent = dirIndex.get(dstDir)
  if (parent && parent.children) {
    await loadDirChildren(parent)
  }
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

function onGlobalDragEnd() {
  dragOverTarget.value = null
  clearHoverExpandTimer()
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
}

onMounted(attachGlobalListeners)
onActivated(attachGlobalListeners)
onDeactivated(() => {
  detachGlobalListeners()
  resetTransientUi()
})
onBeforeUnmount(() => {
  detachGlobalListeners()
  resetTransientUi()
})

const rootDisplay = computed(() => {
  const r = workspace.activeRoot
  if (!r) return ''
  const s = sep()
  const trimmed = r.endsWith(s) ? r.slice(0, -s.length) : r
  return basename(trimmed) || trimmed
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
  <div ref="treeRootRef" class="flex h-full min-w-0 flex-col overflow-hidden">
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
      class="min-h-0 flex-1 overflow-y-auto"
      :class="{ 'bg-blue-50/40 dark:bg-blue-950/20': dragOverTarget !== null && dragOverTarget === workspace.activeRoot }"
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
        <template v-for="item in flatItems" :key="item.kind === 'inlineNew' ? `inlineNew-${item.parentDir}` : item.node.fullPath">
          <!-- ============ 行内新建(挂目标目录末尾)============ -->
          <div
            v-if="item.kind === 'inlineNew'"
            data-inline-row
            :style="indentStyle(item.depth)"
            class="flex items-center gap-1 h-8 pr-2 text-xs"
          >
            <span class="flex size-4 shrink-0" />
            <Folder v-if="item.subKind === 'newDir'" class="size-3.5 shrink-0 text-gray-400" />
            <File v-else class="size-3.5 shrink-0 text-gray-400" />
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
            <span class="flex size-4 shrink-0" />
            <Folder v-if="item.node.isDir" class="size-4 shrink-0 text-gray-400" />
            <Image v-else-if="isImageName(item.node.name)" class="size-4 shrink-0 text-gray-400" />
            <File v-else class="size-4 shrink-0 text-gray-400" />
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
                v-if="item.node.isDir && (isRootNode(item.node) || !(item.node.children && item.node.children.length === 0))"
                class="size-3 text-gray-400 transition-transform"
                :class="{ 'rotate-90': item.expanded }"
                :stroke-width="2.5"
              />
            </span>
            <!-- 图标(目录 / 图片 / .md 文件) -->
            <Folder v-if="item.node.isDir" class="size-3.5 shrink-0 text-gray-400" />
            <Image v-else-if="isImageName(item.node.name)" class="size-3.5 shrink-0 text-gray-400" />
            <File v-else class="size-3.5 shrink-0 text-gray-400" />
            <span class="truncate text-gray-500 dark:text-gray-300">
              {{ displayName(item.node) }}
            </span>
          </div>
        </template>
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
