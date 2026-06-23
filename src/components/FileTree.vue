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

import { computed, onMounted, ref, watch } from 'vue'
import { readDir, type DirEntry } from '@/tauri/fs'
import { join, sep } from '@/tauri/path'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDocumentStore } from '@/stores/document'

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

/** 工作区根节点。activeRoot 变化时整树重置。 */
const rootNode = ref<TreeNode | null>(null)

/** dirPath → TreeNode 索引,用于外部 fs.watch 回调按子树重拉。 */
const dirIndex = new Map<string, TreeNode>()

function makeNode(fullPath: string, name: string, isDir: boolean): TreeNode {
  return { name, fullPath, isDir }
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

/** 排序:目录在前,同类按 name 字典序(本地化对比,中文按拼音). */
function sortEntries(entries: DirEntry[]): DirEntry[] {
  const dirs = entries.filter(e => e.isDirectory)
  const files = entries.filter(e => !e.isDirectory)
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
      if (!e.name) continue
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

/** 点击文件:仅 .md / .markdown / .mdown 走打开;其余文件忽略(v0.5.0 不处理). */
const MD_EXT = /\.(md|markdown|mdown)$/i
async function onFileClick(node: TreeNode) {
  if (node.isDir) {
    await toggleDir(node)
    return
  }
  if (!MD_EXT.test(node.name)) return
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
    <!-- 工作区头:展示根名 + 切换 / 关闭按钮 -->
    <div class="flex items-center justify-between gap-1 px-4 py-2">
      <div class="flex min-w-0 items-center gap-1.5">
        <span class="text-sm font-semibold uppercase tracking-wider text-gray-400">
          文件
        </span>
        <span v-if="workspace.activeRoot" class="truncate text-xs text-gray-500" :title="workspace.activeRoot ?? ''">
          / {{ rootDisplay }}
        </span>
      </div>
      <div class="flex shrink-0 items-center gap-0.5">
        <button
          class="rounded p-1 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          :title="workspace.activeRoot ? '更换工作区' : '打开工作区'"
          @click="chooseWorkspace"
        >
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
        </button>
        <button
          v-if="workspace.activeRoot"
          class="rounded p-1 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          title="关闭工作区"
          @click="workspace.closeWorkspace()"
        >
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
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
    <div v-else class="min-h-0 flex-1 overflow-y-auto pb-2">
      <div v-if="rootNode?.loading" class="px-4 py-2 text-xs text-gray-400">
        加载中…
      </div>
      <div v-else-if="rootNode?.error" class="px-4 py-2 text-xs text-red-500" :title="rootNode.error">
        读取目录失败
      </div>
      <div v-else-if="flatItems.length === 0" class="px-4 py-2 text-xs text-gray-400">
        空目录
      </div>
      <div v-else>
        <div
          v-for="item in flatItems"
          :key="item.node.fullPath"
          :style="indentStyle(item.depth)"
          class="group flex cursor-pointer items-center gap-1 py-0.5 pr-2 transition-colors hover:bg-gray-200 dark:hover:bg-gray-800"
          :class="{
            'bg-gray-200 dark:bg-gray-800': !item.node.isDir && item.node.fullPath === activeFile,
          }"
          :title="item.node.fullPath"
          @click="onFileClick(item.node)"
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
          <!-- 图标(目录 / 文件) -->
          <svg v-if="item.node.isDir" class="size-3.5 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <svg v-else class="size-3.5 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span class="truncate text-xs text-gray-700 dark:text-gray-300">
            {{ item.node.name }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
