// 行内编辑 composable:新建 / 重命名(v0.5.1)。
//
// 不走 modal,改行内 input(对齐 VSCode / Finder):
//  - 新建:在目标目录末尾插入一行 input
//  - 重命名:把原行替换成 input(同 key,Vue 复用 DOM)
//  - Enter 提交、Esc 取消、点外部提交
//  - 校验失败不关 input,title 显示错误
//  - .md 后缀走静态 span,input 不含 .md —— 用户不可编辑后缀

import { ref, nextTick } from 'vue'
import { mkdir as fsMkdir, rename as fsRename, writeTextFile } from '@/tauri/fs'
import { join } from '@/tauri/path'
import { useWorkspaceStore } from '@/stores/workspace'
import { useRecentFilesStore } from '@/stores/recentFiles'
import { useDocumentStore } from '@/stores/document'
import type { TreeNode } from './useTreeData'
import { finalName, formatFsError, parentDirOfPath, validateName } from './treeUtils'

export interface InlineNewState {
  parentDir: string
  kind: 'newFile' | 'newDir'
  value: string
  error: string | null
}

export interface InlineRenameState {
  node: TreeNode
  /** base name(.md 文件去掉 .md 后缀;其它含完整名) */
  value: string
  error: string | null
}

interface UseInlineEditOptions {
  dirIndex: Map<string, TreeNode>
  loadDirChildren: (node: TreeNode) => Promise<void>
  closeContextMenu: () => void
}

export function useInlineEdit(options: UseInlineEditOptions) {
  const { dirIndex, loadDirChildren, closeContextMenu } = options
  const workspace = useWorkspaceStore()
  const recentFiles = useRecentFilesStore()
  const documentStore = useDocumentStore()

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

  return {
    inlineNew,
    inlineRename,
    inlineInputEl,
    bindInlineInputEl,
    openInlineNew,
    openInlineRename,
    cancelInline,
    submitInline,
  }
}
