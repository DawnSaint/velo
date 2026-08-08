// 文件树拖拽 composable:拖拽源 + 内部 move。
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
//
// 内部 move:接收"自家树"拖拽(TREE_PATH_MIME),走 fs.rename 同盘 mv 语义。
// 高亮单点:dragOverTarget 存"解析后的目标目录路径"(不是悬停 row 路径)。
// hover-expand:拖到折叠目录上 500ms 自动展开(VSCode 行为)。
// 完成后的状态更新同 microtask 无 await 间隔(见 docs/architecture/file-tree.md)。

import { ref, type Ref } from 'vue'
import { rename as fsRename } from '@/tauri/fs'
import { join } from '@/tauri/path'
import { useWorkspaceStore } from '@/stores/workspace'
import { useRecentFilesStore } from '@/stores/recentFiles'
import { useDocumentStore } from '@/stores/document'
import { useNotifyStore } from '@/stores/notify'
import { TREE_DIR_PATH_MIME, TREE_PATH_MIME } from '@/components/ProseMirrorEditor/image/treeDrop'
import type { TreeNode } from './useTreeData'
import { basename, formatFsError, isAncestorOrSelf, parentDirOfPath } from './treeUtils'

interface UseDragMoveOptions {
  dirIndex: Map<string, TreeNode>
  loadDirChildren: (node: TreeNode) => Promise<void>
  pruneDirIndexPrefix: (srcPath: string) => void
  rootCollapsed: Ref<boolean>
  isRootNode: (node: TreeNode) => boolean
  closeContextMenu: () => void
  cancelInline: () => void
}

export function useDragMove(options: UseDragMoveOptions) {
  const {
    dirIndex,
    loadDirChildren,
    pruneDirIndexPrefix,
    rootCollapsed,
    isRootNode,
    closeContextMenu,
    cancelInline,
  } = options

  const workspace = useWorkspaceStore()
  const recentFiles = useRecentFilesStore()
  const documentStore = useDocumentStore()
  const notify = useNotifyStore()

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

  function onGlobalDragEnd() {
    dragOverTarget.value = null
    clearHoverExpandTimer()
  }

  return {
    dragOverTarget,
    clearHoverExpandTimer,
    onRowDragStart,
    onRowDragOver,
    onRowDrop,
    onContainerDragOver,
    onContainerDrop,
    onGlobalDragEnd,
  }
}
