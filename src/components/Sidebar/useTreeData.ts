// 文件树数据层 composable(v0.5.1 抽组件):
//
// 持有 rootNode / dirIndex,封装"激活工作区根 → 拉根 → 按持久化的展开集恢复展开"
// 全流程,以及外部 fs.watch 触发的子树刷新接口(refreshDir)。
//
// 抽离动机:FileTree.vue 同时塞了拖拽 / 行内 input / 右键菜单 / 拖拽源 dataTransfer
// / 模板 / 数据,文件长度 > 700 行,数据 / IO 部分与 UI 状态机几乎正交,先抽这层。
//
// 设计要点:
//  - 所有 TreeNode 必须经 reactive() 包(见 docs/architecture/file-tree.md 的 TreeNode reactivity contract):
//    dirIndex(Map)与 rootNode(ref)持有同一份引用,raw 对象会让 ref 拿 proxy /
//    Map 拿 raw 两份不同步,异步 readDir 完成后模板永远卡"加载中…"。
//  - loadDirChildren **按 name + isDir 复用旧 TreeNode 引用**(见 docs/architecture/file-tree.md),避免父级
//    computed 重新 reconcile 整树 → 闪烁。
//  - 根的 "加载中…" UI 由 rebuildFromRoot 单独 toggle,loadDirChildren 不再
//    toggle node.loading —— 子目录的 loading 不可见,提早 reactive 通知反而浪费。
//    rebuildFromRoot 的 loading 为延迟 toggle(200ms 阈值):本地 readDir 通常
//    <50ms,同步置 true 会导致模板闪一帧"加载中…"再被实际内容替换;阈值内
//    完成的加载不置 loading,只有真正慢的大目录 / 网络盘才显示"加载中…"。

import { reactive, ref, type Ref } from 'vue'
import { readDir } from '@/tauri/fs'
import { join } from '@/tauri/path'
import { basename, sortEntries } from './treeUtils'
import { useWorkspaceStore } from '@/stores/workspace'

export interface TreeNode {
  name: string
  fullPath: string
  isDir: boolean
  /** 子节点;目录懒加载,undefined = 还没拉过,空数组 = 拉过但为空。 */
  children?: TreeNode[]
  /** 懒加载状态(仅根使用,子树不可见). */
  loading?: boolean
  /** 上次 readDir 失败,展示错误占位 */
  error?: string
}

export interface UseTreeData {
  rootNode: Ref<TreeNode | null>
  dirIndex: Map<string, TreeNode>
  makeNode: (fullPath: string, name: string, isDir: boolean) => TreeNode
  rebuildFromRoot: (root: string | null) => Promise<void>
  loadDirChildren: (node: TreeNode) => Promise<void>
  restoreExpanded: (node: TreeNode) => Promise<void>
  refreshDir: (dirPath: string) => Promise<void>
  /** 把以 srcPath 为前缀的 dirIndex 项全部摘掉(跨目录 move 后清孤儿,见 docs/architecture/file-tree.md). */
  pruneDirIndexPrefix: (srcPath: string) => void
}

export function useTreeData(): UseTreeData {
  const rootNode = ref<TreeNode | null>(null)
  const dirIndex = new Map<string, TreeNode>()
  const workspace = useWorkspaceStore()

  function makeNode(fullPath: string, name: string, isDir: boolean): TreeNode {
    return reactive({ name, fullPath, isDir }) as TreeNode
  }

  async function loadDirChildren(node: TreeNode): Promise<void> {
    if (!node.isDir) return
    node.error = undefined
    try {
      const entries = await readDir(node.fullPath)
      const sorted = sortEntries(entries)
      // 复用旧 children:同名 + 同 isDir 的 TreeNode 保留引用,新增 / 移除只动 diff 部分。
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
          next.push(existing)
        }
        else {
          if (existing?.isDir) dirIndex.delete(existing.fullPath)
          const childPath = await join(node.fullPath, e.name)
          const child = makeNode(childPath, e.name, e.isDirectory)
          next.push(child)
          if (e.isDirectory) dirIndex.set(childPath, child)
        }
      }
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

  async function restoreExpanded(node: TreeNode): Promise<void> {
    if (!node.children) return
    for (const c of node.children) {
      if (!c.isDir) continue
      if (workspace.isDirExpanded(c.fullPath)) {
        if (c.children === undefined) await loadDirChildren(c)
        await restoreExpanded(c)
      }
    }
  }

  async function rebuildFromRoot(root: string | null): Promise<void> {
    dirIndex.clear()
    if (!root) {
      rootNode.value = null
      return
    }
    const node = makeNode(root, basename(root) || root, true)
    dirIndex.set(root, node)
    rootNode.value = node
    // 延迟显示 "加载中…"：本地 readDir 通常 <50ms，同步置 loading=true 会导致
    // 模板闪一帧"加载中…"再被实际内容替换。阈值 200ms 内完成的加载不闪。
    const loadingTimer = setTimeout(() => {
      if (rootNode.value === node) node.loading = true
    }, 200)
    try {
      await loadDirChildren(node)
      await restoreExpanded(node)
    }
    finally {
      clearTimeout(loadingTimer)
      node.loading = false
    }
  }

  async function refreshDir(dirPath: string): Promise<void> {
    const node = dirIndex.get(dirPath)
    if (!node) return
    await loadDirChildren(node)
    await restoreExpanded(node)
  }

  function pruneDirIndexPrefix(srcPath: string): void {
    const sep1 = srcPath + '/'
    const sep2 = srcPath + '\\'
    for (const key of Array.from(dirIndex.keys())) {
      if (key === srcPath || key.startsWith(sep1) || key.startsWith(sep2)) {
        dirIndex.delete(key)
      }
    }
  }

  return {
    rootNode,
    dirIndex,
    makeNode,
    rebuildFromRoot,
    loadDirChildren,
    restoreExpanded,
    refreshDir,
    pruneDirIndexPrefix,
  }
}
