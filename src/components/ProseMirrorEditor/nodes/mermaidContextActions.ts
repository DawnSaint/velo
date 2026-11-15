// Mermaid 预览节点右键菜单的命令实现 —— EditorInner 收到菜单 action 后分发到这里。
//
// 分层:plugin 只负责「拦截 + 解析上下文」,Vue 菜单只负责「展示」,命令集中在本
// 模块。图片能力复用 MermaidDecoration.ts 的 SVG 序列化 / PNG 光栅化(与 toolbar
// 的复制按钮同一份实现),不另起一套 canvas 逻辑。
//
// 所有写操作前都重新解析节点位置:菜单打开的这段时间里文档可能因自动保存回写、
// 外部同步或用户继续输入而变化,右键时记下的 pos 不能盲目使用。
// 反馈统一走 notify store;失败只弹 Toast,不打断编辑器。

import type { EditorView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { isTauri } from '@tauri-apps/api/core'
import { save as saveDialog } from '@/tauri/dialog'
import { writeFile, writeTextFile } from '@/tauri/fs'
import { writeClipboardText } from '@/utils/clipboard'
import { formatError } from '@/utils/formatError'
import { useNotifyStore } from '@/stores/notify'
import {
  copyMermaidAsImage,
  deleteMermaidBlockAt,
  mermaidPngBlob,
  mermaidStandaloneSvg,
  toggleMermaidSourceAt,
} from './MermaidDecoration'
import type { MermaidContextTarget } from '../plugins/mermaidContextMenu'

export type MermaidMenuAction =
  | 'toggle-source'
  | 'copy'
  | 'cut'
  | 'copy-source'
  | 'copy-image'
  | 'copy-svg'
  | 'save-png'
  | 'save-svg'
  | 'save-source'
  | 'delete'

interface LiveBlock {
  blockStart: number
  node: PMNode
}

function isMermaidBlock(node: PMNode): boolean {
  return node.type.name === 'code_block' && (node.attrs.language as string) === 'mermaid'
}

/** 优先用右键时的 pos;失效(文档变化)则按源码内容找回同一个块。 */
function liveBlock(view: EditorView, ctx: MermaidContextTarget): LiveBlock | null {
  try {
    const direct = view.state.doc.nodeAt(ctx.blockStart)
    if (direct && isMermaidBlock(direct)) return { blockStart: ctx.blockStart, node: direct }
  } catch {
    /* pos 越界 → 走下面的内容匹配 */
  }

  let hit: LiveBlock | null = null
  view.state.doc.descendants((node, pos) => {
    if (hit) return false
    if (!isMermaidBlock(node)) return true
    if (node.textContent.trim() === ctx.source.trim()) {
      hit = { blockStart: pos, node }
      return false
    }
    return true
  })
  return hit
}

/** 复制类动作容忍 doc 变化:拿不到当前节点就用右键时的源码快照。 */
function currentSource(view: EditorView, ctx: MermaidContextTarget): string {
  return liveBlock(view, ctx)?.node.textContent ?? ctx.source
}

/** 去尾空白,但不 trim 掉行首缩进(mermaid 缩进有语义)。 */
function plainSource(source: string): string {
  return source.replace(/\s+$/, '')
}

/** 整块 markdown,粘贴回文档时 markdownPastePlugin 会解析成新图表节点。 */
function fencedBlock(source: string): string {
  return `\`\`\`mermaid\n${plainSource(source)}\n\`\`\``
}

/** svgArea 可能随 decoration 重建被换掉,失效时从当前 pre 往后找新 widget。 */
function svgAreaOf(view: EditorView, ctx: MermaidContextTarget): HTMLElement {
  if (ctx.svgArea.isConnected) return ctx.svgArea
  let pre: Node | null = null
  try {
    pre = view.nodeDOM(ctx.blockStart)
  } catch {
    /* ignore */
  }
  if (pre instanceof HTMLElement) {
    let sib: Element | null = pre.nextElementSibling
    while (sib) {
      if (sib.tagName === 'PRE') break // 越过下一个块就不属于本节点了
      if (sib.classList.contains('mermaid-widget')) {
        const area = sib.querySelector('.mermaid-svg-area')
        if (area instanceof HTMLElement) return area
      }
      sib = sib.nextElementSibling
    }
  }
  throw new Error('图表节点已失效,请重新右键')
}

async function copyText(text: string, successMessage: string): Promise<void> {
  if (!(await writeClipboardText(text))) throw new Error('无法写入剪贴板')
  useNotifyStore().success(successMessage)
}

type SavePayload = { kind: 'binary'; blob: Blob } | { kind: 'text'; text: string; mime: string }

function ensureExt(path: string, ext: string): string {
  return path.toLowerCase().endsWith(`.${ext}`) ? path : `${path}.${ext}`
}

/**
 * 另存为:Tauri 走系统 save dialog + fs 写盘;dev web 端降级为浏览器下载。
 * 用户取消对话框时静默返回(null path),不弹 Toast。
 */
async function saveMermaidFile(
  ext: 'png' | 'svg' | 'mmd',
  filterLabel: string,
  defaultName: string,
  payload: SavePayload,
): Promise<void> {
  const notify = useNotifyStore()
  if (isTauri()) {
    const target = await saveDialog({
      filters: [{ name: filterLabel, extensions: [ext] }],
      defaultPath: defaultName,
    })
    if (!target) return
    const path = ensureExt(target, ext)
    if (payload.kind === 'text') {
      await writeTextFile(path, payload.text)
    } else {
      await writeFile(path, new Uint8Array(await payload.blob.arrayBuffer()))
    }
    notify.success(`已保存:${path}`)
    return
  }

  const blob =
    payload.kind === 'binary'
      ? payload.blob
      : new Blob([payload.text], { type: `${payload.mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = defaultName
    link.style.display = 'none'
    document.body.appendChild(link)
    link.click()
    link.remove()
    notify.success(`已下载:${defaultName}`)
  } finally {
    // 立刻 revoke 会让部分内核的下载还没开始就拿到失效 URL
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

/** 菜单命令总入口。所有异常收敛成一条 error Toast,不向 Vue 侧抛。 */
export async function runMermaidMenuAction(
  view: EditorView | null,
  ctx: MermaidContextTarget,
  action: MermaidMenuAction,
): Promise<void> {
  const notify = useNotifyStore()
  if (!view || view.isDestroyed) {
    notify.error('编辑器已关闭')
    return
  }

  try {
    switch (action) {
      // ── 编辑 ──────────────────────────────────────────────
      case 'toggle-source': {
        if (!view.editable) {
          notify.info('只读模式下不可修改')
          return
        }
        const live = liveBlock(view, ctx)
        if (!live) throw new Error('图表节点已变化,请重新右键')
        toggleMermaidSourceAt(view, live.blockStart + 1)
        return
      }
      case 'copy': {
        await copyText(fencedBlock(currentSource(view, ctx)), '已复制图表节点')
        return
      }
      case 'cut': {
        if (!view.editable) {
          notify.info('只读模式下不可修改')
          return
        }
        const live = liveBlock(view, ctx)
        if (!live) throw new Error('图表节点已变化,请重新右键')
        // 先成功写入剪贴板再删节点 —— 复制失败绝不丢内容
        if (!(await writeClipboardText(fencedBlock(live.node.textContent)))) {
          throw new Error('无法写入剪贴板')
        }
        deleteMermaidBlockAt(view, live.blockStart + 1)
        notify.success('已剪切图表节点')
        return
      }
      case 'copy-source': {
        await copyText(plainSource(currentSource(view, ctx)), '已复制 Mermaid 代码')
        return
      }
      case 'delete': {
        if (!view.editable) {
          notify.info('只读模式下不可修改')
          return
        }
        const live = liveBlock(view, ctx)
        if (!live) throw new Error('图表节点已变化,请重新右键')
        deleteMermaidBlockAt(view, live.blockStart + 1)
        notify.success('已删除图表节点')
        return
      }

      // ── 图片 / 导出 ────────────────────────────────────────
      case 'copy-image': {
        await copyMermaidAsImage(svgAreaOf(view, ctx))
        notify.success('已复制为图片')
        return
      }
      case 'copy-svg': {
        await copyText(mermaidStandaloneSvg(svgAreaOf(view, ctx)), '已复制 SVG 代码')
        return
      }
      case 'save-png': {
        const blob = await mermaidPngBlob(svgAreaOf(view, ctx))
        await saveMermaidFile('png', 'PNG 图片', 'mermaid-diagram.png', { kind: 'binary', blob })
        return
      }
      case 'save-svg': {
        const svg = mermaidStandaloneSvg(svgAreaOf(view, ctx))
        await saveMermaidFile('svg', 'SVG 矢量图', 'mermaid-diagram.svg', {
          kind: 'text',
          text: svg,
          mime: 'image/svg+xml',
        })
        return
      }
      case 'save-source': {
        await saveMermaidFile('mmd', 'Mermaid 源码', 'mermaid-diagram.mmd', {
          kind: 'text',
          text: plainSource(currentSource(view, ctx)),
          mime: 'text/plain',
        })
        return
      }
    }
  } catch (e) {
    notify.error(`操作失败:${formatError(e)}`)
  }
}
