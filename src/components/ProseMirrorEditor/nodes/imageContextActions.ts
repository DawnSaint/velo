// 图片节点右键菜单的命令实现 —— EditorInner 收到菜单 action 后分发到这里。
//
// 分层:plugin 只负责「拦截 + 解析上下文」,Vue 菜单只负责「展示」,命令集中在本模块。
// 复用现成能力,不另起一套:
//   - 复制图片 / 复制文本 → utils/clipboard(与资产面板同一份)
//   - 另存为 → Tauri save dialog + copyFile(dev web 降级浏览器下载)
//   - 编辑源码 → imageEditPlugin 的 triggerImageEdit(与悬浮按钮同一个入口)
//   - 删除图片文件 → fs.remove + 文档内同 src 节点一并移除
//
// 所有写操作前都重新解析节点位置:菜单打开期间文档可能因自动保存回写、外部同步或
// 用户继续输入而变化,右键时记下的 pos 不能盲目使用。
// 反馈统一走 notify store;失败只弹 Toast,不打断编辑器。

import type { EditorView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { isTauri } from '@tauri-apps/api/core'
import { save as saveDialog } from '@/tauri/dialog'
import { remove, copyFile } from '@/tauri/fs'
import { writeClipboardText, writeClipboardImage } from '@/utils/clipboard'
import { formatError } from '@/utils/formatError'
import { useNotifyStore } from '@/stores/notify'
import { useConfirmStore } from '@/stores/confirm'
import { basename } from '@/components/Sidebar/treeUtils'
import { dirnameSync, extFromFileName, resolveImageAssetAbsPath } from '@/utils/imagePath'
import { triggerImageEdit } from '../image/imageEditPlugin'
import { serializeHtmlImageSource, serializeImageSource } from '../image/imageSource'
import type { ImageContextTarget } from '../plugins/imageContextMenu'

export type ImageMenuAction =
  | 'copy-image'
  | 'copy-markdown'
  | 'copy-path'
  | 'copy-relative-path'
  | 'cut'
  | 'edit-source'
  | 'save-as'
  | 'delete-node'
  | 'delete-file'

interface LiveImage {
  pos: number
  node: PMNode
}

function isImageNode(node: PMNode): boolean {
  return node.type.name === 'image'
}

/** 优先用右键时的 pos;失效(文档变化)则按 src 内容找回同一个节点。 */
function liveImage(view: EditorView, ctx: ImageContextTarget): LiveImage | null {
  try {
    const direct = view.state.doc.nodeAt(ctx.pos)
    if (direct && isImageNode(direct) && (direct.attrs.src as string) === ctx.src) {
      return { pos: ctx.pos, node: direct }
    }
  } catch {
    /* pos 越界 → 走下面的内容匹配 */
  }

  let hit: LiveImage | null = null
  view.state.doc.descendants((node, pos) => {
    if (hit) return false
    if (!isImageNode(node)) return true
    if ((node.attrs.src as string) === ctx.src) {
      hit = { pos, node }
      return false
    }
    return true
  })
  return hit
}

/** 复制类动作容忍 doc 变化:拿不到当前节点就用右键时的快照。 */
function currentAttrs(
  view: EditorView,
  ctx: ImageContextTarget,
): { src: string; alt: string; title: string; htmlSource: boolean } {
  const live = liveImage(view, ctx)?.node
  return {
    src: live ? (live.attrs.src as string) : ctx.src,
    alt: live ? (live.attrs.alt as string) : ctx.alt,
    title: live ? (live.attrs.title as string) : ctx.title,
    htmlSource: live ? live.attrs.htmlSource === true : ctx.htmlSource,
  }
}

/** 整节点 markdown(粘贴回文档时 markdownPastePlugin 会解析成新 image 节点)。 */
function imageMarkdown(attrs: {
  src: string
  alt: string
  title: string
  htmlSource: boolean
}): string {
  return attrs.htmlSource
    ? serializeHtmlImageSource({
        src: attrs.src,
        alt: attrs.alt,
        title: attrs.title,
        extraAttrs: {},
      })
    : serializeImageSource({ src: attrs.src, alt: attrs.alt, title: attrs.title })
}

async function copyText(text: string, successMessage: string): Promise<void> {
  if (!(await writeClipboardText(text))) throw new Error('无法写入剪贴板')
  useNotifyStore().success(successMessage)
}

/** 磁盘路径相对当前文档目录的部分;不在文档目录内则返回原绝对路径。 */
function relativeToDoc(absPath: string, docPath: string | null): string {
  if (!docPath) return absPath
  const docDir = dirnameSync(docPath).replace(/\\/g, '/')
  const normalized = absPath.replace(/\\/g, '/')
  if (normalized.startsWith(docDir + '/')) return normalized.slice(docDir.length + 1)
  return absPath
}

/**
 * 另存为:Tauri 走系统 save dialog + 二进制安全 copyFile;
 * dev web 端降级为浏览器下载(读 blob → a[download])。
 * 用户取消对话框时静默返回(null path),不弹 Toast。
 */
async function saveImageAs(ctx: ImageContextTarget): Promise<void> {
  const notify = useNotifyStore()
  const fileName = basename(ctx.absPath ?? ctx.src) || 'image.png'
  const ext = extFromFileName(fileName)

  if (isTauri()) {
    if (!ctx.absPath) throw new Error('该图片来源不可另存')
    const target = await saveDialog({
      filters: [{ name: '图片', extensions: [ext === 'bin' ? 'png' : ext] }],
      defaultPath: fileName,
    })
    if (!target) return
    await copyFile(ctx.absPath, target)
    notify.success(`已保存:${target}`)
    return
  }

  // web dev:absPath 不是真实磁盘路径,直接对展示 URL 取 blob。
  const url = ctx.wrapper.querySelector('img')?.getAttribute('src') ?? ctx.src
  const blob = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`下载失败(${r.status})`)
    return r.blob()
  })
  const objectUrl = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = fileName
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    link.remove()
    notify.success(`已下载:${fileName}`)
  } finally {
    // 立刻 revoke 会让部分内核的下载还没开始就拿到失效 URL
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  }
}

/** 删掉文档中所有引用同一 absPath 的 image 节点(倒序 delete 防 pos 偏移)。 */
function deleteNodesByAbsPath(
  view: EditorView,
  absPath: string,
  currentFilePath: string | null,
): void {
  const matches: { pos: number; nodeSize: number }[] = []
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'image') return true
    const nodeAbs = resolveImageAssetAbsPath(node.attrs.src as string, currentFilePath)
    if (nodeAbs.replace(/\\/g, '/') === absPath.replace(/\\/g, '/')) {
      matches.push({ pos, nodeSize: node.nodeSize })
    }
    return true
  })
  if (matches.length === 0) return
  const tr = view.state.tr
  for (let i = matches.length - 1; i >= 0; i--) {
    tr.delete(matches[i].pos, matches[i].pos + matches[i].nodeSize)
  }
  view.dispatch(tr)
}

/** 菜单命令总入口。所有异常收敛成一条 error Toast,不向 Vue 侧抛。 */
export async function runImageMenuAction(
  view: EditorView | null,
  ctx: ImageContextTarget,
  action: ImageMenuAction,
  currentFilePath: string | null,
): Promise<void> {
  const notify = useNotifyStore()
  if (!view || view.isDestroyed) {
    notify.error('编辑器已关闭')
    return
  }

  try {
    switch (action) {
      // ── 剪贴板 ────────────────────────────────────────────
      case 'copy-image': {
        if (!ctx.absPath) throw new Error('外链 / data URI 图片不支持复制为图片')
        await writeClipboardImage(ctx.absPath)
        notify.success('已复制图片')
        return
      }
      case 'copy-markdown': {
        await copyText(imageMarkdown(currentAttrs(view, ctx)), '已复制图片标记')
        return
      }
      case 'copy-path': {
        if (!ctx.absPath) throw new Error('外链 / data URI 图片没有本地路径')
        await copyText(ctx.absPath, '已复制路径')
        return
      }
      case 'copy-relative-path': {
        if (!ctx.absPath) throw new Error('外链 / data URI 图片没有本地路径')
        await copyText(relativeToDoc(ctx.absPath, currentFilePath), '已复制相对路径')
        return
      }
      case 'cut': {
        if (!view.editable) {
          notify.info('只读模式下不可修改')
          return
        }
        const live = liveImage(view, ctx)
        if (!live) throw new Error('图片节点已变化,请重新右键')
        // 先成功写入剪贴板再删节点 —— 复制失败绝不丢内容
        const attrs = {
          src: live.node.attrs.src as string,
          alt: live.node.attrs.alt as string,
          title: live.node.attrs.title as string,
          htmlSource: live.node.attrs.htmlSource === true,
        }
        if (!(await writeClipboardText(imageMarkdown(attrs)))) {
          throw new Error('无法写入剪贴板')
        }
        view.dispatch(view.state.tr.delete(live.pos, live.pos + live.node.nodeSize))
        notify.success('已剪切图片')
        return
      }

      // ── 编辑 ──────────────────────────────────────────────
      case 'edit-source': {
        if (!view.editable) {
          notify.info('只读模式下不可修改')
          return
        }
        const live = liveImage(view, ctx)
        if (!live) throw new Error('图片节点已变化,请重新右键')
        triggerImageEdit(view, live.pos)
        return
      }
      case 'delete-node': {
        if (!view.editable) {
          notify.info('只读模式下不可修改')
          return
        }
        const live = liveImage(view, ctx)
        if (!live) throw new Error('图片节点已变化,请重新右键')
        view.dispatch(view.state.tr.delete(live.pos, live.pos + live.node.nodeSize))
        notify.success('已删除图片')
        return
      }

      // ── 导出 ──────────────────────────────────────────────
      case 'save-as': {
        await saveImageAs(ctx)
        return
      }

      // ── 破坏性文件操作 ────────────────────────────────────
      case 'delete-file': {
        if (!view.editable) {
          notify.info('只读模式下不可修改')
          return
        }
        if (!ctx.absPath) throw new Error('外链 / data URI 图片没有可删除的文件')
        const fileName = basename(ctx.absPath)
        const ok = await useConfirmStore().ask({
          title: '确认删除',
          message: `确定要删除「${fileName}」吗？文档中引用该图片的位置也会一并移除。`,
          detail: ctx.absPath,
          confirmText: '删除',
          cancelText: '取消',
          kind: 'danger',
        })
        if (!ok) return
        await remove(ctx.absPath)
        deleteNodesByAbsPath(view, ctx.absPath, currentFilePath)
        notify.success('已删除图片文件')
        return
      }
    }
  } catch (e) {
    notify.error(`操作失败:${formatError(e)}`)
  }
}
