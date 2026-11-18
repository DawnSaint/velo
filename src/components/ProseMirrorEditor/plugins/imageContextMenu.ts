// 图片节点右键菜单 plugin —— 拦截 .velo-image-inline 内的 contextmenu,
// 阻止原生菜单,把「被右键的图片上下文」交给外部的自绘菜单。
//
// 与 mermaidContextMenu / tableContextMenu 同范式(handleDOMEvents → 回调 → Vue
// ContextMenuShell),差异:
//   - 命中判定按 NodeView 根 class(.velo-image-inline),不是 th/td;
//     编辑按钮(image-edit-btn)/ 失败占位(.image-edit)都算「节点内」。
//   - 位置解析用 view.nodeDOM(pos) === wrapper 反查,不在 DOM 上缓存 pos:
//     autosave 回写 / 外部同步都会让缓存 stale;右键是低频操作,扫一次 doc
//     换可靠性划算(与 mermaidContextMenu 同理由)。
//   - 不需要接管 mousedown:image 是 inline atom,没有 CellSelection 需要保住,
//     右键导致的选区折叠对菜单命令无影响(命令一律以节点 pos 为锚点)。
//
// 未命中(普通段落 / 表格 / mermaid SVG 内)返回 false,交还浏览器原生菜单。

import { Plugin, PluginKey } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'

/** 一次右键解析出的节点上下文。命令侧只读,不要存进响应式 deep ref。 */
export interface ImageContextTarget {
  /** image 节点的 descendants pos = 节点起点,tr.delete(pos, pos + nodeSize) 用。 */
  pos: number
  /** markdown 原始 src(可能是相对路径 / 绝对路径 / http / data:)。 */
  src: string
  alt: string
  title: string
  htmlSource: boolean
  /** 磁盘绝对路径;外链 / data: / 无文档路径(untitled)时为 null。 */
  absPath: string | null
  /** 节点 DOM(展示用途,命令侧不依赖)。 */
  wrapper: HTMLElement
  /** 编辑器是否可写(只读模式隐藏剪切 / 删除节点 / 删除文件 / 编辑源码)。 */
  editable: boolean
  /** 视口坐标(交给 ContextMenuShell 定位)。 */
  x: number
  y: number
}

export interface ImageContextMenuOptions {
  onImageContextMenu: (target: ImageContextTarget) => void
  /** 解析 src → 磁盘绝对路径;拿不到时返回 null。 */
  resolveAbsPath: (src: string) => string | null
}

const imageContextMenuKey = new PluginKey('imageContextMenu')

/** 从 event.target 向上找 image NodeView 根,边界是 view.dom。 */
function findImageWrapper(view: EditorView, target: Node): HTMLElement | null {
  let el: Node | null = target instanceof Element ? target : target.parentElement
  while (el && el !== view.dom) {
    if (el instanceof HTMLElement && el.classList.contains('velo-image-inline')) return el
    el = el.parentNode
  }
  return null
}

/** 用 DOM 反查文档位置:遍历 image 节点,比较 view.nodeDOM(pos)。
 *  img 加载失败兜底会把 <img> replaceWith 成 .image-edit 容器,但根 wrapper
 *  始终由 NodeView 持有(nodeDOM 拿到的就是它),反查不受影响。 */
function resolveImagePos(
  view: EditorView,
  wrapper: HTMLElement,
): { pos: number; node: PMNode } | null {
  let hit: { pos: number; node: PMNode } | null = null
  view.state.doc.descendants((node, pos) => {
    if (hit) return false
    if (node.type.name !== 'image') return true
    if (view.nodeDOM(pos) === wrapper) {
      hit = { pos, node }
      return false
    }
    return true
  })
  return hit
}

/** src 是否指向磁盘文件(外链 / data URI / 已代理的 asset: 都没有可删的文件)。 */
export function isLocalImageSrc(src: string): boolean {
  return !/^(https?:|data:|asset:|tauri:|file:)/i.test(src)
}

export function createImageContextMenuPlugin(opts: ImageContextMenuOptions): Plugin {
  return new Plugin({
    key: imageContextMenuKey,
    props: {
      handleDOMEvents: {
        contextmenu(view, event) {
          const { target } = event
          if (!(target instanceof Node)) return false

          const wrapper = findImageWrapper(view, target)
          if (!wrapper) return false
          const found = resolveImagePos(view, wrapper)
          if (!found) return false

          const { pos, node } = found
          const src = node.attrs.src as string
          // 空 src = 空态占位节点(粘贴/拖入落盘前的临时态),没有可操作对象,
          // 交还原生菜单,避免弹一份全是灰的菜单。
          if (!src) return false

          const absPath = isLocalImageSrc(src) ? opts.resolveAbsPath(src) : null

          event.preventDefault()
          event.stopPropagation()

          opts.onImageContextMenu({
            pos,
            src,
            alt: node.attrs.alt as string,
            title: node.attrs.title as string,
            htmlSource: node.attrs.htmlSource === true,
            absPath,
            wrapper,
            editable: view.editable,
            x: event.clientX,
            y: event.clientY,
          })
          return true
        },
      },
    },
  })
}
