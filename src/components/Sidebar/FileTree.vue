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

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  mkdir as fsMkdir,
  remove as fsRemove,
  rename as fsRename,
  writeTextFile,
} from '@/tauri/fs'
import { join, sep } from '@/tauri/path'
import { confirm as nativeConfirm, message as nativeMessage } from '@/tauri/dialog'
import { revealItemInDir } from '@/tauri/opener'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDocumentStore } from '@/stores/document'
import { TREE_PATH_MIME } from '@/components/ProseMirrorEditor/image/treeDrop'
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
  validateName,
} from './treeUtils'

const workspace = useWorkspaceStore()
const documentStore = useDocumentStore()

const { rootNode, dirIndex, rebuildFromRoot, loadDirChildren, refreshDir, pruneDirIndexPrefix } = useTreeData()

watch(() => workspace.activeRoot, (r) => { void rebuildFromRoot(r) }, { immediate: true })

/** 用户点击展开 / 折叠目录:同步持久化 + 懒加载子。 */
async function toggleDir(node: TreeNode) {
  if (!node.isDir) return
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
  if (!(await documentStore.confirmDiscardIfDirty())) return
  await documentStore.openPath(node.fullPath)
  workspace.setLastFile(node.fullPath)
}

defineExpose({ refreshDir, rebuildFromRoot })

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
  walk(rootNode.value.children, 0)
  if (inline && rootNode.value.fullPath === inline.parentDir) {
    out.push({ kind: 'inlineNew', parentDir: rootNode.value.fullPath, depth: 0, subKind: inline.kind })
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
//  - 树拖 .md:打开该文件 / 同盘 move
//  - 树拖图片:落盘插图 / 同盘 move
//  - OS 拖:走原生 imageUploadPlugin(富文本)/ 文件型 drop 处理(源码模式)

function onRowDragStart(event: DragEvent, node: TreeNode) {
  if (!event.dataTransfer) return
  // 互斥:dragstart 关掉可能挂着的菜单 / 行内 input —— 否则 drop 时全局 pointerdown
  // 可能把行内 input 误提交,菜单也会在拖拽中途残留。
  closeContextMenu()
  cancelInline()
  event.dataTransfer.setData(TREE_PATH_MIME, node.fullPath)
  event.dataTransfer.setData('text/plain', node.fullPath)
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
// 完成后的状态更新同 microtask 无 await 间隔(参考 ARCHITECTURE.md §28):
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
  // 但 types 集合一直可读 —— 用它判定"是自家树拖拽吗"。
  return !!event.dataTransfer?.types?.includes(TREE_PATH_MIME)
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

async function onRowDrop(event: DragEvent, node: TreeNode) {
  if (!dragHasTreePath(event)) return
  event.preventDefault()
  event.stopPropagation()
  clearHoverExpandTimer()
  const srcPath = event.dataTransfer?.getData(TREE_PATH_MIME)
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
  // 容器空白 = 根,根永远展开,不挂 timer
  clearHoverExpandTimer()
}

async function onContainerDrop(event: DragEvent) {
  if (!dragHasTreePath(event)) return
  event.preventDefault()
  clearHoverExpandTimer()
  const srcPath = event.dataTransfer?.getData(TREE_PATH_MIME)
  dragOverTarget.value = null
  if (!srcPath || !workspace.activeRoot) return
  await performMove(srcPath, workspace.activeRoot)
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
    await nativeMessage('不能将目录拖入自身或其子目录', { title: '移动失败', kind: 'warning' })
    return
  }

  const newPath = await join(dstDir, srcName)
  if (newPath === srcPath) return

  try {
    await fsRename(srcPath, newPath)
  }
  catch (e) {
    await nativeMessage(formatFsError(e, '移动失败'), { title: '移动失败', kind: 'error' })
    return
  }

  // —— 写盘成功,接下来全部同步无 await 间隔(loadDirChildren 内的 await 在最后) ——

  // 1) 工作区状态前缀重写(expandedDirs / lastFile)
  workspace.renamePathPrefix(srcPath, newPath)

  // 2) 当前打开文件联动:不重载内容,只换路径(见 §维护者注意点 #26 / #30)
  const cur = documentStore.currentFilePath
  if (cur === srcPath) {
    documentStore.loadContent(documentStore.content, newPath)
  }
  else if (cur && srcNode.isDir && (cur.startsWith(srcPath + '/') || cur.startsWith(srcPath + '\\'))) {
    documentStore.loadContent(documentStore.content, newPath + cur.slice(srcPath.length))
  }

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
}
const contextMenu = ref<ContextMenuState | null>(null)
const contextMenuRef = ref<InstanceType<typeof FileTreeContextMenu> | null>(null)

function isRootNode(node: TreeNode): boolean {
  return workspace.activeRoot !== null && node.fullPath === workspace.activeRoot
}

function onRowContextMenu(event: MouseEvent, node: TreeNode) {
  event.preventDefault()
  // 视口约束:菜单宽 ~160px / 高 ~220px;贴边留 8px 安全距
  const MENU_W = 160
  const MENU_H = 220
  const x = Math.min(event.clientX, window.innerWidth - MENU_W - 8)
  const y = Math.min(event.clientY, window.innerHeight - MENU_H - 8)
  contextMenu.value = { node, x, y }
  cancelInline()
}

function closeContextMenu() {
  contextMenu.value = null
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
    value: kind === 'newFile' ? '未命名文档' : '新文件夹',
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
      // children 更新 + cancelInline 同 microtask,Vue 一次 flush(见 §28)
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
      // 联动当前打开文件:只更新 currentFilePath,不动 content
      if (documentStore.currentFilePath === node.fullPath) {
        documentStore.loadContent(documentStore.content, newPath)
      }
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

/** pathToDelete 是否包含 currentFilePath(目录删除时判定). */
function deleteContainsOpenFile(pathToDelete: string): boolean {
  const cur = documentStore.currentFilePath
  if (!cur) return false
  const s = sep()
  const trimmed = pathToDelete.endsWith(s) ? pathToDelete : pathToDelete + s
  return cur === pathToDelete || cur.startsWith(trimmed)
}

async function confirmAndDelete(node: TreeNode) {
  const isDir = node.isDir
  const name = node.name
  let message: string
  if (isDir) {
    const dirtyOpen = deleteContainsOpenFile(node.fullPath) && documentStore.dirty
    message = dirtyOpen
      ? `「${name}」中有正在编辑且未保存的文件,删除后修改将丢失。\n确定要继续吗？`
      : `确定要删除目录「${name}」及其所有内容吗？`
  }
  else {
    const dirtyOpen = documentStore.currentFilePath === node.fullPath && documentStore.dirty
    message = dirtyOpen
      ? `「${name}」有未保存修改,删除后修改将丢失。\n确定要继续吗？`
      : `确定要删除「${name}」吗？`
  }
  const ok = await nativeConfirm(message, { title: '确认删除', kind: 'warning' })
  if (!ok) return
  const parentDir = parentDirOfPath(node.fullPath)
  try {
    await fsRemove(node.fullPath, { recursive: isDir })
    // children 更新 + 联动关闭文件同 microtask
    const parent = dirIndex.get(parentDir)
    if (parent) await loadDirChildren(parent)
    if (deleteContainsOpenFile(node.fullPath)) {
      documentStore.loadContent('', null)
    }
    closeContextMenu()
  }
  catch (e) {
    await nativeMessage(formatFsError(e, '删除失败'), { title: '删除失败', kind: 'error' })
  }
}

// ========== 在资源管理器中显示 ==========

async function revealInExplorer(node: TreeNode) {
  try { await revealItemInDir(node.fullPath) }
  catch (e) {
    await nativeMessage(formatFsError(e, '打开文件管理器失败'), { title: '操作失败', kind: 'error' })
  }
  finally { closeContextMenu() }
}

// ========== 全局点击 / 键盘 / dragend ==========

function onGlobalPointerDown(event: PointerEvent) {
  // 行内编辑激活:点外部 = 提交
  if (inlineNew.value || inlineRename.value) {
    const target = event.target as Node | null
    if (target) {
      let n: Node | null = target
      while (n) {
        if (n instanceof Element && n.hasAttribute('data-inline-row')) return
        n = n.parentNode
      }
    }
    void submitInline()
    return
  }
  // 上下文菜单激活:点外部 = 关闭
  if (!contextMenu.value) return
  const target = event.target as Node | null
  if (!target) return
  const menuEl = contextMenuRef.value?.rootEl ?? null
  if (menuEl && (menuEl === target || menuEl.contains(target))) return
  closeContextMenu()
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (inlineNew.value || inlineRename.value) cancelInline()
  else if (contextMenu.value) closeContextMenu()
}

function onGlobalDragEnd() {
  dragOverTarget.value = null
  clearHoverExpandTimer()
}

onMounted(() => {
  document.addEventListener('pointerdown', onGlobalPointerDown, true)
  document.addEventListener('keydown', onGlobalKeydown)
  // dragend 兜底:行级 @dragend 在拖拽源被脱开 DOM 时可能丢,文档级保险一份
  document.addEventListener('dragend', onGlobalDragEnd)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onGlobalPointerDown, true)
  document.removeEventListener('keydown', onGlobalKeydown)
  document.removeEventListener('dragend', onGlobalDragEnd)
  clearHoverExpandTimer()
})

const rootDisplay = computed(() => {
  const r = workspace.activeRoot
  if (!r) return ''
  const s = sep()
  const trimmed = r.endsWith(s) ? r.slice(0, -s.length) : r
  return basename(trimmed) || trimmed
})
</script>

<template>
  <div class="velo-file-tree flex h-full min-w-64 flex-col">
    <!-- 工作区头:当前工作区文件夹名 + 切换按钮 -->
    <div v-if="workspace.activeRoot" class="flex items-center justify-between gap-1 px-4 pt-2 pb-1">
      <span class="truncate text-xs font-semibold text-gray-500 dark:text-gray-400" :title="workspace.activeRoot ?? ''">
        {{ rootDisplay }}
      </span>
      <button
        class="shrink-0 rounded p-1 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        title="更换工作区"
        @click="chooseWorkspace"
      >
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1-2 2H4a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
      </button>
    </div>

    <!-- 空态:没选工作区 -->
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
      class="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-2"
      :class="{ 'bg-blue-50/40 dark:bg-blue-950/20': dragOverTarget !== null && dragOverTarget === workspace.activeRoot }"
      @dragover.self="onContainerDragOver"
      @drop.self="onContainerDrop"
      @dragleave.self="dragOverTarget = null"
    >
      <div v-if="rootNode?.loading" class="px-4 py-0.5 text-xs text-gray-400">
        加载中…
      </div>
      <div v-else-if="rootNode?.error" class="px-4 py-0.5 text-xs text-red-500" :title="rootNode.error">
        读取目录失败
      </div>
      <div v-else-if="flatItems.length === 0" class="px-4 py-0.5 text-xs text-gray-400">
        空目录
      </div>
      <div v-else>
        <template v-for="item in flatItems" :key="item.kind === 'inlineNew' ? `inlineNew-${item.parentDir}` : item.node.fullPath">
          <!-- ============ 行内新建(挂目标目录末尾)============ -->
          <div
            v-if="item.kind === 'inlineNew'"
            data-inline-row
            :style="indentStyle(item.depth)"
            class="flex items-center gap-1 py-1 pr-2 text-xs"
          >
            <span class="flex size-4 shrink-0" />
            <svg v-if="item.subKind === 'newDir'" class="size-3.5 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <svg v-else class="size-3.5 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <input
              :ref="bindInlineInputEl"
              v-model="inlineNew!.value"
              type="text"
              spellcheck="false"
              class="min-w-0 flex-1 rounded-sm bg-blue-50 px-1 py-0.5 text-gray-800 outline-none ring-1 ring-blue-300 focus:ring-blue-500 dark:bg-blue-950/40 dark:text-gray-100 dark:ring-blue-700"
              :title="inlineNew!.error ?? ''"
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
            class="flex items-center gap-1 py-1 pr-2 text-xs"
          >
            <span class="flex size-4 shrink-0" />
            <svg v-if="item.node.isDir" class="size-3.5 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <svg v-else-if="isImageName(item.node.name)" class="size-3.5 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            <svg v-else class="size-3.5 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <input
              :ref="bindInlineInputEl"
              v-model="inlineRename!.value"
              type="text"
              spellcheck="false"
              class="min-w-0 flex-1 rounded-sm bg-blue-50 px-1 py-0.5 text-gray-800 outline-none ring-1 ring-blue-300 focus:ring-blue-500 dark:bg-blue-950/40 dark:text-gray-100 dark:ring-blue-700"
              :title="inlineRename!.error ?? ''"
              @keydown.enter.prevent="submitInline"
              @keydown.esc.prevent="cancelInline"
            >
            <span v-if="!item.node.isDir && /\.md$/i.test(item.node.name)" class="shrink-0 text-gray-500">.md</span>
          </div>

          <!-- ============ 普通行 ============ -->
          <div
            v-else
            :style="indentStyle(item.depth)"
            class="group flex cursor-pointer items-center gap-1 py-1.5 pr-2 text-xs transition-colors hover:bg-gray-200 dark:hover:bg-gray-800"
            :class="{
              'bg-gray-200 dark:bg-gray-800': !item.node.isDir && item.node.fullPath === activeFile,
              'ring-1 ring-blue-400 dark:ring-blue-500': item.node.isDir && item.node.fullPath === dragOverTarget,
            }"
            :title="item.node.fullPath"
            draggable="true"
            @click="onFileClick(item.node)"
            @dragstart="onRowDragStart($event, item.node)"
            @dragover="onRowDragOver($event, item.node)"
            @drop="onRowDrop($event, item.node)"
            @dragend="dragOverTarget = null"
            @contextmenu.prevent="onRowContextMenu($event, item.node)"
          >
            <!-- 展开箭头 / 文件占位 -->
            <span class="flex size-4 shrink-0 items-center justify-center">
              <svg
                v-if="item.node.isDir"
                class="size-2.5 text-gray-400 transition-transform"
                :class="{ 'rotate-90': item.expanded }"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </span>
            <!-- 图标(目录 / 图片 / .md 文件) -->
            <svg v-if="item.node.isDir" class="size-3.5 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <svg v-else-if="isImageName(item.node.name)" class="size-3.5 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            <svg v-else class="size-3.5 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span class="truncate text-gray-700 dark:text-gray-300">
              {{ item.node.name }}
            </span>
          </div>
        </template>
      </div>
    </div>
  </div>

  <!-- 右键菜单(Teleport 在子组件内) -->
  <FileTreeContextMenu
    v-if="contextMenu"
    ref="contextMenuRef"
    :x="contextMenu.x"
    :y="contextMenu.y"
    :node="contextMenu.node"
    :is-root="isRootNode(contextMenu.node)"
    @new-file="openInlineNew(targetDirForNew(contextMenu.node), 'newFile')"
    @new-dir="openInlineNew(targetDirForNew(contextMenu.node), 'newDir')"
    @rename="openInlineRename(contextMenu.node)"
    @delete="confirmAndDelete(contextMenu.node)"
    @reveal="revealInExplorer(contextMenu.node)"
  />
</template>
