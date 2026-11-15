// Mermaid 预览节点右键菜单 plugin —— 拦截 .mermaid-widget 内的 contextmenu,
// 阻止原生菜单,把「被右键的图表节点上下文」交给外部的自绘菜单。
//
// 与 tableContextMenu 同范式(handleDOMEvents → 回调 → Vue ContextMenuShell),
// 三处差异:
//   - 命中判定按 widget class(.mermaid-widget),不是 th/td;toolbar 按钮 / SVG
//     / loader / error 占位都算「节点内」,统一弹同一份菜单。
//   - 位置解析走 `view.nodeDOM(pos) === pre` 反查 doc,**不在 widget 上缓存 pos**:
//     DecorationSet.map 平移时会复用 widget DOM(pos 已变),任何写死在 DOM 上的
//     位置都会 stale;右键是低频操作,扫一次 doc 换可靠性划算。
//   - 不接管 mousedown:mermaid 没有 CellSelection 需要保住,右键导致的选区折叠
//     对菜单命令无影响(命令一律以节点 pos 而非 state.selection 为锚点)。
//
// 未命中(普通段落 / 表格 / 源码 pre 内)返回 false,把原生右键菜单交还浏览器。

import { Plugin, PluginKey } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'

/** 一次右键解析出的节点上下文。命令侧只读,不要存进响应式 deep ref。 */
export interface MermaidContextTarget {
  /** code_block 的 descendants pos = open token 之前,tr.delete 起点。 */
  blockStart: number
  /** content 起点 = blockStart + 1,toggleEditAt / focus 用这套坐标。 */
  sourcePos: number
  /** 图表源码(不含 ```mermaid 围栏)。 */
  source: string
  /** 当前是否展开源码态(决定菜单显示「收起」还是「展开」)。 */
  isEditing: boolean
  /** 编辑器是否可写(只读模式隐藏删除 / 剪切 / 展开源代码)。 */
  editable: boolean
  /** SVG 容器 DOM(复制为图片 / 另存为图片时取里面的 <svg>)。 */
  svgArea: HTMLElement
  /** 视口坐标(交给 ContextMenuShell 定位)。 */
  x: number
  y: number
}

export interface MermaidContextMenuOptions {
  onMermaidContextMenu: (target: MermaidContextTarget) => void
}

const mermaidContextMenuKey = new PluginKey('mermaidContextMenu')

/** 从 event.target 向上找 mermaid widget 根,边界是 view.dom。 */
function findMermaidWidget(view: EditorView, target: Node): HTMLElement | null {
  let el: Node | null = target instanceof Element ? target : target.parentElement
  while (el && el !== view.dom) {
    if (el instanceof HTMLElement && el.classList.contains('mermaid-widget')) return el
    el = el.parentNode
  }
  return null
}

/** widget 挂在 code_block 末尾 → DOM 上它的前一个 <pre> 就是这段源码的 pre。
 *  夹在中间的 code header / fold 等 widget 不是 <pre>,继续往前找即可。 */
function findSourcePre(widget: HTMLElement): HTMLElement | null {
  let sib: Element | null = widget.previousElementSibling
  while (sib) {
    if (sib.tagName === 'PRE') return sib as HTMLElement
    sib = sib.previousElementSibling
  }
  return null
}

/** 用 DOM 反查文档位置:遍历 mermaid code_block,比较 view.nodeDOM(pos)。 */
function resolveMermaidBlock(
  view: EditorView,
  pre: HTMLElement,
): { pos: number; node: PMNode } | null {
  let hit: { pos: number; node: PMNode } | null = null
  view.state.doc.descendants((node, pos) => {
    if (hit) return false
    if (node.type.name !== 'code_block') return true
    if ((node.attrs.language as string) !== 'mermaid') return true
    if (view.nodeDOM(pos) === pre) {
      hit = { pos, node }
      return false
    }
    return true
  })
  return hit
}

export function createMermaidContextMenuPlugin(opts: MermaidContextMenuOptions): Plugin {
  return new Plugin({
    key: mermaidContextMenuKey,
    props: {
      handleDOMEvents: {
        contextmenu(view, event) {
          const { target } = event
          if (!(target instanceof Node)) return false

          const widget = findMermaidWidget(view, target)
          if (!widget) return false
          const pre = findSourcePre(widget)
          if (!pre) return false
          const block = resolveMermaidBlock(view, pre)
          if (!block) return false
          const svgArea = widget.querySelector('.mermaid-svg-area')
          if (!(svgArea instanceof HTMLElement)) return false

          event.preventDefault()
          event.stopPropagation()

          opts.onMermaidContextMenu({
            blockStart: block.pos,
            sourcePos: block.pos + 1,
            source: block.node.textContent,
            isEditing: widget.classList.contains('is-editing'),
            editable: view.editable,
            svgArea,
            x: event.clientX,
            y: event.clientY,
          })
          return true
        },
      },
    },
  })
}
