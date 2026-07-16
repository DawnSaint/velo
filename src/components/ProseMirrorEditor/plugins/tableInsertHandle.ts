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
import type { Node as PMNode } from "prosemirror-model"
import type { EditorView } from "prosemirror-view"
import type { EditorState } from "prosemirror-state"
import { CellSelection, TableMap } from "prosemirror-tables"

export interface TableInsertHandleOptions {
  onInsert: (cellPos: number, type: "row" | "column", dir: "before" | "after") => void
}

export const tableInsertHandleKey = new PluginKey("tableInsertHandle")

const HIDE_DELAY = 200 // ms — 鼠标离开 table 后延迟隐藏,留时间移到圆点上
const DOT_OFFSET = 14 // px — 圆点中心到 table 边缘的距离
const PICK_WIDTH = 8 // px — 行/列拾取条的厚度(宽 for 行条,高 for 列条),紧贴 table 外边框

// 从给定元素向上找首个 overflow:auto|scroll 的祖先(含自身)。
// dot 是 position:fixed,不受 overflow 裁剪,必须自己判定是否在容器可见区内。
// 通用函数:既用于从 table 找表格滚动容器(.tableWrapper),也用于从
// editorView.dom 找编辑器滚动容器(index.vue 的 overflow-auto div)。
function findScrollContainer(el: HTMLElement): HTMLElement | null {
  let cur: Node | null = el
  while (cur && cur.nodeType === Node.ELEMENT_NODE) {
    const node = cur as HTMLElement
    if (node === document.body || node === document.documentElement) break
    const cs = getComputedStyle(node)
    if (cs.overflowX === "auto" || cs.overflowX === "scroll" || cs.overflow === "auto" || cs.overflow === "scroll") {
      return node
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

// 选址:给定 table DOM,返回 { table, tableStart,cells } 或 null。
// tableStart = 该 table 节点在所有 cell descendants pos 中的"基线绝对 pos"
// (对齐 cellPos,即 cell 在 doc 中的 descendants pos = tableStart + p)。
// 注意: 不应假设 view.nodeDOM(openGapPos-1) 总等于 table DOM;这里直接通过 posAtDOM
// 找到 open-token 处的 gap,再沿 PM 祖先链向上找 table 节点。
// 与 tableCommands 的 findTableWrapper 语义对齐($from.start(d) - 1)。
function tableMetaFromDom(v: EditorView, tableDom: HTMLElement) {
  if (!tableDom || tableDom.tagName !== "TABLE") return null
  // posAtDOM(tableDom,0) = PM 中 table open token 前的 gap 的绝对 pos(开区间)。
  const openGapPos = v.posAtDOM(tableDom, 0)
  const $gap = v.state.doc.resolve(openGapPos)
  for (let d = $gap.depth; d >= 0; d--) {
    const n = $gap.node(d)
    if (n.type.name === "table") {
      // table 节点在 doc 的绝对 start = descendants pos + 1;descendants pos 即 "tableStart"。
      const tableStart = $gap.start(d) - 1
      const cells = collectCellsOfTable(tableStart, n)
      if (cells.length) return { table: n as PMNode, tableStart, cells }
    }
  }
  return null
}

// 按 tableStart(+table 节点) 收集所有 cell 的 row-major descendants-pos。
function collectCellsOfTable(tableStart: number, table: PMNode) {
  const cells: number[] = []
  try {
    table.descendants((n, p) => {
      if (n.type.name === "table_cell" || n.type.name === "table_header") {
        cells.push(tableStart + p)
        return false
      }
      return true
    })
  } catch (e) {
    console.warn("[tableInsertHandle] collectCellsOfTable error", e)
  }
  return cells
}

// 用 TableMap 把 (rowIdx,colIdx) 转成该 table 内 cell 的绝对 descendants pos。
function cellPosAt(v: EditorView, tableDom: HTMLElement, rowIdx: number, colIdx: number): number | null {
  const meta = tableMetaFromDom(v, tableDom)
  if (!meta) return null
  const map = TableMap.get(meta.table)
  if (!map?.positionAt) return null
  const rel = map.positionAt(rowIdx, colIdx, meta.table)
  if (rel == null || rel < 0) return null
  return meta.tableStart + 1 + rel
}

export function createTableInsertHandlePlugin(opts: TableInsertHandleOptions): Plugin {
  let view: EditorView | null = null
  let dotsContainer: HTMLDivElement | null = null
  let guideEl: HTMLDivElement | null = null
  let activeTable: HTMLTableElement | null = null
  // 当前被点击拾取条(pick handle)的 active 状态 —— 完全由 plugin 自己持有,
  // 不再从 PM selection 派生。原因:点击浮层(pick handle 在 contentEditable 外侧
  // document.body 上)会触发浏览器 stray selectionchange,PM 读成一个 collapsed
  // TextSelection 并覆盖掉我们刚 dispatch 的 CellSelection —— 若是从 selection 派生
  // 则 active 立刻被清。把它独立出来后,只要用户没有再次点击编辑区内部或另一根拾取条,
  // 这个状态就不受浮层 stray selectionchange 影响;update hook 也不再需要靠
  // "PM selection 仍是整行/整列 CellSelection" 来决定 active。
  let activePick: { ui: "pick-row" | "pick-col"; index: number } | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let scrollHandler: (() => void) | null = null
  // 表格横向滚动的容器(.tableWrapper,overflow-x:auto)。dot 是 position:fixed,
  // 滚动表格时 dot 自身不动,需要按锚点 DOM 当前 rect 重算位置,让 dot 跟表格内容走。
  let wrapperScrollEl: HTMLElement | null = null
  let wrapperScrollHandler: (() => void) | null = null
  // 编辑器容器尺寸变化(侧栏开合 / 窗口缩放)时 dot/handle 是 position:fixed,
  // 不会跟着 table 走,需 ResizeObserver + window resize 触发 repositionDots 重对齐。
  let resizeObserver: ResizeObserver | null = null
  let resizeHandler: (() => void) | null = null
  // 用 WeakMap 锚定每个 dot 对应的 DOM(row/cell),滚动时重算其坐标。
  const dotAnchor = new WeakMap<HTMLDivElement, HTMLTableRowElement | HTMLTableCellElement>()
  // WeakMap 锚定行/列拾取条:行条 → 对应 <tr>DOM;列条 → 首行对应 <th>/<td> DOM(用以滚动时重算)。
  const pickRowAnchor = new WeakMap<HTMLDivElement, HTMLTableRowElement>()
  const pickColAnchor = new WeakMap<HTMLDivElement, HTMLTableCellElement>()

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
    // 拾取条 DOM 已被清空,持有的 activePick 没有渲染目标,同步清掉,
    // 避免下次进表把 .is-active 挂到不存在的 row/col index 上。
    activePick = null
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
    dot.dataset.ui = "insert" // 区分 insert dot / pick-row / pick-col;保留 dataset.kind 承载 rowheader 标记

    return dot
  }

  // 同步(重定位 + 可见性)所有行/列拾取条,用累计取整定位(独立 round 会累积出 1px 缝)。
  // 行处理顺序 = 文档 row 顺序(index 升序);列 = 首列到末列。按 index 排序后逐条用上一条的
  // round(边界)作为本条的 top/left,高度/宽度 = 下一条 round(边界) - 本条 top(末条到 table 边缘)。
  // 可见性由条中心参考点(table 外边缘)在滚动容器可见矩形内判定,隐藏超出视口区的条。
  function syncPickHandlePositions() {
    if (!dotsContainer || !activeTable) return
    const container = findScrollContainer(activeTable)
    const containerRect = container
      ? container.getBoundingClientRect()
      : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight }
    const tableRect = activeTable.getBoundingClientRect()

    // 收集并排序行条(按 row index)和列条(按 col index)。
    const rowHandles: HTMLDivElement[] = []
    const colHandles: HTMLDivElement[] = []
    for (let i = 0; i < dotsContainer.children.length; i++) {
      const el = dotsContainer.children[i] as HTMLDivElement
      const ui = el.dataset.ui
      if (ui === "pick-row") rowHandles.push(el)
      else if (ui === "pick-col") colHandles.push(el)
    }
    const cmp = (a: HTMLDivElement, b: HTMLDivElement) => Number(a.dataset.row ?? a.dataset.col ?? 0) - Number(b.dataset.row ?? b.dataset.col ?? 0)

    // 行条:按 row index 排序后,每条 top 取上一条的 round(bottom),高度由下一条 round(top) 算出。
    rowHandles.sort(cmp)
    let runningTop = Math.round(tableRect.top)
    rowHandles.forEach((el, i) => {
      const tr = pickRowAnchor.get(el)
      const thisTop = tr ? Math.round(tr.getBoundingClientRect().top) : runningTop
      const nextTopRaw = i + 1 < rowHandles.length
        ? (() => { const ntr = pickRowAnchor.get(rowHandles[i + 1]); return ntr ? Math.round(ntr.getBoundingClientRect().top) : Math.round(tableRect.bottom) })()
        : Math.round(tableRect.bottom)
      const top = Math.max(runningTop, thisTop)
      const h = Math.max(1, nextTopRaw - top)
      el.style.left = `${Math.round(tableRect.left - PICK_WIDTH)}px`
      el.style.top = `${top}px`
      el.style.width = `${Math.round(PICK_WIDTH)}px`
      el.style.height = `${h}px`
      runningTop = nextTopRaw
      const refX = tableRect.left
      const refY = top + h / 2
      const visible = refX >= containerRect.left - 2 && refX <= containerRect.right + 2 &&
        refY >= containerRect.top - 2 && refY <= containerRect.bottom + 2
      el.style.display = visible ? "" : "none"
    })

    // 列条:按 col index 排序后,每条 left 取上一条的 round(right),宽度由下一条 round(left) 算出。
    colHandles.sort(cmp)
    let runningLeft = Math.round(tableRect.left)
    colHandles.forEach((el, i) => {
      const cell = pickColAnchor.get(el)
      const thisLeft = cell ? Math.round(cell.getBoundingClientRect().left) : runningLeft
      const nextLeftRaw = i + 1 < colHandles.length
        ? (() => { const nc = pickColAnchor.get(colHandles[i + 1]); return nc ? Math.round(nc.getBoundingClientRect().left) : Math.round(tableRect.right) })()
        : Math.round(tableRect.right)
      const left = Math.max(runningLeft, thisLeft)
      const w = Math.max(1, nextLeftRaw - left)
      el.style.left = `${left}px`
      // 同 renderPickHandles:用 anchor cell 的 top 而非 tableRect.top,
      // 消除 border-collapse 下 table bounding rect 与可视上边框的 ~1px 偏移。
      const colHandleTop = cell ? cell.getBoundingClientRect().top : tableRect.top
      el.style.top = `${Math.round(colHandleTop - PICK_WIDTH)}px`
      el.style.width = `${w}px`
      el.style.height = `${Math.round(PICK_WIDTH)}px`
      runningLeft = nextLeftRaw
      const refX = left + w / 2
      const refY = tableRect.top
      const visible = refX >= containerRect.left - 2 && refX <= containerRect.right + 2 &&
        refY >= containerRect.top - 2 && refY <= containerRect.bottom + 2
      el.style.display = visible ? "" : "none"
    })
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
      const el = dots[i] as HTMLDivElement
      const uiKind = el.dataset.ui // 'insert' | 'pick-row' | 'pick-col'
      // --- 行列拾取条(pick handle) ---
      if (uiKind === "pick-row" || uiKind === "pick-col") {
        // 行/列拾取条按 index 顺序重新收集,用累计取整定位(与 renderPickHandles 同律)。
        syncPickHandlePositions()
        continue
      }
      // --- 行列插入圆点(insert dot) ---
      const anchor = dotAnchor.get(el)
      if (!anchor) continue
      const dir = el.dataset.dir
      let x: number, y: number
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
        refY = el.dataset.kind === "rowheader" ? tableRect.top : tableRect.top
        x = refX
        y = refY - DOT_OFFSET
      }
      el.style.left = `${Math.round(x - 10)}px`
      el.style.top = `${Math.round(y - 10)}px`
      const visible = refX >= containerRect.left - 2 && refX <= containerRect.right + 2 &&
        refY >= containerRect.top - 2 && refY <= containerRect.bottom + 2
      el.style.display = visible ? "flex" : "none"
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

    // 行列拾取条(pick handle):行首灰条 + 列首灰条,click 选中整行/整列(飞书式)。
    renderPickHandles(table, v, tableRect)

    // 初始渲染后把 plugin 自己持有的 activePick 反映到 .is-active。
    renderActivePick()

    // 初始渲染后立即按容器可见性同步一次 display(进入新 table 时初始滚动偏移非 0)。
    repositionDots()
  }

  // 创建单个拾取条(.velo-t-pick-handle + .velo-t-pick-handle-row/-col)。
  // 行为:进入表内可见(由 scroll 时 repositionDots + 参考点判定);hover 时微深(纯 CSS);
  // click 时 dispatch CellSelection 选中整行/整列(整块单行/单列,anchor=端 cell,head=另一端 cell)。
  // 锚点 DOM 注册进 WeakMap,scroll 时随表格内容重算坐标;dataset 带 row/col index 供 is-active 判定。
  // pos: 'first' | 'last' | null — 首末条只在靠表格外侧的一侧加圆角(中间条方形,整齐贴合)。
  function createPickHandle(opts: {
    ui: "pick-row" | "pick-col"
    index: number
    anchor: HTMLTableRowElement | HTMLTableCellElement
    v: EditorView
    tableDom: HTMLTableElement
    pos?: "first" | "last" | null
  }): HTMLDivElement {
    const el = document.createElement("div")
    el.className = `velo-t-pick-handle velo-t-pick-handle-${opts.ui === "pick-row" ? "row" : "col"}`
    el.dataset.ui = opts.ui
    if (opts.pos) el.dataset.edge = opts.pos
    if (opts.ui === "pick-row") {
      el.dataset.row = String(opts.index)
      pickRowAnchor.set(el, opts.anchor as HTMLTableRowElement)
    } else {
      el.dataset.col = String(opts.index)
      pickColAnchor.set(el, opts.anchor as HTMLTableCellElement)
    }

    // 进入 cancelHide:把鼠标移到拾取条时不触发 200ms 隐藏定时,留时间交互。
    el.addEventListener("mouseenter", () => cancelHide())

    el.addEventListener("mouseleave", () => {
      // 是否真正隐藏统一由 selection 位置决定;mouseleave 不强制 scheduleHide。
      hideIfSelectionLeftTable()
    })

    // mousedown:preventDefault + focus — 阻止浏览器把这次点击变成折叠编辑区 selection
    // mousedown:preventDefault + focus + stopPropagation — 阻止浏览器把这次浮层点击
    // 变成折叠编辑区 selection(浏览器对不在 contentEditable 内的 mousedown 会把 selection 清成 caret)。
    el.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (view && !view.hasFocus()) view.focus()
    })

    el.addEventListener("click", (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setActivePick(opts.ui, opts.index)
      dispatchPickSelection(opts.v, opts.tableDom, opts.ui, opts.index)
    })

    return el
  }

  // 条的位置分类:首/末/中。首=index 0,末=index==total-1,其余=null。
  // 首/末条在靠表格外侧的一侧加圆角,中间条方形(整齐贴合表格边框)。
  function renderPickHandles(table: HTMLTableElement, v: EditorView, tableRect: DOMRect) {
    const rows = table.querySelectorAll("tr")
    const rowRects = Array.from(rows).map(r => (r as HTMLTableRowElement).getBoundingClientRect())
    const rowCount = rows.length
    // 累计取整:每条 top = 上条的 round(bottom),高度由下一条的 round(top) 算出(末条到 tableRect.bottom),
    // 消除相邻条之间的 1px 缝(独立 round(top)+round(height) 会累积误差)。
    let rowRunningTop = Math.round(tableRect.top)
    rows.forEach((row, rowIdx) => {
      const pos: "first" | "last" | null = rowCount <= 1 ? "first" : rowIdx === 0 ? "first" : rowIdx === rowCount - 1 ? "last" : null
      const handle = createPickHandle({
        ui: "pick-row", index: rowIdx, anchor: row as HTMLTableRowElement, v, tableDom: table, pos,
      })
      const nextTop = rowIdx + 1 < rowCount ? Math.round(rowRects[rowIdx + 1].top) : Math.round(tableRect.bottom)
      handle.style.left = `${Math.round(tableRect.left - PICK_WIDTH)}px`
      handle.style.top = `${rowRunningTop}px`
      handle.style.width = `${Math.round(PICK_WIDTH)}px`
      handle.style.height = `${nextTop - rowRunningTop}px`
      rowRunningTop = nextTop
      dotsContainer!.appendChild(handle)
    })

    const firstRow = table.querySelector("tr")
    if (firstRow) {
      const cells = firstRow.querySelectorAll("th, td")
      const cellRects = Array.from(cells).map(c => (c as HTMLTableCellElement).getBoundingClientRect())
      const colCount = cells.length
      let colRunningLeft = Math.round(tableRect.left)
      cells.forEach((cell, colIdx) => {
        const pos: "first" | "last" | null = colCount <= 1 ? "first" : colIdx === 0 ? "first" : colIdx === colCount - 1 ? "last" : null
        const handle = createPickHandle({
          ui: "pick-col", index: colIdx, anchor: cell as HTMLTableCellElement, v, tableDom: table, pos,
        })
        const nextLeft = colIdx + 1 < colCount ? Math.round(cellRects[colIdx + 1].left) : Math.round(tableRect.right)
        handle.style.left = `${colRunningLeft}px`
        // 用首行 cell 的 top 而非 tableRect.top 定位:border-collapse: collapse 下
        // table 的 bounding rect 可能不含 cell 的 1px 上 border,造成 ~1px 缝。
        // cell 的 bounding rect 一定包含自身 border,是真正的可视上边框。
        const colHandleTop = cellRects[colIdx].top
        handle.style.top = `${Math.round(colHandleTop - PICK_WIDTH)}px`
        handle.style.width = `${nextLeft - colRunningLeft}px`
        handle.style.height = `${Math.round(PICK_WIDTH)}px`
        colRunningLeft = nextLeft
        dotsContainer!.appendChild(handle)
      })
    }
  }

  // 选中整行(ui=pick-row,index=r)或整列(ui=pick-col,index=c)。
  // anchor/head 选址:行=该行首 cell + 末 cell;列=首行该 cell + 末行该 cell。
  // 绝对 descendants pos 由 cellPosAt 通过 TableMap.positionAt(row,col) + tableStart + 1 算得。
  function dispatchPickSelection(v: EditorView, tableDom: HTMLTableElement, ui: "pick-row" | "pick-col", index: number) {
    const meta = tableMetaFromDom(v, tableDom)
    if (!meta) return
    const map = TableMap.get(meta.table)
    const width = map.width, height = map.height
    let anchorPos = -1, headPos = -1
    if (ui === "pick-row") {
      const r = Math.max(0, Math.min(index, height - 1))
      const a = cellPosAt(v, tableDom, r, 0)
      const h = cellPosAt(v, tableDom, r, width - 1)
      if (a && h) { anchorPos = a; headPos = h }
    } else {
      const c = Math.max(0, Math.min(index, width - 1))
      const a = cellPosAt(v, tableDom, 0, c)
      const h = cellPosAt(v, tableDom, height - 1, c)
      if (a && h) { anchorPos = a; headPos = h }
    }
    if (anchorPos < 0 || headPos < 0) return
    const sel = new CellSelection(v.state.doc.resolve(anchorPos), v.state.doc.resolve(headPos))
    v.dispatch(
      v.state.tr.setSelection(sel).setMeta("addToHistory", false),
    )
    // activePick 由 click 入口 setActiveActive 单独维护,这里不再派生。
  }

  // 把 plugin 自己持有的 activePick 反映到拾取条的 .is-active class 上。
  // 注意不再读 PM selection —— 派生关系已切断,activePick 是唯一真源。
  function renderActivePick() {
    if (!dotsContainer) return
    const all = dotsContainer.querySelectorAll<HTMLDivElement>(".velo-t-pick-handle")
    all.forEach((el) => el.classList.remove("is-active"))
    if (!activePick) return
    const attr = activePick.ui === "pick-row" ? "data-row" : "data-col"
    const selector = `.velo-t-pick-handle-${activePick.ui === "pick-row" ? "row" : "col"}[${attr}='${activePick.index}']`
    all.forEach((el) => {
      if (el.matches(selector)) el.classList.add("is-active")
    })
  }

  // 用户点击某根拾取条:记下 activePick + 反映到 .is-active。
  function setActivePick(ui: "pick-row" | "pick-col", index: number) {
    activePick = { ui, index }
    renderActivePick()
  }

  // 用户点击/把光标移到拾取条之外(编辑区内部、文档其它地方)时清掉 active。
  function clearActivePick() {
    if (!activePick) return
    activePick = null
    renderActivePick()
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
    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = null
    }
    if (resizeHandler) {
      window.removeEventListener("resize", resizeHandler)
      resizeHandler = null
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
      // 编辑器容器尺寸变化(侧栏开合 / 窗口缩放)→ table 平移,position:fixed 的
      // dot/handle 不跟走。监听容器 resize + window resize 触发 repositionDots 重对齐
      // (repositionDots 在 activeTable 为空时 no-op,无副作用)。
      resizeHandler = () => repositionDots()
      window.addEventListener("resize", resizeHandler, { passive: true })
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => repositionDots())
        resizeObserver.observe(editorView.dom)
        // editorView.dom(.ProseMirror)在侧栏开合时可能不改变尺寸 —— 编辑器内容
        // 被 max-w-[64vw] 卡住,侧栏开合只缩小了外层 overflow-auto 容器,但
        // .ProseMirror 宽度不变(只是因 justify-center 重新居中而平移)。
        // ResizeObserver 只报告尺寸变化不报告位置变化,需额外观测编辑器滚动
        // 容器(首个 overflow:auto 祖先),该容器宽度必然随侧栏开合变化。
        const editorScrollContainer = findScrollContainer(editorView.dom)
        if (editorScrollContainer && editorScrollContainer !== editorView.dom) {
          resizeObserver.observe(editorScrollContainer)
        }
      }
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
        // 用户在编辑区(view.dom)真实按下鼠标 → 清掉拾取条的 active 高亮。
        // 这套 handler 只接收 view.dom 内的事件;拾取条本身挂在 document.body 上
        // (view.dom 之外),它的 mousedown 走自己 createPickHandle 里的监听 → setActivePick,
        // 不会进来,所以不会被误清。结果:点 cell、点表外文本都取消高亮,点拾取条设置高亮。
        mousedown() {
          if (activePick) clearActivePick()
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
