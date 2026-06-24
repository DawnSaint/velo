// 文件树数据层 composable(v0.5.1 抽组件):
//
// 持有 rootNode / dirIndex,封装"激活工作区根 → 拉根 → 按持久化的展开集恢复展开"
// 全流程,以及外部 fs.watch 触发的子树刷新接口(refreshDir)。
//
// 抽离动机:FileTree.vue 同时塞了拖拽 / 行内 input / 右键菜单 / 拖拽源 dataTransfer
// / 模板 / 数据,文件长度 > 700 行,数据 / IO 部分与 UI 状态机几乎正交,先抽这层。
//
// 设计要点:
//  - 所有 TreeNode 必须经 reactive() 包(见 ARCHITECTURE.md §维护者注意点 #23):
//    dirIndex(Map)与 rootNode(ref)持有同一份引用,raw 对象会让 ref 拿 proxy /
//    Map 拿 raw 两份不同步,异步 readDir 完成后模板永远卡"加载中…"。
//  - loadDirChildren **按 name + isDir 复用旧 TreeNode 引用**(见 §28),避免父级
//    computed 重新 reconcile 整树 → 闪烁。
//  - 根的 "加载中…" UI 由 rebuildFromRoot 单独 toggle,loadDirChildren 不再
//    toggle node.loading —— 子目录的 loading 不可见,提早 reactive 通知反而浪费。

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
  /** 把以 srcPath 为前缀的 dirIndex 项全部摘掉(跨目录 move 后清孤儿,见 §30). */
  pruneDirIndexPrefix: (srcPath: string) => void
}

export function useTreeData(): UseTreeData {
  const rootNode = ref<TreeNode | null>(null)
  const dirIndex = new Map<string, TreeNode>()
  const workspace = useWorkspaceStore()

  function makeNode(fullPath: string, name: string, isDir: boolean): TreeNode {
    return reactive({ name, fullPath, isDir }) as TreeNode
  }

  /**
   * 1 级"空目录"探测:在父目录加载完后,对每个子目录后台 readDir 一次,
   * 仅在结果为空时把 children 置 [] —— 用来让模板的"空目录隐藏箭头"逻辑
   * 在用户首次展开父目录时就生效,无需点一下才知道。
   *
   * 设计要点:
   *  - 非空时**不**写 children(留 undefined),交给用户真正展开时再 loadDirChildren
   *    全量加载;避免一次性把整棵树加载,违背懒加载初衷。
   *  - 中途若 children 被别的路径(用户点击展开 / restoreExpanded / fs.watch refresh)
   *    抢先 set 了,放弃覆盖 —— 用 children !== undefined 作 race 守卫。
   *  - 探测失败(权限等)静默,留 undefined,首次用户点击展开时 loadDirChildren 会
   *    报真实错误。
   */
  async function probeDirEmptiness(node: TreeNode): Promise<void> {
    if (!node.isDir || node.children !== undefined) return
    try {
      const entries = await readDir(node.fullPath)
      if (node.children !== undefined) return // 抢先被填了,放弃覆盖
      if (sortEntries(entries).length === 0) {
        node.children = []
      }
    }
    catch {
      // 静默:留 undefined,首次展开 loadDirChildren 会暴露真实错误
    }
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
      // 后台探测每个子目录是否为空 —— fire-and-forget,Vue 在每个完成后单独刷新箭头
      for (const c of next) {
        if (c.isDir && c.children === undefined) void probeDirEmptiness(c)
      }
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
    rootNode.value.loading = true
    try {
      await loadDirChildren(node)
      await restoreExpanded(node)
    }
    finally {
      rootNode.value.loading = false
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
