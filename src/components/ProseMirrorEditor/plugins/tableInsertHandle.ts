// 表格行列插入浮层 —— 飞书风格:鼠标在表格内时,每条行/列分割线外侧
// 显示灰色小圆点;hover 圆点时圆点变蓝 + 显示 "+" 图标 + 高亮引导线;
// 点击在分割线位置插入行/列。
//
// 实现:
// - mousemove 监听 view.dom,鼠标进入 table cell 时渲染所有分割线的圆点
// - 行圆点:在 table 左侧,每行底部一条(header 上方不画)
// - 列圆点:在 table 上方,首列左侧 + 每列右侧各一条
// - 圆点挂 document.body + position:fixed(WebView2 会裁 overflow 容器内的
//   absolute 子元素)
// - 圆点 hover → CSS :hover 变蓝放大 + 显示 "+" 图标;JS mouseenter 显示引导线
// - 圆点 click → opts.onInsert(cellPos, 'row'|'column', 'before'|'after')
// - 鼠标离开 table → 200ms 延迟后隐藏(留时间移到圆点上);scroll/doc 变化立即隐藏

import { Plugin, PluginKey, TextSelection } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import type { EditorState } from "prosemirror-state"

export interface TableInsertHandleOptions {
  onInsert: (cellPos: number, type: "row" | "column", dir: "before" | "after") => void
}

export const tableInsertHandleKey = new PluginKey("tableInsertHandle")

const HIDE_DELAY = 200 // ms — 鼠标离开 table 后延迟隐藏,留时间移到圆点上
const DOT_OFFSET = 14 // px — 圆点中心到 table 边缘的距离

// 从 table 向上找真正的横向/纵向滚动容器(overflow:auto|scroll 的祖先)。
// dot 是 position:fixed,不受 overflow 裁剪,必须自己判定是否在容器可见区内。
function findScrollContainer(table: HTMLElement): HTMLElement | null {
  let cur: Node | null = table
  while (cur && cur.nodeType === Node.ELEMENT_NODE) {
    const el = cur as HTMLElement
    if (el === document.body || el === document.documentElement) break
    const cs = getComputedStyle(el)
    if (cs.overflowX === "auto" || cs.overflowX === "scroll" || cs.overflow === "auto" || cs.overflow === "scroll") {
      return el
    }
    cur = cur.parentNode
  }
  return null
}

const PLUS_SVG =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none">' +
  '<path d="M6 1.5v9M1.5 6h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

interface DotData {
  type: "row" | "column"
  dir: "before" | "after"
  cellPos: number
  // 锚点 DOM,滚动时用于重算 dot 位置(dot 保持 position:fixed,靠此同步表格移动)。
  anchor: HTMLTableRowElement | HTMLTableCellElement
}

// 从 event target 向上找最近的 th/td
function findCellDom(view: EditorView, target: Node): HTMLTableCellElement | null {
  let cur: Node | null = target instanceof HTMLElement ? target : target.parentElement
  while (cur && cur !== view.dom) {
    if (cur instanceof HTMLTableCellElement) return cur
    cur = cur.parentNode
  }
  return null
}

// 从 cell 向上找 enclosing <table>
function findTableDom(cell: HTMLElement): HTMLTableElement | null {
  let cur: Node | null = cell
  while (cur) {
    if (cur instanceof HTMLTableElement) return cur
    cur = cur.parentNode
  }
  return null
}

export function createTableInsertHandlePlugin(opts: TableInsertHandleOptions): Plugin {
  let view: EditorView | null = null
  let dotsContainer: HTMLDivElement | null = null
  let guideEl: HTMLDivElement | null = null
  let activeTable: HTMLTableElement | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let scrollHandler: (() => void) | null = null
  // 表格横向滚动的容器(.tableWrapper,overflow-x:auto)。dot 是 position:fixed,
  // 滚动表格时 dot 自身不动,需要按锚点 DOM 当前 rect 重算位置,让 dot 跟表格内容走。
  let wrapperScrollEl: HTMLElement | null = null
  let wrapperScrollHandler: (() => void) | null = null
  // 用 WeakMap 锚定每个 dot 对应的 DOM(row/cell),滚动时重算其坐标。
  const dotAnchor = new WeakMap<HTMLDivElement, HTMLTableRowElement | HTMLTableCellElement>()

  // 纯逻辑判定:选区 $head 是否在任意 table 内。不依赖 DOM,只遍历 PM 数据结构的
  // 祖先链。CellSelection / TextSelection 在表格内时祖先链一定含 table 节点,
  // 任一情况都 100% 命中 -- 这是 dot 隐藏的"主裁判",光标在表内一律不隐藏 dot。
  function selectionInTableNode(v: EditorView): boolean {
    const $head = v.state.selection.$head
    for (let d = $head.depth; d >= 0; d--) {
      if ($head.node(d).type.name === "table") return true
    }
    return false
  }

  // 返回选区所在 enclosing <table> DOM,仅供"进入新表需要渲染 dots"的入口使用。
  // 仍可命中返回 DOM;位置键偏移靠 start / start-1 双尝试兜回 -- 命中不到返回 null,
  // 由渲染入口处理(null 时不重渲染 dots,由 mousemove 后续补)。
  function selectionInTableDom(v: EditorView): HTMLTableElement | null {
    const $head = v.state.selection.$head
    for (let d = $head.depth; d >= 0; d--) {
      if ($head.node(d).type.name === "table") {
        const tableStart = $head.start(d)
        const domAtStart = v.nodeDOM(tableStart)
        if (domAtStart instanceof HTMLTableElement) return domAtStart
        const domBeforeStart = v.nodeDOM(tableStart - 1)
        if (domBeforeStart instanceof HTMLTableElement) return domBeforeStart
        return null
      }
    }
    return null
  }

  // 条件隐藏:仅当光标已不在任何 table 内时才执行 activeTable=null + scheduleHide。
  // 光标留在表格内时一律不隐藏(即使鼠标已离开 cell / dot),保证 dot 持续显示。
  function hideIfSelectionLeftTable() {
    if (!view) return
    // 纯逻辑 node-type 判定:只要光标(选区)仍在任意 table 内就不隐藏 dot,
    // 不受鼠标位置影响。CellSelection / TextSelection 任一情况都可靠命中。
    if (selectionInTableNode(view)) return
    activeTable = null
    scheduleHide()
  }

  function ensureElements() {
    if (!dotsContainer) {
      dotsContainer = document.createElement("div")
      dotsContainer.className = "velo-t-insert-dots"
      document.body.appendChild(dotsContainer)
    }
    if (!guideEl) {
      guideEl = document.createElement("div")
      guideEl.className = "velo-t-insert-guide"
      document.body.appendChild(guideEl)
    }
  }

  function hideAll() {
    if (dotsContainer) dotsContainer.innerHTML = ""
    if (guideEl) guideEl.style.display = "none"
    activeTable = null
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      hideTimer = null
      hideAll()
    }, HIDE_DELAY)
  }

  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  function showGuide(
    type: "row" | "column",
    tableRect: DOMRect,
    pos: number, // 边界坐标(x for column, y for row)
  ) {
    if (!guideEl) return
    if (type === "column") {
      // 竖线:从 table 顶到底
      const top = Math.max(tableRect.top, 0)
      const bottom = Math.min(tableRect.bottom, window.innerHeight)
      guideEl.style.display = "block"
      guideEl.style.left = `${Math.round(pos - 0.5)}px`
      guideEl.style.top = `${Math.round(top)}px`
      guideEl.style.width = "1px"
      guideEl.style.height = `${Math.round(bottom - top)}px`
    } else {
      // 横线:从 table 左到右
      const left = Math.max(tableRect.left, 0)
      const right = Math.min(tableRect.right, window.innerWidth)
      guideEl.style.display = "block"
      guideEl.style.left = `${Math.round(left)}px`
      guideEl.style.top = `${Math.round(pos - 0.5)}px`
      guideEl.style.width = `${Math.round(right - left)}px`
      guideEl.style.height = "1px"
    }
  }

  function hideGuide() {
    if (guideEl) guideEl.style.display = "none"
  }

  function createDot(
    data: DotData,
    x: number, // 圆点中心 x
    y: number, // 圆点中心 y
    tableRect: DOMRect,
    v: EditorView,
  ): HTMLDivElement {
    const dot = document.createElement("div")
    dot.className = "velo-t-insert-dot"
    dot.innerHTML = PLUS_SVG
    // 20px 元素居中于 (x, y)
    dot.style.left = `${Math.round(x - 10)}px`
    dot.style.top = `${Math.round(y - 10)}px`

    dot.addEventListener("mouseenter", () => {
      cancelHide()
      if (data.type === "column") {
        showGuide("column", tableRect, x)
      } else {
        showGuide("row", tableRect, y)
      }
    })

    dot.addEventListener("mouseleave", () => {
      hideGuide()
      // 是否真正 hide 交给 selection 位置决定;光标仍在表格内时不隐藏
      hideIfSelectionLeftTable()
    })

    dot.addEventListener("mousedown", (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (!v.hasFocus()) v.focus()
      // 插入前先把光标设到 dot 所在列的首格:+1=cell 内容区起点(paragraph 首)。
      // 作用仅是给 undo 一个"表格内的合理锚点",避免初始态光标在文档顶部时撤销跳到顶部。
      // 插入后光标由 cmdAddColumnAfter / cmdAddRowAfter 内部决定(落在新增列/行的首个 cell),
      // 不再手动覆盖,避免与命令自身的 cursor 定位冲突。
      // addToHistory:false → 此 selection 变更不单独生成撤销步。
      const atCell = data.cellPos + 1
      v.dispatch(
        v.state.tr.setSelection(TextSelection.create(v.state.doc, atCell))
          .setMeta("addToHistory", false),
      )
      opts.onInsert(data.cellPos, data.type, data.dir)
      hideAll()
    })

    // 注册锚点 DOM,供滚动时重算该 dot 的坐标(跟表格内容一起走)。
    dotAnchor.set(dot, data.anchor)
    // 把方向记到 dataset,repositionDots 据此决定贴在锚点的哪一侧。
    dot.dataset.dir = data.dir

    return dot
  }

  // dot 是 position:fixed,不受 overflow 裁剪 —— 必须自己判定是否在滚动容器的可见区内。
  // 对每个 dot:按其锚点 rect 算出屏幕中心 (x,y);若该中心落在滚动容器可见矩形之外,
  // 则 display:none(跟表格内容一起被"隐藏");否则显示。
  function repositionDots() {
    if (!dotsContainer || !activeTable) return
    const container = findScrollContainer(activeTable)
    const containerRect = container
      ? container.getBoundingClientRect()
      : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight }
    const tableRect = activeTable.getBoundingClientRect()
    const dots = dotsContainer.children
    for (let i = 0; i < dots.length; i++) {
      const dot = dots[i] as HTMLDivElement
      const anchor = dotAnchor.get(dot)
      if (!anchor) continue
      const dir = dot.dataset.dir
      // 渲染坐标(含 DOT_OFFSET 外偏 —— dot 本身在表格边缘外侧)。
      let x: number, y: number
      // 参考点:dot 锚固在表格上的边缘位置(不含外偏)。用它判定"表格是否还露在容器内"。
      let refX: number, refY: number
      if (anchor instanceof HTMLTableRowElement) {
        const rowRect = (anchor as HTMLTableRowElement).getBoundingClientRect()
        refX = tableRect.left
        refY = dir === "before" ? tableRect.top : rowRect.bottom
        x = refX - DOT_OFFSET
        y = refY
      } else {
        const cellRect = (anchor as HTMLTableCellElement).getBoundingClientRect()
        refX = dir === "before" ? cellRect.left : cellRect.right
        refY = dot.dataset.kind === "rowheader" ? tableRect.top : tableRect.top
        x = refX
        y = refY - DOT_OFFSET
      }
      dot.style.left = `${Math.round(x - 10)}px`
      dot.style.top = `${Math.round(y - 10)}px`
      // 可见性由参考点(表格边缘锚点)判定:锚点在容器可见矩形内 → 显示,否则隐藏。
      // 留 2px 容差防浮点抖动。
      const visible = refX >= containerRect.left - 2 && refX <= containerRect.right + 2 &&
        refY >= containerRect.top - 2 && refY <= containerRect.bottom + 2
      dot.style.display = visible ? "flex" : "none"
    }
  }

  function renderDots(table: HTMLTableElement, v: EditorView) {
    ensureElements()
    dotsContainer!.innerHTML = ""
    const tableRect = table.getBoundingClientRect()

    // 行圆点:首行(含 header)上方一个 before + 每行底部一个 after
    const rows = table.querySelectorAll("tr")
    rows.forEach((row, rowIdx) => {
      const rowRect = (row as HTMLTableRowElement).getBoundingClientRect()
      const firstCell = row.querySelector("th, td")
      if (!firstCell) return
      const cellPos = v.posAtDOM(firstCell, 0)

      // 首行上方:before(表格第一行顶部灰色点,用于在 header/首行上方插入行)。
      // 位置贴在表格顶边(tableRect.top),引导线即画在顶边、与 header 紧贴;
      // 与行间 dot 贴在行底边(rowRect.bottom)同律,不悬空。
      if (rowIdx === 0) {
        const dot = createDot(
          { type: "row", dir: "before", cellPos, anchor: row },
          tableRect.left - DOT_OFFSET,
          tableRect.top,
          tableRect,
          v,
        )
        dot.dataset.kind = "rowheader"
        dotsContainer!.appendChild(dot)
      }
      // 每行底部:after
      const dot = createDot(
        { type: "row", dir: "after", cellPos, anchor: row },
        tableRect.left - DOT_OFFSET,
        rowRect.bottom,
        tableRect,
        v,
      )
      dotsContainer!.appendChild(dot)
    })

    // 列圆点:首列左侧 + 每列右侧
    const firstRow = table.querySelector("tr")
    if (firstRow) {
      const cells = firstRow.querySelectorAll("th, td")
      cells.forEach((cell, i) => {
        const cellRect = (cell as HTMLTableCellElement).getBoundingClientRect()
        const cellPos = v.posAtDOM(cell, 0)

        // 首列左侧:before
        if (i === 0) {
          const dot = createDot(
            { type: "column", dir: "before", cellPos, anchor: cell as HTMLTableCellElement },
            cellRect.left,
            tableRect.top - DOT_OFFSET,
            tableRect,
            v,
          )
          dotsContainer!.appendChild(dot)
        }
        // 每列右侧:after
        const dot = createDot(
          { type: "column", dir: "after", cellPos, anchor: cell as HTMLTableCellElement },
          cellRect.right,
          tableRect.top - DOT_OFFSET,
          tableRect,
          v,
        )
        dotsContainer!.appendChild(dot)
      })
    }
    // 初始渲染后立即按容器可见性同步一次 display(进入新 table 时初始滚动偏移非 0)。
    repositionDots()
  }

  function onMouseMove(event: MouseEvent) {
    const v = view
    if (!v) return
    if (!v.editable) {
      hideAll()
      return
    }

    const cellDom = findCellDom(v, event.target as Node)
    if (!cellDom) {
      // 鼠标不在 cell 上。dot 挂在 document.body(view.dom 外),findCellDom 走出来,
      // 但 dot 的 mouseenter 已 cancelHide,这里不重复 scheduleHide。
      // 真正是否隐藏统一由 selection 位置(hideIfSelectionLeftTable)决定,
      // 不在 mousemove 里强制 activeTable=null,避免光标还在表格内时被抢掉显示。
      hideIfSelectionLeftTable()
      return
    }

    const tableDom = findTableDom(cellDom)
    if (!tableDom) return

    cancelHide()

    // 只在进入新 table 时渲染(避免每次 mousemove 重建)
    if (tableDom !== activeTable) {
      activeTable = tableDom
      renderDots(tableDom, v)
      bindScrollListeners(tableDom)
    }
  }

  // 给表格的真实滚动容器(首个 overflow:auto|scroll 祖先)挂滚动监听 + 窗口滚动兜底。
  // dot 是 position:fixed,不受 overflow 裁剪;滚动事件里调用 repositionDots
  // 按"dot 屏幕中心是否在容器可见矩形内"决定 display,滚出即隐藏。
  function bindScrollListeners(table: HTMLTableElement) {
    if (wrapperScrollHandler && wrapperScrollEl) {
      wrapperScrollEl.removeEventListener("scroll", wrapperScrollHandler)
      window.removeEventListener("scroll", wrapperScrollHandler)
      wrapperScrollEl = null
      wrapperScrollHandler = null
    }
    const wrapper = findScrollContainer(table)
    if (wrapper instanceof HTMLElement) {
      wrapperScrollEl = wrapper
      wrapperScrollHandler = () => repositionDots()
      wrapper.addEventListener("scroll", wrapperScrollHandler, { passive: true })
    } else {
      // 没找到内层容器,退回窗口(整页滚动)兜底。
      wrapperScrollEl = null
      wrapperScrollHandler = () => repositionDots()
    }
    window.addEventListener("scroll", wrapperScrollHandler, { passive: true })
  }

  function destroy() {
    if (scrollHandler) {
      window.removeEventListener("scroll", scrollHandler, true)
      scrollHandler = null
    }
    if (wrapperScrollHandler && wrapperScrollEl) {
      wrapperScrollEl.removeEventListener("scroll", wrapperScrollHandler)
      wrapperScrollEl = null
      wrapperScrollHandler = null
    }
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    if (dotsContainer) { dotsContainer.remove(); dotsContainer = null }
    if (guideEl) { guideEl.remove(); guideEl = null }
    activeTable = null
  }

  return new Plugin({
    key: tableInsertHandleKey,
    view(editorView: EditorView) {
      view = editorView
      scrollHandler = () => hideAll()
      window.addEventListener("scroll", scrollHandler, true)
      return {
        update(v: EditorView, prevState: EditorState) {
          // doc 变化时隐藏(插入后表结构已变,圆点位置过期)
          if (prevState.doc !== v.state.doc) {
            hideAll()
            return
          }
          // 选区变化:dot 显隐完全由"光标是否在 table 内"决定。
          //   - 进入 table cell → 显示 dot(无需等鼠标移动)
          //   - 离开 table → 隐藏
          if (prevState.selection !== v.state.selection) {
            if (!v.editable) return
            // 进入新表时渲染 dots 需要 enclosing <table> DOM,走 nodeDOM 查找
            // (shift-click 选区等多种入口都走此路径,需 DOM 定位到具体哪张表)。
            const tableDom = selectionInTableDom(v)
            if (tableDom) {
              cancelHide()
              if (tableDom !== activeTable) {
                activeTable = tableDom
                renderDots(tableDom, v)
              }
            } else {
              // DOM 查找失败但 selection 实际仍在表内(node-type 判定)时,不强制隐藏 --
              // 等下一次 mousemove 命中 cell 即可重渲染 dots。
              cancelHide()
              hideIfSelectionLeftTable()
            }
          }
        },
        destroy() {
          destroy()
          view = null
        },
      }
    },
    props: {
      handleDOMEvents: {
        mousemove(_v, event) {
          onMouseMove(event as MouseEvent)
          return false
        },
        mouseleave() {
          // 鼠标离开 view.dom;是否真正 hide 由 selection 位置决定
          hideIfSelectionLeftTable()
          return false
        },
      },
    },
  })
}
