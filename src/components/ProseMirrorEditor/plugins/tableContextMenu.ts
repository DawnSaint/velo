// 表格上下文菜单 plugin —— 拦截编辑器内的 contextmenu 事件,
// 仅当点击目标在 table cell 内时阻止原生菜单并通知外部(showMenu)。
//
// 通过 props.handleDOMEvents 实现:
//   - mousedown(button=2,右键):
//     * 当前是 CellSelection 且右键落在矩形内 → preventDefault + stopPropagation,
//       返回 true(已处理)。阻止底层 view 把 CellSelection 折叠成 TextSelection(Q3),
//       让命令能以右键点中的 cell 为锚点。
//     * 否则 → 返回 false,走默认折叠(右键矩形外 = 标准行为)。
//   - contextmenu: 命中 table cell → preventDefault + stopPropagation,返回 true(已处理)
//     + 调 opts.onTableContextMenu(clickCellPos, x, y)
//     + clickCellPos = 右键点中 cell 的 descendants pos(open token 前的 gap position);
//       命令以它为锚点(矩形内任意格右键语义一致)
//   - 未命中 → 返回 false,走浏览器默认右键菜单

import { Plugin } from "prosemirror-state"
import { PluginKey } from "prosemirror-state"
import { CellSelection } from "prosemirror-tables"

export interface TableContextMenuOptions {
  /**
   * 在 table cell 内右键时回调。
   * @param clickCellPos 点中 cell 的 descendants pos(open token 前的 gap position),
   *   与 doc.descendants / nodeAt 返回的 pos 同语义。
   * @param inHeader 右键点中的 cell 是否为 header(th)——用于菜单隐藏"删除行"。
   * @param isCellSelection 触发时是否存在 CellSelection(多格拖蓝)。
   * @param x 视口坐标
   * @param y 视口坐标
   */
  onTableContextMenu: (clickCellPos: number, inHeader: boolean, isCellSelection: boolean, x: number, y: number) => void
}

export const tableContextMenuKey = new PluginKey("tableContextMenu")

// 判断点击 target 是否落在当前 CellSelection 的矩形内。
// 用 CellSelection.ranges 遍历每个 range,检查 clickCellPos 是否含入。
function clickInsideCellSelection(
  sel: import("prosemirror-state").Selection,
  clickCellPos: number,
): boolean {
  if (!(sel instanceof CellSelection)) return false
  // 从 clickCellPos 拿到 cell 节点矩形,与每个 range from/to 比对。
  // 简化:clickCellPos 只要在任意一个 range 内即可。
  const ranges = sel.ranges
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]
    if (clickCellPos >= r.$from.pos && clickCellPos <= r.$to.pos) return true
  }
  return false
}

// 给定一个 cell DOM,返回它对应的 descendants pos(open token 前的 gap position)。
function cellPosFromDom(view: import("prosemirror-view").EditorView, cellDom: HTMLElement): number {
  return view.posAtDOM(cellDom, 0)
}

// 从 event target 向上找最近的 th/td,找不到返回 null。
function findCellDom(view: import("prosemirror-view").EditorView, target: Node): HTMLElement | null {
  const dom: Node | null = target instanceof HTMLElement ? target : target.parentElement
  if (!dom) return null
  let cur: Node | null = dom
  while (cur && cur !== view.dom) {
    if (cur instanceof HTMLElement && (cur.tagName === "TH" || cur.tagName === "TD")) return cur
    cur = cur.parentNode
  }
  return null
}

export function createTableContextMenuPlugin(
  opts: TableContextMenuOptions,
): Plugin {
  return new Plugin({
    key: tableContextMenuKey,
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          if (event.button !== 2) return false // 只处理右键
          const cellDom = findCellDom(view, event.target as Node)
          if (!cellDom) return false
          const clickCellPos = cellPosFromDom(view, cellDom)
          // 当前是 CellSelection 且右键落在矩形内 → 拦截,保留选区。
          if (clickInsideCellSelection(view.state.selection, clickCellPos)) {
            event.preventDefault()
            event.stopPropagation()
            return true
          }
          return false
        },
        contextmenu(view, event) {
          const { target } = event
          if (!(target instanceof Node)) return false

          const cellDom = findCellDom(view, target)
          if (!cellDom) return false

          // 获取该 cell 的 descendants pos(与 doc.descendants 同语义)。
          const clickCellPos = cellPosFromDom(view, cellDom)
          const inHeader = cellDom.tagName === "TH"
          const isCellSelection = view.state.selection instanceof CellSelection

          // 阻止原生右键菜单
          event.preventDefault()
          event.stopPropagation()

          opts.onTableContextMenu(clickCellPos, inHeader, isCellSelection, event.clientX, event.clientY)
          return true
        },
      },
    },
  })
}