<script setup lang="ts">
// 文件树最小可用版(v0.5.0):
//  - 工作区根固定显示;子目录懒加载(展开时才 readDir)
//  - 点击 .md 文件 → 打开到编辑器(走 documentStore.openPath,带 dirty 确认)
//  - 展开状态走 workspaceStore.expandedDirs,持久化到 velo-workspaces.json
//
// 性能取舍:**不虚拟化**。单目录上千文件 readDir 一次性拉 + DOM 渲染。
// 真撞性能墙再上虚拟滚动,见 v0.5-research §5。
//
// 文件分类:lexicographic 排序,目录在文件前;隐藏文件(以 . 开头)默认显示
// (v0.5.0 不加过滤器,后续视用户反馈再加)。
//
// 文件名展示:basename。完整路径走 :title 浮 tooltip。

import { computed, onMounted, reactive, ref, watch } from 'vue'
import { readDir, type DirEntry } from '@/tauri/fs'
import { join, sep } from '@/tauri/path'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDocumentStore } from '@/stores/document'
import { isImageExt } from '@/utils/imagePath'
import { TREE_PATH_MIME } from '@/components/ProseMirrorEditor/image/treeDrop'

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
  node.loading = true
  node.error = undefined
  try {
    const entries = await readDir(node.fullPath)
    const sorted = sortEntries(entries)
    const children: TreeNode[] = []
    for (const e of sorted) {
      const childPath = await join(node.fullPath, e.name)
      const child = makeNode(childPath, e.name, e.isDirectory)
      children.push(child)
      if (e.isDirectory) dirIndex.set(childPath, child)
    }
    node.children = children
  }
  catch (e) {
    console.warn(`读取目录失败 ${node.fullPath}`, e)
    node.error = e instanceof Error ? e.message : String(e)
    node.children = []
  }
  finally {
    node.loading = false
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
  await loadDirChildren(node)
  // 恢复展开 —— 拉根的子,再按 expandedDirs 顺序逐层展开
  // 一次只展开一层:从根的直接子里挑出标记为展开的目录,递归 readDir
  await restoreExpanded(node)
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
 */
interface VisualItem {
  node: TreeNode
  depth: number
  expanded: boolean
}

const flatItems = computed<VisualItem[]>(() => {
  const out: VisualItem[] = []
  if (!rootNode.value) return out
  // 不显示根节点本身(标题已在顶部),从根的 children 开始
  function walk(children: TreeNode[] | undefined, depth: number) {
    if (!children) return
    for (const c of children) {
      const expanded = c.isDir && workspace.isDirExpanded(c.fullPath)
      out.push({ node: c, depth, expanded })
      if (expanded && c.children) walk(c.children, depth + 1)
    }
  }
  walk(rootNode.value.children, 0)
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

onMounted(() => {
  // 已激活工作区在 watch immediate 里建过了;此处只是占位让组件挂上后立刻有内容
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
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
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
        <div
          v-for="item in flatItems"
          :key="item.node.fullPath"
          :style="indentStyle(item.depth)"
          class="group flex cursor-pointer items-center gap-1 py-1 pr-2 text-xs transition-colors hover:bg-gray-200 dark:hover:bg-gray-800"
          :class="{
            'bg-gray-200 dark:bg-gray-800': !item.node.isDir && item.node.fullPath === activeFile,
          }"
          :title="item.node.fullPath"
          :draggable="!item.node.isDir"
          @click="onFileClick(item.node)"
          @dragstart="onRowDragStart($event, item.node)"
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
      </div>
    </div>
  </div>
</template>
