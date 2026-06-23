<script setup lang="ts">
// 文件树最小可用版(v0.5.0) + 右键菜单 CRUD(v0.5.1):
//  - 工作区根固定显示;子目录懒加载(展开时才 readDir)
//  - 点击 .md 文件 → 打开到编辑器(走 documentStore.openPath,带 dirty 确认)
//  - 右键 → 新建 / 重命名 / 删除 / 在资源管理器中显示(每项 destructive op 必 confirm)
//  - 展开状态走 workspaceStore.expandedDirs,持久化到 velo-workspaces.json
//
// 性能取舍:**不虚拟化**。单目录上千文件 readDir 一次性拉 + DOM 渲染。
// 真撞性能墙再上虚拟滚动,见 v0.5-research §5。
//
// 文件分类:lexicographic 排序,目录在文件前;隐藏文件(以 . 开头)默认显示
//
// 文件名展示:basename。完整路径走 :title 浮 tooltip。
//
// 新建 / 重命名走「行内 input」(v0.5.1 调整,不再用 modal):
//  - 新建文件 → 在目标目录末尾追加一行可编辑 input,默认 "未命名文档" + 静态 ".md" 后缀
//  - 新建目录 → 同上,默认 "新文件夹",无后缀
//  - 重命名 .md → 把原行换成 input,baseName 预填,静态 ".md" 后缀不可编辑
//  - 重命名其它(目录 / 图片 / .markdown 等)→ input 含完整名
//  - Enter 提交、Esc 取消、点外部提交(对齐 VSCode / Finder 约定)
//  - 校验失败不关 input,焦点留在 input,title 提示错误
//  - 「在资源管理器中显示」走 plugin-opener 的 revealItemInDir(plugin-shell.open
//    只能"用默认应用打开",不能在文件管理器里高亮该文件;plugin-opener 专门补这条)

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  mkdir as fsMkdir,
  readDir,
  remove as fsRemove,
  rename as fsRename,
  writeTextFile,
  type DirEntry,
} from '@/tauri/fs'
import { join, sep } from '@/tauri/path'
import { confirm as nativeConfirm, message as nativeMessage } from '@/tauri/dialog'
import { revealItemInDir } from '@/tauri/opener'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDocumentStore } from '@/stores/document'
import { isImageExt } from '@/utils/imagePath'
import { TREE_PATH_MIME } from '@/components/ProseMirrorEditor/image/treeDrop'
import FileTreeContextMenu from './FileTreeContextMenu.vue'

const workspace = useWorkspaceStore()
const documentStore = useDocumentStore()

interface TreeNode {
  name: string
  fullPath: string
  isDir: boolean
  /** 子节点;目录懒加载,undefined = 还没拉过,空数组 = 拉过但为空。 */
  children?: TreeNode[]
  /** 懒加载状态:用于显示 spinner 与避免重复 readDir */
  loading?: boolean
  /** 上次 readDir 失败,展示错误占位 */
  error?: string
}

/**
 * 工作区根节点。activeRoot 变化时整树重置。
 *
 * 关键:所有 TreeNode 必须经 reactive() 包,保证 loadDirChildren / refreshDir
 * 里对 node.loading / node.children 的 mutate 触发模板重渲;否则 dirIndex
 * 里持有的 raw 对象与 rootNode.value 的 proxy 是两份,异步 readDir 完成后
 * 模板仍读到 loading=true,卡死在"加载中…"。
 */
const rootNode = ref<TreeNode | null>(null)

/** dirPath → reactive TreeNode 索引,用于外部 fs.watch 回调按子树重拉。 */
const dirIndex = new Map<string, TreeNode>()

function makeNode(fullPath: string, name: string, isDir: boolean): TreeNode {
  return reactive({ name, fullPath, isDir }) as TreeNode
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

/** 仅展示 .md / .markdown / .mdown 文件,以及图片(png/jpg/jpeg/gif/webp/svg/bmp/avif,
 *  见 imagePath.IMAGE_EXTS —— 图片能拖进编辑器插入,故也需在树里可见)。
 *  隐藏目录(以 . 开头,如 .git/.vscode)整段过滤。
 *  非隐藏目录无论是否含 .md 都保留(不递归预扫,违背懒加载;空文件夹用户可自行收起)。 */
const MD_EXT_RE = /\.(md|markdown|mdown)$/i
function isVisible(entry: DirEntry): boolean {
  if (!entry.name) return false
  if (entry.isDirectory) return !entry.name.startsWith('.')
  if (MD_EXT_RE.test(entry.name)) return true
  // 图片:取末尾扩展名比对 isImageExt(无扩展 / 末尾是点 → extFromFileName 兜底为 'bin',不命中)
  const dot = entry.name.lastIndexOf('.')
  if (dot === -1 || dot === entry.name.length - 1) return false
  return isImageExt(entry.name.slice(dot + 1))
}

/** 判断文件名是否图片(供 drop 源 / 模板图标分支共用)。 */
function isImageName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot === -1 || dot === name.length - 1) return false
  return isImageExt(name.slice(dot + 1))
}

/** 排序:目录在前,同类按 name 字典序(本地化对比,中文按拼音). */
function sortEntries(entries: DirEntry[]): DirEntry[] {
  const visible = entries.filter(isVisible)
  const dirs = visible.filter(e => e.isDirectory)
  const files = visible.filter(e => !e.isDirectory)
  const cmp = (a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name, 'zh-Hans-CN')
  dirs.sort(cmp)
  files.sort(cmp)
  return [...dirs, ...files]
}

async function loadDirChildren(node: TreeNode): Promise<void> {
  if (!node.isDir) return
  node.error = undefined
  try {
    const entries = await readDir(node.fullPath)
    const sorted = sortEntries(entries)
    // 复用旧 children:同名 + 同 isDir 的 TreeNode 保留引用,新增 / 移除只动 diff 部分。
    // 否则每次刷新都给所有 child 重新 `reactive(...)` → Vue 看到新 proxy 引用,
    // 即使 key(fullPath)不变,父级 computed 重新 reconcile → 整树重渲闪烁。
    const oldByName = new Map<string, TreeNode>()
    for (const c of node.children ?? []) {
      oldByName.set(c.name, c)
    }
    const next: TreeNode[] = []
    const seen = new Set<string>()
    for (const e of sorted) {
      seen.add(e.name)
      const existing = oldByName.get(e.name)
      if (existing && existing.isDir === e.isDirectory) {
        // 复用:reactive 引用不变 → 子树 props 不变 → Vue 跳过
        next.push(existing)
      }
      else {
        // 新条目(新增 / 同名但 isDir 改变);若旧的曾是 dir,从 dirIndex 摘掉
        if (existing?.isDir) dirIndex.delete(existing.fullPath)
        const childPath = await join(node.fullPath, e.name)
        const child = makeNode(childPath, e.name, e.isDirectory)
        next.push(child)
        if (e.isDirectory) dirIndex.set(childPath, child)
      }
    }
    // 消失的目录节点从 dirIndex 清理
    for (const c of node.children ?? []) {
      if (c.isDir && !seen.has(c.name)) dirIndex.delete(c.fullPath)
    }
    node.children = next
  }
  catch (e) {
    console.warn(`读取目录失败 ${node.fullPath}`, e)
    node.error = e instanceof Error ? e.message : String(e)
    node.children = []
  }
}

/** 工作区根切换:重建根节点并按"持久化的展开集"自动恢复展开。 */
async function rebuildFromRoot(root: string | null) {
  dirIndex.clear()
  if (!root) {
    rootNode.value = null
    return
  }
  const node = makeNode(root, basename(root) || root, true)
  dirIndex.set(root, node)
  rootNode.value = node
  // 根的"加载中…" UI 由调用方 toggle(其它子目录的 loading 不可见,不污染子树闪烁)
  rootNode.value.loading = true
  try {
    await loadDirChildren(node)
    // 恢复展开 —— 拉根的子,再按 expandedDirs 顺序逐层展开
    // 一次只展开一层:从根的直接子里挑出标记为展开的目录,递归 readDir
    await restoreExpanded(node)
  }
  finally {
    rootNode.value.loading = false
  }
}

async function restoreExpanded(node: TreeNode) {
  if (!node.children) return
  for (const c of node.children) {
    if (!c.isDir) continue
    if (workspace.isDirExpanded(c.fullPath)) {
      if (c.children === undefined) await loadDirChildren(c)
      await restoreExpanded(c)
    }
  }
}

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

/** 点击文件:已在 sortEntries 阶段过滤过非 .md;此处只是兜底重复一次,防外部 refresh 漏过. */
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

/** 暴露给外部(App.vue 的 fs.watch 回调):某子树脏 → 重拉它的 children. */
async function refreshDir(dirPath: string) {
  const node = dirIndex.get(dirPath)
  if (!node) return
  await loadDirChildren(node)
  await restoreExpanded(node)
}
defineExpose({ refreshDir, rebuildFromRoot })

const activeFile = computed(() => documentStore.currentFilePath)

/**
 * 把树拍平成可视项,缩进按层级。这样模板能一个 v-for 渲染,不用递归组件,
 * 大目录滚动时不会因为递归组件 unmount 误炸性能。
 *
 * v0.5.1 起,inlineNew 项混在 flatItems 里(在目标目录子树末尾追加一个 input 行);
 * 模板用 v-if 分支区分普通行 / 行内新建 / 行内重命名。
 */
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
      // 行内新建:挂在本目录子树末尾(depth = 本目录 depth + 1)
      // —— 父目录未展开时 openInlineNew 已先 expand,所以这里 expanded 一定为 true
      if (inline && c.isDir && c.fullPath === inline.parentDir) {
        out.push({ kind: 'inlineNew', parentDir: c.fullPath, depth: depth + 1, subKind: inline.kind })
      }
    }
  }
  walk(rootNode.value.children, 0)
  // 行内新建挂在工作区根:root 的 children 始终展示(depth = 0)
  if (inline && rootNode.value.fullPath === inline.parentDir) {
    out.push({ kind: 'inlineNew', parentDir: rootNode.value.fullPath, depth: 0, subKind: inline.kind })
  }
  return out
})

function indentStyle(depth: number): { paddingLeft: string } {
  // 12px 基础 + 每层 12px;深层不至于挤压
  return { paddingLeft: `${12 + depth * 12}px` }
}

async function chooseWorkspace() {
  await workspace.pickWorkspace()
}

/**
 * 文件树行 → 编辑器的拖拽信号 MIME(定义在 treeDrop.ts,与编辑器 drop 处理器共用,
 * 避免两处各写一份字符串漂移)。
 *
 * 用自定义 MIME(而非纯 text/plain)承载 fullPath,让编辑器的 drop 处理器
 * 能区分"从 velo 文件树拖"与"从操作系统拖文件进来"两种来源:
 *  - 树拖 .md:打开该文件(confirmDiscardIfDirty + openPath)
 *  - 树拖图片:走 saveImageAssetFromPath 落盘 + 插入
 *  - OS 拖:走原生 imageUploadPlugin(富文本)/ 文件型 drop 处理(源码模式)
 *
 * 同时也写一份 text/plain = fullPath,系统外消费(例如拖到终端贴路径)无害。
 */

/** 拖拽源:把 fullPath 写进 dataTransfer。目录由模板 `:draggable="!item.node.isDir"`
 *  阻断,此处不再重复守卫。 */
function onRowDragStart(event: DragEvent, node: TreeNode) {
  if (!event.dataTransfer) return
  event.dataTransfer.setData(TREE_PATH_MIME, node.fullPath)
  event.dataTransfer.setData('text/plain', node.fullPath)
  // 用 'copyLink' 而不是单一 'copy'/'link':PM / CM6 的 dragover 不会把 dropEffect 强制
  // 设成 'link',若 effectAllowed 写死 'link' 与 UA 默认计算出的 dropEffect 不兼容,
  // 浏览器会把 dropEffect 钉成 'none' → 编辑器上显示禁止符,严格 UA 直接吞 drop。
  // 'copyLink' 同时接纳 copy / link 两种 effect,语义上图片=复制引用、.md=导航打开都能匹配。
  event.dataTransfer.effectAllowed = 'copyLink'
}

// ========== 右键菜单(v0.5.1) ==========
//
// 单实例菜单:右键 row → 记下 node + 鼠标位置 → 浮层定位到 (x,y);
// 点别处 / Escape 关闭。菜单 UI 在 `FileTreeContextMenu.vue`(纯展示 + 事件转发);
// 业务逻辑(openInlineNew / confirmAndDelete / revealInExplorer)留在 FileTree。
// 组件通过 `defineExpose({ rootEl })` 把 Teleport 后的 DOM ref 暴露出来,
// FileTree 的全局 pointerdown handler 拿这个 ref 判定"点外部"。
interface ContextMenuState {
  node: TreeNode
  /** 视口坐标,fixed 定位用 */
  x: number
  y: number
}
const contextMenu = ref<ContextMenuState | null>(null)

/** 菜单是否针对根(工作区根目录 = workspace.activeRoot);根禁止删除。 */
function isRootNode(node: TreeNode): boolean {
  return workspace.activeRoot !== null && node.fullPath === workspace.activeRoot
}

function onRowContextMenu(event: MouseEvent, node: TreeNode) {
  event.preventDefault()
  // 视口尺寸约束:菜单宽 160px,菜单高 ~5 项 × 28px ≈ 180px;超界往回拉
  // (留 8px 边距,免得贴边)。不接管滚动事件 → 滚动时菜单不跟随是 acceptable。
  const MENU_W = 160
  const MENU_H = 220
  const x = Math.min(event.clientX, window.innerWidth - MENU_W - 8)
  const y = Math.min(event.clientY, window.innerHeight - MENU_H - 8)
  contextMenu.value = { node, x, y }
  // 互斥:开菜单时关掉可能挂着的行内编辑
  cancelInline()
}

function closeContextMenu() {
  contextMenu.value = null
}

/** 取该节点的「父目录」绝对路径。删除 / 重命名后用这个 refresh 父目录的 children。
 *  注意:右键菜单「新建 X」的目标目录另走 targetDirForNew —— 目录节点 = 自身,
 *  文件节点 = 父目录(目录右键 = 进目录,文件右键 = 加兄弟,符合 Finder / VSCode 约定)。 */
function parentDirOfSync(node: TreeNode): string {
  const p = node.fullPath
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i <= 0 ? p : p.slice(0, i)
}

/** 「新建文件 / 新建文件夹」的目标目录:
 *  - 目录节点 → 该目录自身(行内 input 挂在本目录末尾)
 *  - 文件节点 → 父目录(创建兄弟项)
 *  工作区根不在 flatItems 视图里,不会出现右键场景。 */
function targetDirForNew(node: TreeNode): string {
  return node.isDir ? node.fullPath : parentDirOfSync(node)
}

// ========== 行内 input:新建 / 重命名(v0.5.1 调整) ==========
//
// 不再走 modal,改成行内 input(对 VSCode / Finder):
//  - 新建:在目标目录末尾插入一行 input
//  - 重命名:把原行替换成 input(同 key,Vue 复用 DOM)
//  - Enter 提交、Esc 取消、点外部提交(对齐 VSCode 约定)
//  - 校验失败不关 input,title 显示错误
//  - .md 后缀走静态 span,input 不含 .md —— 用户不可编辑后缀
//
// 状态用 inlineNew / inlineRename 两个 ref 互斥;flatItems 把 inlineNew 当
// 一种特殊 VisualItem 插入树末尾,inlineRename 复用原 node 行(v-else-if 分支)。

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

/** v-for 内拿 input ref:Vue 3 在 v-for 里用 string ref 会收成数组,
 *  函数 ref 干净,但 TS 推断要把签名写明白免得 volar 报"ref 不接受"。 */
function bindInlineInputEl(el: Element | { $el?: unknown } | null) {
  inlineInputEl.value = el instanceof HTMLInputElement ? el : null
}

const FORBIDDEN_NAME_CHARS = /[\\/:*\?"<>|\0]/

function validateName(raw: string, parentDir: string, ignoreName: string | null): string | null {
  const name = raw.trim()
  if (!name) return '名称不能为空'
  if (name === '.' || name === '..') return '不能使用 . 或 ..'
  if (FORBIDDEN_NAME_CHARS.test(name)) return '名称包含非法字符 (/ \\ : * ? " < > |)'
  // 同名冲突:在 parentDir 的已加载 children 里查;若该目录还没展开也没关系——
  // 后端 fs.mkdir / writeTextFile / rename 自身会 reject,届时 catch 显式 message。
  const parent = dirIndex.get(parentDir)
  if (parent?.children && name !== ignoreName) {
    if (parent.children.some(c => c.name === name)) return '已存在同名项'
  }
  return null
}

/** 取「最终落地名」(.md 文件: input + ".md"; 其它 / 目录: 原值)。 */
function finalName(value: string, node: TreeNode | null, isNewFile: boolean): string {
  if (node) {
    // 重命名:.md 文件 input 已是去后缀形式,加回 .md;其它 / 目录原值
    return node.isDir || !/\.md$/i.test(node.name) ? value : `${value}.md`
  }
  // 新建
  return isNewFile ? `${value}.md` : value
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
      if (parent.children === undefined) {
        await loadDirChildren(parent)
      }
    }
  }
  inlineNew.value = {
    parentDir,
    kind,
    value: kind === 'newFile' ? '未命名文档' : '新文件夹',
    error: null,
  }
  await focusInlineNextTick()
  // 行可能落在折叠区或视口外,确保可见
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
    if (!value.trim()) { inlineNew.value.error = '名称不能为空'; return }
    const fullName = finalName(value, null, kind === 'newFile')
    const err = validateName(fullName, parentDir, null)
    if (err) { inlineNew.value.error = err; return }
    const targetPath = await join(parentDir, fullName)
    try {
      if (kind === 'newFile') await writeTextFile(targetPath, '')
      else await fsMkdir(targetPath)
      // children 更新 + cancelInline 合并到同一 microtask(无 await 间隔),
      // Vue 一次 flush 渲染,避免两帧闪烁(children 先变、inline 后关)。
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
    const fullName = finalName(value, node, false)
    const parentDir = parentDirOfSync(node)
    const err = validateName(fullName, parentDir, node.name)
    if (err) { inlineRename.value.error = err; return }
    const newPath = await join(parentDir, fullName)
    if (newPath === node.fullPath) { cancelInline(); return }
    try {
      await fsRename(node.fullPath, newPath)
      // 联动当前打开文件:只更新 currentFilePath,不动 content(走 store.loadContent(content, newPath))
      if (documentStore.currentFilePath === node.fullPath) {
        documentStore.loadContent(documentStore.content, newPath)
      }
      // children 更新 + cancelInline 合并到同一 microtask
      const parent = dirIndex.get(parentDir)
      if (parent) await loadDirChildren(parent)
      cancelInline()
    }
    catch (e) {
      inlineRename.value.error = formatFsError(e, '重命名失败')
    }
  }
}

function formatFsError(e: unknown, prefix: string): string {
  const msg = e instanceof Error ? e.message : (typeof e === 'string' ? e : JSON.stringify(e))
  return `${prefix}:${msg}`
}

// ========== 删除 + 联动当前打开文件 ==========

/** pathToDelete 是否包含 currentFilePath(目录删除时判定):
 *  仅在 currentFilePath 非空 + pathToDelete 是其祖先(含自身)时返回 true。 */
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
    const containsOpen = deleteContainsOpenFile(node.fullPath)
    const dirtyOpen = containsOpen && documentStore.dirty
    if (dirtyOpen) {
      message = `「${name}」中有正在编辑且未保存的文件,删除后修改将丢失。\n确定要继续吗？`
    }
    else {
      message = `确定要删除目录「${name}」及其所有内容吗？`
    }
  }
  else {
    const isOpen = documentStore.currentFilePath === node.fullPath
    const dirtyOpen = isOpen && documentStore.dirty
    if (dirtyOpen) {
      message = `「${name}」有未保存修改,删除后修改将丢失。\n确定要继续吗？`
    }
    else {
      message = `确定要删除「${name}」吗？`
    }
  }
  const ok = await nativeConfirm(message, { title: '确认删除', kind: 'warning' })
  if (!ok) return
  const parentDir = parentDirOfSync(node)
  try {
    await fsRemove(node.fullPath, { recursive: isDir })
    // children 更新 + 联动关闭文件合并到同一 microtask(无 await 间隔),Vue 一次 flush
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
  try {
    await revealItemInDir(node.fullPath)
  }
  catch (e) {
    await nativeMessage(formatFsError(e, '打开文件管理器失败'), { title: '操作失败', kind: 'error' })
  }
  finally {
    closeContextMenu()
  }
}

// ========== 全局点击 / 键盘关闭 ==========

function onGlobalPointerDown(event: PointerEvent) {
  // 行内编辑激活:点外部 = 提交
  if (inlineNew.value || inlineRename.value) {
    const target = event.target as Node | null
    if (target) {
      // 上溯找 data-inline-row 标记的容器;行内 input 行的最外层 div 都带这个属性
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
  // FileTreeContextMenu 通过 defineExpose({ rootEl }) 暴露 Teleport 后的 DOM 节点
  const menuEl = contextMenuRef.value?.rootEl ?? null
  if (menuEl && (menuEl === target || menuEl.contains(target))) return
  closeContextMenu()
}

const contextMenuRef = ref<InstanceType<typeof FileTreeContextMenu> | null>(null)

function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (inlineNew.value || inlineRename.value) cancelInline()
  else if (contextMenu.value) closeContextMenu()
}

onMounted(() => {
  // 已激活工作区在 watch immediate 里建过了;此处只是占位让组件挂上后立刻有内容
  document.addEventListener('pointerdown', onGlobalPointerDown, true)
  document.addEventListener('keydown', onGlobalKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onGlobalPointerDown, true)
  document.removeEventListener('keydown', onGlobalKeydown)
})

const rootDisplay = computed(() => {
  const r = workspace.activeRoot
  if (!r) return ''
  // 去掉末尾的分隔符;basename 兜底显示
  const s = sep()
  const trimmed = r.endsWith(s) ? r.slice(0, -s.length) : r
  return basename(trimmed) || trimmed
})
</script>

<template>
  <div class="velo-file-tree flex h-full min-w-64 flex-col">
    <!-- 工作区头:仅显示当前工作区文件夹名 + 切换按钮(更换工作区);不再有"文件 /"前缀,
         也不再有关闭按钮 —— 关闭工作区是低频且容易误触的操作。 -->
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
    <div v-else class="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-2">
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
            }"
            :title="item.node.fullPath"
            :draggable="!item.node.isDir"
            @click="onFileClick(item.node)"
            @dragstart="onRowDragStart($event, item.node)"
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
            <!-- 图片行:用图片图标,提示"可拖入编辑器插入" -->
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

  <!-- ========== 右键菜单(v0.5.1 抽组件)Teleport 由 FileTreeContextMenu 内部处理 ========== -->
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
