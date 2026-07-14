// 表格上下文菜单 plugin —— 拦截编辑器内的 contextmenu 事件,
// 仅当点击目标在 table cell 内时阻止原生菜单并通知外部(showMenu)。
//
// 通过 props.handleDOMEvents.contextmenu 实现:
//   - 命中 table cell → preventDefault + stopPropagation,返回 true(已处理)
//     + 调 opts.onTableContextMenu(pos, x, y)
//   - 未命中 → 返回 false,走浏览器默认右键菜单

import { Plugin } from "prosemirror-state"
import { PluginKey } from "prosemirror-state"

export interface TableContextMenuOptions {
  /** 在 table cell 内右键时回调,携带单元格位置和视口坐标 */
  onTableContextMenu: (cellPos: number, x: number, y: number) => void
}

export const tableContextMenuKey = new PluginKey("tableContextMenu")

export function createTableContextMenuPlugin(
  opts: TableContextMenuOptions,
): Plugin {
  return new Plugin({
    key: tableContextMenuKey,
    props: {
      handleDOMEvents: {
        contextmenu(view, event) {
          const { target } = event
          if (!(target instanceof Node)) return false

          // 检测 event target 是否在 table cell (th/td) 内
          const dom: Node | null = target instanceof HTMLElement ? target : target.parentElement
          if (!dom) return false

          // 向上查找最近的 th/td
          let cur: Node | null = dom
          let cellDom: HTMLElement | null = null
          while (cur && cur !== view.dom) {
            if (
              cur instanceof HTMLElement &&
              (cur.tagName === "TH" || cur.tagName === "TD")
            ) {
              cellDom = cur
              break
            }
            cur = cur.parentNode
          }
          if (!cellDom) return false

          // 获取该 DOM 在 doc 中的位置
          const cellPos = view.posAtDOM(cellDom, 0)

          // 阻止原生右键菜单
          event.preventDefault()
          event.stopPropagation()

          // 通知外部显示自定义菜单
          opts.onTableContextMenu(cellPos, event.clientX, event.clientY)
          return true
        },
      },
    },
  })
}