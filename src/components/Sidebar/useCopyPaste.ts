// 复制 / 粘贴 composable(v0.5.x)。
//
// 单实例"剪贴板":只记源路径 + 源是否目录。粘贴时:
//  - 文件:走 fs.copyFile 二进制复制
//  - 目录:递归 mkdir + copyFile
//  - 目标目录已有同名项:走 uniqueName 自动重命名("foo 副本.md" / "foo 副本 2.md" 等)
//  - 不能把目录粘贴到自身或子目录内(同 move 的 ancestor 守卫)
// 粘贴成功后刷新目标目录 children。clipboard 不清,支持多次粘贴(对齐 VSCode)。

import { ref } from 'vue'
import { copyFile as fsCopyFile, mkdir as fsMkdir, readDir as fsReadDir } from '@/tauri/fs'
import { join } from '@/tauri/path'
import { useNotifyStore } from '@/stores/notify'
import type { TreeNode } from './useTreeData'
import { basename, formatFsError, isAncestorOrSelf, uniqueName } from './treeUtils'

interface UseCopyPasteOptions {
  dirIndex: Map<string, TreeNode>
  loadDirChildren: (node: TreeNode) => Promise<void>
  closeContextMenu: () => void
}

export function useCopyPaste(options: UseCopyPasteOptions) {
  const { dirIndex, loadDirChildren, closeContextMenu } = options
  const notify = useNotifyStore()

  /** 剪贴板:已复制的源路径 + 是否目录;null = 未复制。 */
  const clipboard = ref<{ srcPath: string, isDir: boolean } | null>(null)

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

  return {
    clipboard,
    copyNode,
    pasteInto,
  }
}
