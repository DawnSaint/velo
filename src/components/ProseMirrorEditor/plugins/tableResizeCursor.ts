// 表格列宽调整光标插件 — 在 table 级加 class,让整表统一显示 col-resize 光标。
//
// 问题: columnResizing 给 cell 之间渲染 .column-resize-handle 手柄(width=5px),
// 这些手柄 pointer-events:none,鼠标穿过它们落到 cell 上。
// 若只在单个 cell 上加 cursor class(cell = .velo-cell-resize-hover),
// 鼠标跨 cell 移动时 cursor 会闪烁/消失(新的 cell 上需要重新命中)。
// 改为给外层 table 加 .velo-table-resize-active class,table 整体 cursor = col-resize,
// 鼠标在表格内任何位置,只要与最近 cell 右边缘 ≤8px 即统一显示。
//
// mousemove 事件在 view.dom 上监听,每次都用 posAtDOM 找 cell 并检测右边缘距离。
// 鼠标不在任何 cell 上 / 距离过远 → 清除 class。

import { Plugin } from "prosemirror-state"
import { PluginKey } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"

const tableResizeCursorKey = new PluginKey<ResizeCursorState>(
  "tableResizeCursor"
)

interface ResizeCursorState {
  /** 当前触发 cursor 的 table 的 doc pos; 无 = -1 */
  tablePos: number
}

/** 在 view.dom 子树里找 event.target 所在的 <table> 元素 */
function findEnclosingTable(view: EditorView, target: Node): HTMLTableElement | null {
  let cur: Node | null =
    target instanceof HTMLElement ? target : target.parentElement
  while (cur && cur !== view.dom) {
    if (cur instanceof HTMLTableElement) return cur
    cur = cur.parentElement
  }
  return null
}

/** 在 view.dom 子树里找 event.target 所在的 th/td 元素 */
function findEnclosingCell(view: EditorView, target: Node): HTMLTableCellElement | null {
  let cur: Node | null =
    target instanceof HTMLElement ? target : target.parentElement
  while (cur && cur !== view.dom) {
    if (cur instanceof HTMLTableCellElement) return cur
    cur = cur.parentElement
  }
  return null
}

export function createTableResizeCursorPlugin(): Plugin {
  let activeTable: HTMLTableElement | null = null
  let view: EditorView | null = null

  function setActiveTable(table: HTMLTableElement | null) {
    if (activeTable === table) return
    if (activeTable) activeTable.classList.remove("velo-table-resize-active")
    if (table) table.classList.add("velo-table-resize-active")
    activeTable = table
  }

  return new Plugin({
    key: tableResizeCursorKey,
    view(v) {
      view = v
      return {
        destroy() {
          setActiveTable(null)
          view = null
        },
      }
    },
    props: {
      handleDOMEvents: {
        mousemove(_v, event) {
          const t = view
          if (!t) return false
          // 先找 cell;再找其 enclosing table
          const cell = findEnclosingCell(t, event.target as Node)
          if (!cell) {
            setActiveTable(null)
            return false
          }
          const rect = cell.getBoundingClientRect()
          const offsetFromRight = rect.right - event.clientX
          if (offsetFromRight >= 0 && offsetFromRight <= 8) {
            const table = findEnclosingTable(t, event.target as Node)
            setActiveTable(table)
          } else {
            setActiveTable(null)
          }
          return false
        },
        mouseleave() {
          setActiveTable(null)
          return false
        },
      },
    },
  })
}
