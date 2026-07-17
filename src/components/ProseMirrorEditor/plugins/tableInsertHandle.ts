// 表格行列插入浮层 —— 飞书风格:鼠标在表格内时,每条行/列分割线外侧
// 显示灰色小圆点;hover 圆点时圆点变蓝 + 显示 "+" 图标 + 高亮引导线;
// 点击在分割线位置插入行/列。
//
// 实现:
// - mousemove 监听 view.dom,鼠标进入 table cell 时渲染所有分割线的圆点
// - 行圆点:在 table 左侧,每行底部一条(header 上方不画)
// - 列圆点:在 table 上方,首列左侧 + 每列右侧各一条
// - 圆点挂编辑器滚动容器内 + position:absolute,overflow:auto 天然裁剪超出
//   可见区域的浮层,不会浮到面包屑/顶栏/底栏之上
// - 圆点 hover → CSS :hover 变蓝放大 + 显示 "+" 图标;JS mouseenter 显示引导线
// - 圆点 click → opts.onInsert(cellPos, 'row'|'column', 'before'|'after')
// - 鼠标离开 table → 200ms 延迟后隐藏(留时间移到圆点上);scroll/doc 变化立即隐藏

import { Plugin, PluginKey, TextSelection } from "prosemirror-state"
import type { Node as PMNode } from "prosemirror-model"
import type { EditorView } from "prosemirror-view"
import type { EditorState } from "prosemirror-state"
import { CellSelection, TableMap } from "prosemirror-tables"
import { cmdMoveRow, cmdMoveColumn } from "../editor/shortcuts/commands/tableCommands"

export interface TableInsertHandleOptions {
  onInsert: (cellPos: number, type: "row" | "column", dir: "before" | "after") => void
}

export const tableInsertHandleKey = new PluginKey("tableInsertHandle")

const HIDE_DELAY = 200 // ms — 鼠标离开 table 后延迟隐藏,留时间移到圆点上
const DOT_OFFSET = 14 // px — 圆点中心到 table 边缘的距离
const PICK_WIDTH = 8 // px — 行/列拾取条的厚度(宽 for 行条,高 for 列条),紧贴 table 外边框

// 从给定元素向上找首个 overflow:auto|scroll 的祖先(含自身)。
// dot 是 position:absolute,挂在编辑器滚动容器内,overflow:auto 天然裁剪超出可见区的部分。
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
  // 锚点 DOM,滚动时用于重算 dot 位置(dot 是 position:absolute,挂在滚动容器内,滚动时自动跟随;但侧栏开合/字号变化时表格平移需重算)。
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
  // 当前被 hover 的 insert dot(null = 无)。repositionDots 据此同步重算 guide line
  // 位置 —— guide line 只在 mouseenter 时 showGuide 一次,不随 scroll/resize 自动跟。
  let hoveredDot: HTMLDivElement | null = null
  // 当前被点击拾取条(pick handle)的 active 状态 —— 完全由 plugin 自己持有,
  // 不再从 PM selection 派生。原因:点击浮层(pick handle 在 contentEditable 外侧
  // 编辑器滚动容器内)会触发浏览器 stray selectionchange,PM 读成一个 collapsed
  // TextSelection 并覆盖掉我们刚 dispatch 的 CellSelection —— 若是从 selection 派生
  // 则 active 立刻被清。把它独立出来后,只要用户没有再次点击编辑区内部或另一根拾取条,
  // 这个状态就不受浮层 stray selectionchange 影响;update hook 也不再需要靠
  // "PM selection 仍是整行/整列 CellSelection" 来决定 active。
  // from/to = 选区区间(含两端,沿条轴 index),单根选中时 from===to。用于:
  // ① renderActivePick 把 .is-active 应用到区间内所有条;
  // ② pointerdown 判定点击的条是否在区间内 → 决定 dragMode 是 select 还是 move。
  let activePick: { ui: "pick-row" | "pick-col"; from: number; to: number } | null = null
  // 拖拽扩展选区期间命中的瞬时区间(from..to 沿条轴 index,含两端)。仅驱动
  // `.is-active-range` 高亮,不 dispatch selection;pointerup 才落盘成 CellSelection。
  // 独立于 activePick:浏览器 stray selectionchange 会折叠 PM CellSelection,若把
  // "多选态"绑到 PM selection 跨条拖动过程中就丢了扩展态。
  let dragPickRange: { ui: "pick-row" | "pick-col"; from: number; to: number } | null = null
  // 拖拽起始上下文:pointerdown 按下哪根条、坐标、是否跨过 click/drag 阈值。
  let dragStart: {
    ui: "pick-row" | "pick-col"
    index: number
    x: number
    y: number
    moved: boolean
    pointerId: number
    tableDom: HTMLTableElement
  } | null = null
  // 当前拖拽模式:'select' = 沿条轴扩展选区(点击未激活条时);'move' = 跨轴移动整块(点击已激活条时)。
  // 由 pointerdown 根据"点击的条是否在 activePick 区间内 + 是否有 CellSelection"判定,
  // 彻底分离两种手势,消除沿轴选区扩展与跨轴 move 的冲突。
  let dragMode: "select" | "move" | null = null
  // 跨轴 move 的指针基线坐标(plugin 级,非 createPickHandle 局部):move 成功后
  // realignHandlesAfterMove 会 renderDots 重建所有拾取条,旧 handle 闭包销毁。
  // 若 moveBaseX/Y 是局部变量,新闭包里它们重置为 0,而屏幕坐标恒为正 → dir 永远 1(下/右)。
  // 提升到 plugin 级后跨 handle 重建保持值,方向计算正确。
  let moveBaseX = 0
  let moveBaseY = 0
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let scrollHandler: (() => void) | null = null
  // 表格横向滚动的容器(.tableWrapper,overflow-x:auto)。dot 是 position:absolute,
  // 滚动表格时 dot 自身不动,需要按锚点 DOM 当前 rect 重算位置,让 dot 跟表格内容走。
  let wrapperScrollEl: HTMLElement | null = null
  let wrapperScrollHandler: (() => void) | null = null
  // 编辑器容器尺寸变化(侧栏开合 / 窗口缩放)时 dot/handle 是 position:absolute,
  // 不会跟着 table 走,需 ResizeObserver + window resize 触发 repositionDots 重对齐。
  let resizeObserver: ResizeObserver | null = null
  let resizeHandler: (() => void) | null = null
  // 字号变化(App.vue watch store.fontSize → dispatch 'velo:font-size-change')→
  // 表格行高/列宽撑大但 position:absolute 浮层不跟(坐标已固定),监听该事件触发 repositionDots 重对齐。
  let fontSizeHandler: (() => void) | null = null
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

  // 条件隐藏:仅当光标已不在任何 table 内时才启动 200ms 隐藏定时。
  // 不在此处设 activeTable=null —— hideAll(定时器回调)会清。
  // 提前清 activeTable 会导致:view.focus() 触发的 selectionchange 把选区临时设到表外,
  // hideIfSelectionLeftTable 清掉 activeTable,随后 pointerup 的 dispatchPickSelection
  // 恢复 CellSelection 但对 NodeView 表格 selectionInTableDom 返回 null → activeTable
  // 仍为 null → 拖拽时 realignHandlesAfterMove 的 selectionInTableDom ?? activeTable 均为 null
  // → 提前 return,handler 不重渲染,高亮不跟随移动。
  function hideIfSelectionLeftTable() {
    if (!view) return
    // 纯逻辑 node-type 判定:只要光标(选区)仍在任意 table 内就不隐藏 dot,
    // 不受鼠标位置影响。CellSelection / TextSelection 任一情况都可靠命中。
    if (selectionInTableNode(view)) return
    scheduleHide()
  }

  function ensureElements() {
    if (!dotsContainer) {
      dotsContainer = document.createElement("div")
      dotsContainer.className = "velo-t-insert-dots"
      // 挂到编辑器滚动容器内部,position:absolute + overflow:auto 天然裁剪超出区域
      // 的浮层,不再需要手动可见性判定,也不会浮到面包屑/顶栏/底栏之上。
      const host = view ? findScrollContainer(view.dom) ?? view.dom : document.body
      host.appendChild(dotsContainer)
    }
    if (!guideEl) {
      guideEl = document.createElement("div")
      guideEl.className = "velo-t-insert-guide"
      const host = view ? findScrollContainer(view.dom) ?? view.dom : document.body
      host.appendChild(guideEl)
    }
  }

  // 浮层挂在编辑器滚动容器内(position:absolute),所有坐标需从视口坐标减去容器偏移
  // 转成容器相对坐标。absolute 的 containing block 是 padding box(= border box,因容器
  // 无 border);容器滚动时 absolute 子元素跟随滚动,故 offset = rect - scroll。
  function getHostOffset(): { ox: number; oy: number } {
    if (!view) return { ox: 0, oy: 0 }
    const host = findScrollContainer(view.dom) ?? view.dom
    const r = host.getBoundingClientRect()
    return { ox: r.left - host.scrollLeft, oy: r.top - host.scrollTop }
  }

  // .tableWrapper(表格的 overflow-x:auto 父容器)的水平可见边界。
  // 浮层挂在编辑器滚动容器内(而非 .tableWrapper 内),编辑器的 overflow:auto 只裁剪
  // 自身边界,不裁剪 .tableWrapper 的水平边界 —— 表格横向滚动时,滚出 .tableWrapper
  // 视区的列对应的 dot/handle 仍然可见。需额外按 .tableWrapper 的 left/right 裁剪。
  function getWrapperClipX(): { clipLeft: number; clipRight: number } {
    if (!activeTable) return { clipLeft: -Infinity, clipRight: Infinity }
    const wrapper = activeTable.parentElement
    if (!wrapper) return { clipLeft: -Infinity, clipRight: Infinity }
    const r = wrapper.getBoundingClientRect()
    return { clipLeft: r.left, clipRight: r.right }
  }

  function hideAll() {
    if (dotsContainer) dotsContainer.innerHTML = ""
    if (guideEl) guideEl.style.display = "none"
    activeTable = null
    hoveredDot = null
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
    const { ox, oy } = getHostOffset()
    // 非整数 dpr(Windows 125%/150% 缩放)下,整数 CSS 像素不保证对齐设备像素边界:
    // 有的线恰好对齐(锐利),有的跨 2 个设备像素(抗锯齿后看起来更宽/模糊)→ 宽窄不一。
    // 解决:snap 位置到最近的设备像素边界(Math.round(pos*dpr)/dpr),宽度保持 1 CSS px。
    // 所有线的起点对齐同一类像素边界,渲染一致;1px 宽度保证可见粗细正常。
    const dpr = window.devicePixelRatio || 1
    const linePos = Math.round((pos - (type === "column" ? ox : oy)) * dpr) / dpr
    if (type === "column") {
      guideEl.style.display = "block"
      guideEl.style.left = `${linePos}px`
      guideEl.style.top = `${Math.round(tableRect.top - oy)}px`
      guideEl.style.width = "1px"
      guideEl.style.height = `${Math.round(tableRect.bottom - tableRect.top)}px`
    } else {
      guideEl.style.display = "block"
      guideEl.style.top = `${linePos}px`
      guideEl.style.left = `${Math.round(tableRect.left - ox)}px`
      guideEl.style.width = `${Math.round(tableRect.right - tableRect.left)}px`
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
    v: EditorView,
  ): HTMLDivElement {
    const dot = document.createElement("div")
    dot.className = "velo-t-insert-dot"
    dot.innerHTML = PLUS_SVG
    // DOT_SIZE 元素居中于 (x, y),减去容器偏移转成容器相对坐标
    const { ox, oy } = getHostOffset()
    dot.style.left = `${Math.round(x - 10 - ox)}px`
    dot.style.top = `${Math.round(y - 10 - oy)}px`

    dot.addEventListener("mouseenter", () => {
      cancelHide()
      hoveredDot = dot
      // 用实时 DOM rect 重算 guide 位置,而非 createDot 闭包里的 tableRect/x/y
      // (那些是 renderDots 时的快照,侧栏开合/滚动后已过期)。
      if (!activeTable) return
      const freshRect = activeTable.getBoundingClientRect()
      if (data.anchor instanceof HTMLTableRowElement) {
        const rowRect = data.anchor.getBoundingClientRect()
        const pos = data.dir === "before" ? freshRect.top : rowRect.bottom
        showGuide("row", freshRect, pos)
      } else {
        const cellRect = data.anchor.getBoundingClientRect()
        const pos = data.dir === "before" ? cellRect.left : cellRect.right
        showGuide("column", freshRect, pos)
      }
    })

    dot.addEventListener("mouseleave", () => {
      hoveredDot = null
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
  // 可见性不再手动判定:浮层挂在编辑器滚动容器内,overflow:auto 天然裁剪超出部分。
  // 但 .tableWrapper 的水平边界需额外裁剪(浮层在编辑器容器内而非 .tableWrapper 内)。
  function syncPickHandlePositions() {
    if (!dotsContainer || !activeTable) return
    const { ox, oy } = getHostOffset()
    const { clipLeft, clipRight } = getWrapperClipX()
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
      el.style.left = `${Math.round(tableRect.left - PICK_WIDTH - ox)}px`
      el.style.top = `${Math.round(top - oy)}px`
      el.style.width = `${Math.round(PICK_WIDTH)}px`
      el.style.height = `${h}px`
      // 行条在表格左侧(tableRect.left - PICK_WIDTH),不在 .tableWrapper 水平滚动区内,
      // 不需要 .tableWrapper 水平裁剪(编辑器容器的 overflow:auto 已足够)。
      el.style.display = ""
      runningTop = nextTopRaw
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
      el.style.left = `${Math.round(left - ox)}px`
      // 同 renderPickHandles:用 anchor cell 的 top 而非 tableRect.top,
      // 消除 border-collapse 下 table bounding rect 与可视上边框的 ~1px 偏移。
      const colHandleTop = cell ? cell.getBoundingClientRect().top : tableRect.top
      el.style.top = `${Math.round(colHandleTop - PICK_WIDTH - oy)}px`
      el.style.width = `${w}px`
      el.style.height = `${Math.round(PICK_WIDTH)}px`
      // 列条水平位置跟随 cell;表格横向滚出 .tableWrapper 视区时隐藏。
      const colHandleCenterX = left + w / 2
      el.style.display = (colHandleCenterX >= clipLeft - 2 && colHandleCenterX <= clipRight + 2) ? "" : "none"
      runningLeft = nextLeftRaw
    })
  }

  // 浮层挂在编辑器滚动容器内(position:absolute),overflow:auto 天然裁剪超出部分。
  // 但 .tableWrapper 的水平边界需额外裁剪。repositionDots 重算坐标 + 水平可见性。
  function repositionDots() {
    if (!dotsContainer || !activeTable) return
    const { ox, oy } = getHostOffset()
    const { clipLeft, clipRight } = getWrapperClipX()
    const tableRect = activeTable.getBoundingClientRect()
    const dots = dotsContainer.children
    for (let i = 0; i < dots.length; i++) {
      const el = dots[i] as HTMLDivElement
      const uiKind = el.dataset.ui // 'insert' | 'pick-row' | 'pick-col'
      // --- 行列拾取条(pick handle) ---
      if (uiKind === "pick-row" || uiKind === "pick-col") {
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
      el.style.left = `${Math.round(x - 10 - ox)}px`
      el.style.top = `${Math.round(y - 10 - oy)}px`
      // 水平裁剪只对列 dot 生效(列 dot 跟随 cell 水平位置,表格横向滚动时会滚出 .tableWrapper)。
      // 行 dot 在表格左侧(tableRect.left - DOT_OFFSET),不在 .tableWrapper 水平滚动区内,不裁剪。
      const isColDot = !(anchor instanceof HTMLTableRowElement)
      const inView = !isColDot || (x >= clipLeft - 2 && x <= clipRight + 2)
      el.style.display = inView ? "flex" : "none"
      // hover 中的 dot 随重定位同步刷新 guide line(scroll/resize 导致 table 平移时
      // guide line 不会自动跟,需在此用最新坐标重算)。
      if (el === hoveredDot && inView) {
        if (anchor instanceof HTMLTableRowElement) {
          showGuide("row", tableRect, refY)
        } else {
          showGuide("column", tableRect, refX)
        }
      }
    }
  }

  function renderDots(table: HTMLTableElement, v: EditorView) {
    ensureElements()
    dotsContainer!.innerHTML = ""
    // 重渲染时旧 dot DOM 被清空,hoveredDot 指向已分离元素 → guide line 残留在旧位置。
    // 清掉 hoveredDot + 隐藏 guide,让用户重新 hover 新 dot 时才显示。
    hoveredDot = null
    hideGuide()
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
            v,
          )
          dotsContainer!.appendChild(dot)
        }
        // 每列右侧:after
        const dot = createDot(
          { type: "column", dir: "after", cellPos, anchor: cell as HTMLTableCellElement },
          cellRect.right,
          tableRect.top - DOT_OFFSET,
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
  // 交互(统一 pointer* 事件,替代 click/mousedown 分立):
  // - pointerdown(button 0):记录 dragStart;preventDefault 防 stray selectionchange;
  //   若该条已是多选矩形的一部分,先设起始记录的矩形为当前选区的 top..bottom / left..right,
  //   让用户从矩形任意位置开始跨轴拖 = 整块 move。
  // - 沿条轴方向拖过另一根条:扩展选区 high = 命中条 index(瞬时高亮 `.is-active-range`)。
  // - 跨轴方向拖(行上下/列左右)过「半根邻接线」阈值:整块 move 一步(读 PM CellSelection)。
  // - pointerup 未移动:click 派发 → 单根选中。
  // - pointerup 移动过 + 有 dragPickRange:落盘 CellSelection 覆盖 from..to。
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

    // pointerdown:判定 dragMode 后记录 dragStart。模式判定:
    //   - 点击的条在 activePick 区间内且存在 CellSelection → 'move'(跨轴拖 = 整块移动)
    //   - 否则 → 'select'(沿条轴拖 = 扩展选区;click = 单根选中)
    // 用此判定分离两种手势:首次激活条拖 = 选区扩展,松开后再拖已激活条 = 行/列移动。
    const DRAG_THRESHOLD = 4 // px — 位移 < 阈值仍视作 click
    el.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      try { (e.target as Element).setPointerCapture(e.pointerId) } catch { /* 部分旧浏览器不支持,不影响 */ }
      if (view && !view.hasFocus()) view.focus()
      el.classList.add("is-dragging") // 仅提升 z-index 浮在 insert dot 之上,无视觉 ring
      pointerDragging = true
      dragStart = {
        ui: opts.ui, index: opts.index, x: e.clientX, y: e.clientY,
        moved: false, pointerId: e.pointerId, tableDom: opts.tableDom,
      }
      capturedRange = null
      const sel = view?.state.selection
      const inActiveRange = !!activePick && activePick.ui === opts.ui
        && opts.index >= Math.min(activePick.from, activePick.to)
        && opts.index <= Math.max(activePick.from, activePick.to)
        && sel instanceof CellSelection
      if (inActiveRange) {
        // move 模式:不设 dragPickRange,保持已提交的 .is-active 高亮不变。
        dragMode = "move"
      } else {
        // select 模式:起点立刻加入瞬时选区高亮,让拖拽过程中起点与当前命中条
        // 始终保持同一种 `.is-active-range` 样式(否则起点在移到另一根条之前无任何高亮)。
        dragMode = "select"
        dragPickRange = { ui: opts.ui, from: opts.index, to: opts.index }
        capturedRange = dragPickRange
        renderActiveRange()
      }
    })

    // 本次拖拽扩展的区间备份:pointerup 落盘时用(dragPickRange 会被 clearDragState 清掉)。
    let capturedRange: { ui: "pick-row" | "pick-col"; from: number; to: number } | null = null

    // pointermove:按 dragMode 分支。select 模式只沿条轴扩展选区;move 模式只跨轴移动整块。
    // 用 elementFromPoint 而非 e.target:setPointerCapture 会让 e.target 始终停在起始条上。
    const onPointerMove = (e: PointerEvent) => {
      if (!dragStart || e.pointerId !== dragStart.pointerId || !view) return
      const dx = e.clientX - dragStart.x
      const dy = e.clientY - dragStart.y
      if (!dragStart.moved) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
        dragStart.moved = true
        moveBaseX = e.clientX
        moveBaseY = e.clientY
      }
      if (dragMode === "select") {
        // select 模式:只沿条轴扩展选区(命中同维另一根条),不做跨轴 move。
        // 命中起始条时也更新(收缩为 from===to=起点),让拖回起始位置能取消已选的第二行/列。
        const hit = pickHandleIndexFromEvent(document.elementFromPoint(e.clientX, e.clientY) as Node | null)
        if (hit && hit.ui === dragStart.ui) {
          dragPickRange = { ui: dragStart.ui, from: dragStart.index, to: hit.index }
          capturedRange = dragPickRange
          renderActiveRange()
        }
      } else if (dragMode === "move") {
        // move 模式:只跨轴移动整块,不扩展选区。
        const isRow = dragStart.ui === "pick-row"
        const res = maybeCrossAxisMove(dragStart, isRow, e.clientX, e.clientY, moveBaseX, moveBaseY)
        if (res.fired) { moveBaseX = res.baseX; moveBaseY = res.baseY }
      }
    }
    el.addEventListener("pointermove", onPointerMove)

    const onPointerUp = (e: PointerEvent) => {
      if (!dragStart || e.pointerId !== dragStart.pointerId) return
      const start = dragStart
      const mode = dragMode
      const hadRange = !!capturedRange
      const moved = start.moved
      pointerDragging = false
      clearDragState()
      if (!view) return
      if (mode === "select") {
        if (!moved) {
          // click 派发:单根选中。
          setActivePick(start.ui, start.index)
          dispatchPickSelection(view, start.tableDom, start.ui, start.index)
        } else if (hadRange && capturedRange) {
          // 拖拽扩展的区间落盘成 CellSelection 整块。
          dispatchPickSelectionRect(view, start.tableDom, capturedRange.ui, capturedRange.from, capturedRange.to)
        }
      }
      // move 模式:跨轴移动已在 pointermove 增量 dispatch;未移动则保持当前选区不变。
    }
    el.addEventListener("pointerup", onPointerUp)
    el.addEventListener("pointercancel", onPointerUp)

    return el
  }

  // 跨轴 move 判定:行条上下移 dy、列条左右移 dx;过「一根邻接条」跨度阈值时 dispatch 一步。
  // baseX/baseY 是闭包局部基线(moveBaseX/Y):首次 move 用 pointerdown 坐标,此后每次
  // 成功 move 后更新为当前指针位置,让连续推只需再过一根 span 即可再次触发。
  function maybeCrossAxisMove(
    start: { ui: "pick-row" | "pick-col"; index: number; tableDom: HTMLTableElement },
    isRow: boolean,
    curX: number,
    curY: number,
    baseX: number,
    baseY: number,
  ): { fired: boolean; baseX: number; baseY: number } {
    const v = view
    if (!v) return { fired: false, baseX, baseY }
    const sel = v.state.selection
    if (!(sel instanceof CellSelection)) return { fired: false, baseX, baseY }
    const span = neighborSpanPx(start.tableDom, start.index, isRow)
    const threshold = Math.max(8, span / 2)
    const fromBase = isRow ? (curY - baseY) : (curX - baseX)
    if (Math.abs(fromBase) < threshold) return { fired: false, baseX, baseY }
    const dir = fromBase > 0 ? 1 : -1
    // dispatchMove 内部 cmdMoveRow/cmdMoveColumn 的 dispatch 带 scrollIntoView(),
    // 会把 .tableWrapper 横向滚到选区位置(可能跳到表格最右端)和编辑器纵向滚动,
    // 导致正在拖拽的 handler 滚出视区。保存滚动位置,dispatch 后立即恢复,
    // 再 realignHandlesAfterMove 基于恢复后的位置重渲染拾取条。
    const wrapper = start.tableDom.parentElement
    const savedWrapperScrollLeft = wrapper ? wrapper.scrollLeft : 0
    const editorScroll = v ? findScrollContainer(v.dom) : null
    const savedEditorScrollTop = editorScroll ? editorScroll.scrollTop : 0
    const moved = dispatchMove(start.ui, dir)
    // move 成功后同步 activePick 区间(行/列索引随整块位移 ±dir)和 dragStart.index
    // (跟随被拖的条到新位置),让 realignHandlesAfterMove 重渲染时 .is-active 和
    // pointer capture 都落在新位置。
    if (moved) {
      // 恢复滚动位置,抵消 scrollIntoView 的影响(在 realignHandlesAfterMove 之前,
      // 让重渲染基于正确的滚动位置计算坐标)。
      if (wrapper) wrapper.scrollLeft = savedWrapperScrollLeft
      if (editorScroll) editorScroll.scrollTop = savedEditorScrollTop
      if (activePick && activePick.ui === start.ui) {
        const lo = Math.min(activePick.from, activePick.to)
        const hi = Math.max(activePick.from, activePick.to)
        activePick = { ui: activePick.ui, from: lo + dir, to: hi + dir }
      }
      start.index += dir
      // 整表被 replaceWith 后,拾取条 DOM 销毁;拖拽中需立刻重渲染到新表,让后续 move 连续。
      // 仅在 move 成功时重渲染 —— noop(触边)时表结构未变,重渲染会销毁重建拾取条导致闪烁。
      if (pointerDragging) realignHandlesAfterMove()
    }
    return { fired: moved, baseX: curX, baseY: curY }
  }

  // 估算沿位移方向从 start.index 到 start.index+dir 的像素跨度,取 start 条与邻接条的距离。
  function neighborSpanPx(table: HTMLTableElement | null, index: number, isRow: boolean): number {
    if (!table) return isRow ? 24 : 60
    if (isRow) {
      const rows = table.querySelectorAll("tr")
      const cur = rows[index]
      const next = rows[index + 1]
      if (cur && next) {
        const span = (next as HTMLTableRowElement).getBoundingClientRect().top - (cur as HTMLTableRowElement).getBoundingClientRect().top
        if (span > 0) return span
      }
      return Math.max(24, (cur?.getBoundingClientRect().height ?? 24))
    } else {
      const firstRow = table.querySelector("tr")
      if (!firstRow) return 60
      const cells = firstRow.querySelectorAll("th,td")
      const cur = cells[index]
      const next = cells[index + 1]
      if (cur && next) {
        const span = next.getBoundingClientRect().left - cur.getBoundingClientRect().left
        if (span > 0) return span
      }
      return Math.max(60, cur?.getBoundingClientRect().width ?? 60)
    }
  }

  // 条的位置分类:首/末/中。首=index 0,末=index==total-1,其余=null。
  // 首/末条在靠表格外侧的一侧加圆角,中间条方形(整齐贴合表格边框)。
  function renderPickHandles(table: HTMLTableElement, v: EditorView, tableRect: DOMRect) {
    const { ox, oy } = getHostOffset()
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
      handle.style.left = `${Math.round(tableRect.left - PICK_WIDTH - ox)}px`
      handle.style.top = `${Math.round(rowRunningTop - oy)}px`
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
        handle.style.left = `${Math.round(colRunningLeft - ox)}px`
        // 用首行 cell 的 top 而非 tableRect.top 定位:border-collapse: collapse 下
        // table 的 bounding rect 可能不含 cell 的 1px 上 border,造成 ~1px 缝。
        // cell 的 bounding rect 一定包含自身 border,是真正的可视上边框。
        const colHandleTop = cellRects[colIdx].top
        handle.style.top = `${Math.round(colHandleTop - PICK_WIDTH - oy)}px`
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
  // activePick.from..to 区间内所有同轴条都加 .is-active(多行/多列选中时整块高亮)。
  // 注意不再读 PM selection —— 派生关系已切断,activePick 是唯一真源。
  function renderActivePick() {
    if (!dotsContainer) return
    const all = dotsContainer.querySelectorAll<HTMLDivElement>(".velo-t-pick-handle")
    all.forEach((el) => el.classList.remove("is-active"))
    if (!activePick) return
    const lo = Math.min(activePick.from, activePick.to)
    const hi = Math.max(activePick.from, activePick.to)
    all.forEach((el) => {
      if (el.dataset.ui !== activePick!.ui) return
      const idx = Number(el.dataset.row ?? el.dataset.col ?? -1)
      if (idx >= lo && idx <= hi) el.classList.add("is-active")
    })
  }

  // 用户点击某根拾取条:记下 activePick(from=to=index,单根)+ 反映到 .is-active。
  function setActivePick(ui: "pick-row" | "pick-col", index: number) {
    activePick = { ui, from: index, to: index }
    renderActivePick()
  }

  // 用户点击/把光标移到拾取条之外(编辑区内部、文档其它地方)时清掉 active。
  function clearActivePick() {
    if (!activePick) return
    activePick = null
    renderActivePick()
  }

  // 拖拽扩展选区:把瞬时区间(from..to 沿条轴 index,含两端)反映到 `.is-active-range` 高亮。
  // 仅视觉,不动 PM selection;pointerup 才落盘。高亮叠加在 `.is-active` 之上。
  function renderActiveRange() {
    if (!dotsContainer) return
    const all = dotsContainer.querySelectorAll<HTMLDivElement>(".velo-t-pick-handle")
    all.forEach((el) => el.classList.remove("is-active-range"))
    if (!dragPickRange) return
    const { ui, from, to } = dragPickRange
    const lo = Math.min(from, to), hi = Math.max(from, to)
    const sub = dotsContainer.querySelectorAll<HTMLDivElement>(
      `.velo-t-pick-handle-${ui === "pick-row" ? "row" : "col"}`,
    )
    sub.forEach((el) => {
      const idx = Number(el.dataset.row ?? el.dataset.col ?? -1)
      if (idx >= lo && idx <= hi) el.classList.add("is-active-range")
    })
  }

  // 把拖拽扩展的区间(from..to 沿条轴 index,含两端)落盘成 CellSelection 选中整块。
  // 行: anchor=(from,0) head=(to,w-1); 列: anchor=(0,from) head=(h-1,to)。
  function dispatchPickSelectionRect(v: EditorView, tableDom: HTMLTableElement, ui: "pick-row" | "pick-col", from: number, to: number) {
    const meta = tableMetaFromDom(v, tableDom)
    if (!meta) return
    const map = TableMap.get(meta.table)
    const width = map.width, height = map.height
    const lo = Math.max(0, Math.min(from, to))
    const hi = Math.min(ui === "pick-row" ? height - 1 : width - 1, Math.max(from, to))
    let anchorPos = -1, headPos = -1
    if (ui === "pick-row") {
      const a = cellPosAt(v, tableDom, lo, 0)
      const h = cellPosAt(v, tableDom, hi, width - 1)
      if (a && h) { anchorPos = a; headPos = h }
    } else {
      const a = cellPosAt(v, tableDom, 0, lo)
      const h = cellPosAt(v, tableDom, height - 1, hi)
      if (a && h) { anchorPos = a; headPos = h }
    }
    if (anchorPos < 0 || headPos < 0) return
    const sel = new CellSelection(v.state.doc.resolve(anchorPos), v.state.doc.resolve(headPos))
    v.dispatch(v.state.tr.setSelection(sel).setMeta("addToHistory", false))
    // 落盘选区区间(from..to)作为 activePick,让区间内所有条显示 .is-active。
    activePick = { ui, from: lo, to: hi }
    dragPickRange = null
    renderActiveRange()
    renderActivePick()
  }

  // 跨轴拖 = 沿矩形方向把整块单步 move。复用 tableCommands 的 cmdMoveRow/cmdMoveColumn,
  // 它们读 view.state.selection 的 CellSelection 矩形做整块 swap + 触边 noop + 保矩形。
  // 这里直接用 plugin 自己的 view 调用,避免依赖 tableEditor 全局 _view。
  function dispatchMove(ui: "pick-row" | "pick-col", direction: number): boolean {
    const v = view
    if (!v) return false
    const sel = v.state.selection
    // 只在 CellSelection 矩形下移动;无矩形(退化成点选)不移动,避免单点误拖。
    if (!(sel instanceof CellSelection)) return false
    if (ui === "pick-row") return cmdMoveRow(direction)(v.state, v.dispatch, v)
    else return cmdMoveColumn(direction)(v.state, v.dispatch, v)
  }

  // 拖拽 move 一步后,整表被 replaceWith。PM 的 TableView NodeView(columnResizing)
  // update() 返回 true 时会复用同一个 <table> DOM 元素(只替换子节点 <tr>/<td>),
  // 导致旧拾取条锚点(WeakMap 指向已分离的 <tr>/<td>)失效 + .is-active 位置不跟随。
  // 因此无论 <table> DOM 是否同引用,都必须重渲染拾取条 + 调 renderActivePick 把
  // 已更新的 activePick 区间反映到 .is-active,并更新 dragStart.tableDom + 重捕获指针。
  //
  // 注意:selectionInTableDom 对有 NodeView 的 table 会返回 null —— v.nodeDOM(tableStart)
  // 返回的是 TableView 的外层 <div class="tableWrapper"> 而非 <table>。但 TableView 的
  // update() 返回 true 时复用同一 <table> 元素(子节点已更新为移动后的行),所以回退到
  // activeTable 仍有效:它的 children 是新的,querySelectorAll("tr") 拿到的是移动后的行。
  function realignHandlesAfterMove() {
    const v = view
    if (!v || !dragStart) return
    const newTable = selectionInTableDom(v) ?? activeTable
    if (!newTable) return
    activeTable = newTable
    renderDots(newTable, v)
    dragStart.tableDom = newTable
    // 在新条上重新捕获指针,让 pointermove/up 继续送达。
    const attr = dragStart.ui === "pick-row" ? "data-row" : "data-col"
    const newEl = dotsContainer?.querySelector<HTMLElement>(
      `.velo-t-pick-handle-${dragStart.ui === "pick-row" ? "row" : "col"}[${attr}='${dragStart.index}']`,
    )
    if (newEl) {
      newEl.classList.add("is-dragging")
      try { newEl.setPointerCapture(dragStart.pointerId) } catch { /* 忽略 */ }
    }
  }

  // 从 event target 拾取当前所在拾取条的 index + ui;命不中返回 null。
  function pickHandleIndexFromEvent(target: Node | null): { ui: "pick-row" | "pick-col"; index: number } | null {
    let cur: Node | null = target instanceof HTMLElement ? target : target ? target.parentElement : null
    while (cur && cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as HTMLElement
      if (el.classList && el.classList.contains("velo-t-pick-handle")) {
        const ui = el.dataset.ui === "pick-col" ? "pick-col" : "pick-row"
        const raw = ui === "pick-row" ? el.dataset.row : el.dataset.col
        const idx = Number(raw ?? "nan")
        if (!Number.isNaN(idx)) return { ui, index: idx }
      }
      cur = cur.parentNode
    }
    return null
  }

  // pointer 按下拾取条期间为 true,抑制 update hook 的 doc 变化 hideAll() ——
  // 拖拽移动会 dispatch 改表的 tr,若此时 hideAll 会把正在拖的拾取条清掉。
  let pointerDragging = false
  // 清理拖拽瞬时态(dragPickRange / dragStart / dragMode),拾取条 .is-dragging 一并移除。
  function clearDragState() {
    if (!dotsContainer) return
    dotsContainer.querySelectorAll(".velo-t-pick-handle.is-dragging").forEach((el) => el.classList.remove("is-dragging"))
    if (dragPickRange) { dragPickRange = null; renderActiveRange() }
    dragStart = null
    dragMode = null
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
      // 鼠标不在 cell 上。dot 挂在编辑器滚动容器内(view.dom 外的兄弟),findCellDom 走出来,
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
  // dot 是 position:absolute,挂在滚动容器内;滚动事件里调用 repositionDots
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
    if (fontSizeHandler) {
      window.removeEventListener("velo:font-size-change", fontSizeHandler)
      fontSizeHandler = null
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
      // 拖拽 move 期间 cmdMoveRow/cmdMoveColumn 的 scrollIntoView 会触发编辑器垂直滚动,
      // useCapture:true 的 window scroll 监听会无条件 hideAll() → 销毁拾取条 + 清空
      // activePick → 高亮闪烁。与 update hook 一致,pointerDragging 期间跳过 hideAll。
      scrollHandler = () => { if (!pointerDragging) hideAll() }
      window.addEventListener("scroll", scrollHandler, true)
      // 编辑器容器尺寸变化(侧栏开合 / 窗口缩放)→ table 平移,position:absolute 的
      // dot/handle 不跟走。监听容器 resize + window resize 触发 repositionDots 重对齐
      // (repositionDots 在 activeTable 为空时 no-op,无副作用)。
      resizeHandler = () => repositionDots()
      window.addEventListener("resize", resizeHandler, { passive: true })
      // 字号变化 → 表格撑大,position:absolute 的 dot/handle 不跟(坐标已固定),监听自定义事件重对齐。
      // 事件触发时 CSS font-size 刚改但浏览器尚未 reflow,getBoundingClientRect 读到的
      // 仍是旧尺寸 → 需延到下一帧(浏览器 layout 完成后)再 repositionDots。
      fontSizeHandler = () => requestAnimationFrame(() => repositionDots())
      window.addEventListener("velo:font-size-change", fontSizeHandler)
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
          // doc 变化时隐藏(插入后表结构已变,圆点位置过期)。
          // 例外:拖拽移动整块时也会 dispatch 改表的 tr,此时若 hideAll 会把正在拖的
          // 拾取条清掉 —— pointerDragging 为 true 时跳过隐藏,让拖拽连续;pointerup
          // 后 clearDragState 会触发重渲染把拾取条对齐到新表。
          if (prevState.doc !== v.state.doc) {
            if (!pointerDragging) {
              // 插入行/列后表结构已变,圆点位置过期。但插入命令会自动聚焦新增行/列,
              // 光标仍在表内时应重渲染 dots 而非直接隐藏,让用户可连续点击插入。
              // selectionInTableDom 对有 NodeView 的 table 返回 null(拿到的是
              // tableWrapper div 而非 <table>),用 selectionInTableNode 做可靠判定,
              // DOM 回退到 activeTable(TableView 复用同一 <table> 元素)。
              if (selectionInTableNode(v)) {
                cancelHide()
                const tableDom = selectionInTableDom(v) ?? activeTable
                if (tableDom) {
                  activeTable = tableDom
                  renderDots(tableDom, v)
                }
              } else {
                hideAll()
              }
            }
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
// 这套 handler 只接收 view.dom 内的事件;拾取条本身挂在编辑器滚动容器内
      // (view.dom 外的兄弟),它的 mousedown 走自己 createPickHandle 里的监听 → setActivePick,
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
