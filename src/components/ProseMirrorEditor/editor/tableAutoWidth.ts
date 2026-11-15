// 表格列宽自适应 —— view-only 的「auto 测量 → 同帧锁定」。
//
// 背景:GFM 没有列宽语义,markdownIO 建表时 cell 的 colwidth 全为 null,
// columnResizing 的 TableView 因此把 <colgroup> 写成空宽度;原先 CSS 又是
// table-layout: fixed + width: 100%,浏览器只能按列数均分。
//
// 本模块不碰 doc:不 dispatch transaction、不写 colwidth、不改 markdownIO。
// 只做两件事:
//   1) 未锁定态保持 table-layout: auto(浏览器按内容分配),首个可见态就是自适应的,
//      不存在「先均分再跳到自适应」这一帧;
//   2) 在 rAF(paint 之前)里同步读出 auto 布局的列宽,归一化成 px 写回
//      <colgroup>,同一回调内切到 locked(fixed)。浏览器该帧只 paint 最终态;
//      写回的是刚读到的同一组宽度(1px 量化,列宽之和 = 容器宽度 - 1px 折叠边框),
//      发生在首次 paint 之前,用户只看到一次自适应布局 → 零跳变。
//
// 锁定态永不因 hover / 拖拽切换 table-layout:columnResizing 的 hover 判定基于
// cell 边界的 5px 命中区,布局一变边界就位移 → hover 反转 → 自激闪烁。
// 而官方 updateColumnsOnResize 每次(含 PM 的 view.update、拖拽预览)会把无
// colwidth 列的 inline width 清成 '',所以自适应宽度同时写进 --velo-col-width,
// 由 _editor-tables.scss 的 col 规则兜底;拖拽 override 列的 inline px 优先级
// 更高,自然覆盖兜底值。
//
// 列宽一律用 px(不用百分比):拖拽预览写的是 px,混合 px / % 时 fixed 布局会在
// 固定的 100% 表格宽度下重新平衡,吃掉 override 增量 → 第一次拖拽不跟手。
// 配合 locked 态的 width: max-content,表格总宽 = 列宽之和,override 变化即总宽
// 变化。Chromium 实测 width:auto 仍会把表格限制在容器宽度内按比例缩放列宽,
// 只有 max-content 能让 override 精确跟手;超出部分交给 .tableWrapper 横向滚动。
//
// mouseup 时官方 updateColumnWidth 只给被拖的那一列写 colwidth,其余列仍是 0。
// 因此有手动列时,自动列必须保持「无手动列时的基准宽度」,不能按
// available - manualSum 重新分配:否则拖宽一列就把其它列压到 MIN_COL_PX,出现
// 文字竖排 / 行高暴涨,且预览宽度与最终宽度对不上。
//
// 锁定后普通打字不重测(列宽不动,文字在固定列宽内换行);只在结构变化、
// 字体加载、容器宽度变化时重算;手动列宽变化只需按缓存比例同步重算一次。
// 导出 HTML 没有 NodeView,天然停在 auto 态。

import { TableView } from 'prosemirror-tables'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'

/** <table> 上的布局态标记。无 / auto = 浏览器自适应(也是测量态),locked = 宽度锁定。 */
const LAYOUT_AUTO = 'auto'
const LAYOUT_LOCKED = 'locked'

/** 自动列的最小宽度,对齐 columnResizing 的 defaultCellMinWidth(48)。 */
const MIN_COL_PX = 48

/**
 * border-collapse: collapse 下 <table> 的边框盒宽度 = colgroup 列宽之和 + 1px 外框。
 * locked 态 width: max-content 按边框盒算;若让列宽之和恰等于 .tableWrapper 的
 * clientWidth,表格就会宽出 1px,每个表格常驻一条横向滚动条。把容器宽度折算成
 * 「列宽之和的预算」时扣掉这 1px,初始表格正好铺满且无滚动条;拖宽后总宽超出
 * 容器,滚动条才按需出现。
 */
const COLLAPSED_BORDER_PX = 1

/** .tableWrapper clientWidth → 可分配给 <colgroup> 的 px 预算。 */
export function columnWidthBudget(containerWidth: number): number {
  return containerWidth - COLLAPSED_BORDER_PX
}

export interface WidthPlan {
  /** 逐个写入 <col style="width"> 的 px 值。 */
  widths: string[]
  /** 所有列宽之和。locked 态 table 用 width: max-content,表格总宽即等于这个值;超出容器部分由 .tableWrapper 横向滚动。 */
  totalPx: number
}

/**
 * 读首行 cell 的 colwidth,按 colspan 展开。
 * colwidth 数组里的 0 是 prosemirror-tables 的「未设置」占位,与 null 同样处理。
 */
export function readManualWidths(node: PMNode): (number | null)[] {
  const first = node.firstChild
  if (!first) return []
  const out: (number | null)[] = []
  first.forEach((cell) => {
    const colspan = Math.max(1, Number(cell.attrs.colspan) || 1)
    const colwidth = cell.attrs.colwidth as number[] | null
    for (let j = 0; j < colspan; j++) {
      const w = colwidth?.[j]
      out.push(w != null && w > 0 ? w : null)
    }
  })
  return out
}

/** 把 auto 布局读到的列宽归一化成和为 1 的比例;全 0 / 非法时退回均分。 */
export function normalizeRatios(natural: number[]): number[] {
  const n = natural.length
  if (n === 0) return []
  const clean = natural.map((w) => (Number.isFinite(w) && w > 0 ? w : 0))
  const sum = clean.reduce((a, b) => a + b, 0)
  if (sum <= 0) return clean.map(() => 1 / n)
  return clean.map((w) => w / sum)
}

/**
 * 生成列宽方案,一律输出 px。
 *
 * columnResizing 的拖拽预览(updateColumnsOnResize)只写 px:override 列写新的
 * inline px,没有 doc colwidth 的列写空字符串(由 CSS 变量兜底)。若自适应列宽
 * 用百分比,fixed 布局下「% 列 + px override 列」混合、表格宽度又被 100% 锁死
 * 时,浏览器会重新平衡列宽吃掉 override 增量 → 第一次拖拽不跟手。统一 px 后
 * 表格宽度 = 列宽总和(locked 态 width: max-content),override 直接反映为总宽变化。
 *
 * 有手动列时,自动列保持「无手动列时的基准宽度」(available × 内容比例),不再
 * 被塞进 available - manualSum 的剩余空间:updateColumnWidth 在 mouseup 时只写
 * 被拖列的 colwidth,其余列仍是 0;若按剩余空间重算,拖宽一列就会把其它列压到
 * MIN_COL_PX(截图里的竖排文字 + 行高暴涨)。总宽允许 > available,由
 * .tableWrapper 横向滚动,这也是「拖拽预览宽度 = mouseup 后宽度」的前提。
 *
 * available <= 0(容器隐藏 / 未挂载)时返回 null,调用方保持 auto 态不锁定。
 */
export function computeColumnWidths(params: {
  ratios: number[]
  manual: (number | null)[]
  available: number
}): WidthPlan | null {
  const { ratios, available } = params
  const n = ratios.length
  if (n === 0 || available <= 0) return null
  const manual = Array.from({ length: n }, (_, i) => params.manual[i] ?? null)
  const hasManual = manual.some((w) => w != null)
  // 自动列基准 = 无手动列时的锁定宽度,与首帧实测 / 拖拽预览的 DOM 完全一致。
  const px = ratios.map((r, i) => {
    const w = manual[i]
    if (w != null) return Math.round(w)
    return Math.max(MIN_COL_PX, Math.round(available * r))
  })
  // 1px 量化误差只在「无手动列」时补给最大的自动列,使总和精确等于 available
  // (铺满容器、零跳变)。有手动列时不校正:校正会改动自动列,导致 mouseup 后
  // 与拖拽预览不一致,而且此时总宽本就允许不等于 available。
  if (!hasManual) {
    const diff = available - px.reduce((a, b) => a + b, 0)
    if (diff !== 0) {
      let fixIdx = 0
      for (let i = 1; i < n; i++) if (px[i] > px[fixIdx]) fixIdx = i
      px[fixIdx] = Math.max(MIN_COL_PX, px[fixIdx] + diff)
    }
  }
  const totalPx = px.reduce((a, b) => a + b, 0)
  return { widths: px.map((w) => `${w}px`), totalPx }
}

/** 结构签名:行数 + 列数(colspan 展开)。打字改文本不会变 → 不触发重测。 */
function tableShape(node: PMNode): string {
  return `${node.childCount}:${readManualWidths(node).length}`
}

// ============================================================
//  同帧批处理:一帧内所有表格「统一切 auto → 统一读 → 统一锁」,
//  避免逐表读写交错造成多次强制 layout。
// ============================================================

const pending = new Map<AutoWidthTableView, boolean>()
const activeViews = new Set<AutoWidthTableView>()
let rafHandle = 0
let fontsWatched = false

function scheduleMeasure(view: AutoWidthTableView, remeasure: boolean): void {
  pending.set(view, (pending.get(view) ?? false) || remeasure)
  if (rafHandle) return
  const win = view.ownerWindow
  rafHandle =
    typeof win.requestAnimationFrame === 'function'
      ? win.requestAnimationFrame(flush)
      : win.setTimeout(flush, 16)
}

function flush(): void {
  rafHandle = 0
  const batch = Array.from(pending.entries())
  pending.clear()
  const measured = new Map<AutoWidthTableView, number[] | null>()
  for (const [view, remeasure] of batch) if (remeasure) view.enterMeasuring()
  for (const [view, remeasure] of batch) {
    if (remeasure) measured.set(view, view.readNaturalWidths())
  }
  for (const [view, remeasure] of batch) {
    view.applyWidths(remeasure ? (measured.get(view) ?? null) : null)
  }
}

/** Web 字体晚到会改变 natural 宽度,ready 后对所有存活的表格重测一次。 */
function watchFonts(win: Window): void {
  if (fontsWatched) return
  const fonts = win.document.fonts
  if (!fonts?.ready) return
  fontsWatched = true
  void fonts.ready.then(() => {
    for (const view of activeViews) scheduleMeasure(view, true)
  })
}

/**
 * columnResizing 的自定义 NodeView。
 * 继承官方 TableView 以保留 colgroup 维护 / ignoreMutation / 拖拽预览逻辑,
 * 只在 update 之后补写自适应列宽。
 */
export class AutoWidthTableView extends TableView {
  readonly ownerWindow: Window
  private ratios: number[] | null = null
  private locked = false
  private lastShape: string
  private lastAvailable = 0
  private observer: ResizeObserver | null = null
  private disposed = false

  constructor(node: PMNode, defaultCellMinWidth: number, view: EditorView) {
    super(node, defaultCellMinWidth)
    this.ownerWindow = view.dom.ownerDocument.defaultView ?? window
    // 显式声明测量态,避免上一个 NodeView 复用 DOM 时残留 locked。
    this.table.dataset.veloWidths = LAYOUT_AUTO
    this.lastShape = tableShape(node)
    activeViews.add(this)
    watchFonts(this.ownerWindow)
    this.observeWrapper()
    // 构造时 tbody 还是空的;rAF 时 PM 已渲染完子节点,且赶在首次 paint 之前。
    scheduleMeasure(this, true)
  }

  update(node: PMNode): boolean {
    const shapeChanged = tableShape(node) !== this.lastShape
    // super.update → updateColumnsOnResize 会把无 colwidth 列的 inline width
    // 清空(CSS 变量已兜底,视觉不会退回均分)。
    const ok = super.update(node)
    if (!ok) return false
    this.lastShape = tableShape(node)
    if (shapeChanged || !this.locked) {
      // 增删行列 / 尚未锁定:重新测量。
      scheduleMeasure(this, true)
    } else {
      // 结构没变(打字、拖拽结束):按缓存比例同步补回 inline width。
      // 不 remeasure、不切布局,列边界纹丝不动,hover 判定不会反转。
      this.applyWidths(null)
    }
    return true
  }

  /** 清空上一轮 colgroup 宽度与表格 inline 尺寸,让 auto 布局完全按内容算。 */
  enterMeasuring(): void {
    this.table.dataset.veloWidths = LAYOUT_AUTO
    // updateColumnsOnResize 可能留下 width / minWidth;不消掉会钳住测量帧。
    this.table.style.width = ''
    this.table.style.minWidth = ''
    for (const col of Array.from(this.colgroup.children)) {
      const colEl = col as HTMLTableColElement
      colEl.style.width = ''
    }
  }

  /** 读首行真实列宽。视口外 / colspan 不规则时返回 null,退化为保持 auto 态。 */
  readNaturalWidths(): number[] | null {
    const colCount = this.colgroup.children.length
    const row = this.table.querySelector('tr')
    if (!row || colCount === 0 || row.cells.length !== colCount) return null
    const widths = Array.from(row.cells, (cell) => cell.getBoundingClientRect().width)
    if (!widths.some((w) => w > 0)) return null
    return widths
  }

  /** 写回 colgroup + 切 locked。首次必须与 enterMeasuring 在同一个 rAF 回调里。 */
  applyWidths(natural: number[] | null): void {
    if (this.disposed) return
    if (natural) this.ratios = normalizeRatios(natural)
    const cols = Array.from(this.colgroup.children) as HTMLTableColElement[]
    if (!this.ratios || cols.length === 0 || cols.length !== this.ratios.length) {
      this.fallbackToAuto()
      return
    }
    // 只读 clientWidth:同步流程(update / ResizeObserver)里调用时避免
    // getBoundingClientRect 触发强制 layout。lastAvailable 存原始容器宽度,
    // 供 ResizeObserver 比较用;列宽预算另扣掉折叠边框的 1px。
    const containerWidth = this.dom.clientWidth
    const plan = computeColumnWidths({
      ratios: this.ratios,
      manual: readManualWidths(this.node),
      available: columnWidthBudget(containerWidth),
    })
    if (!plan) {
      // 容器不可见:保持 auto 态,浏览器仍按内容自适应;可见后由 ResizeObserver
      // 或下一次 update 重新锁定。
      this.fallbackToAuto()
      return
    }
    cols.forEach((col, i) => {
      const w = plan.widths[i]
      if (col.style.width !== w) col.style.width = w
      // updateColumnsOnResize 只改 style.width,绝不动自定义属性。它清空
      // inline width 后,CSS 的 col{width:var(--velo-col-width)} 仍锁定 px
      // 列宽;拖拽 override 列写的 inline px 优先级更高,会覆盖兜底值。
      col.style.setProperty('--velo-col-width', w)
    })
    // 清掉 updateColumnsOnResize 留下的 inline width / minWidth → CSS 的
    // width: max-content 生效,表格总宽 = colgroup 的 px 列宽之和,拖拽时 override
    // 变化直接反映为总宽变化,超出容器由 .tableWrapper 横向滚动。
    // 不设 minWidth:否则 override 变窄时表格宽度会被旧总宽钳住,又触发重新平衡。
    this.table.style.width = ''
    this.table.style.minWidth = ''
    this.table.dataset.veloWidths = LAYOUT_LOCKED
    this.locked = true
    this.lastAvailable = containerWidth
  }

  private fallbackToAuto(): void {
    this.ratios = null
    this.locked = false
    // dataset 回到 auto 后 col 的 CSS 变量兜底不再命中,但 inline px 仍会生效:
    // 必须一并清掉,否则退化的 auto 态还留着上一轮的列宽 hints。
    this.table.dataset.veloWidths = LAYOUT_AUTO
    this.table.style.width = ''
    this.table.style.minWidth = ''
    for (const col of Array.from(this.colgroup.children)) {
      const colEl = col as HTMLTableColElement
      colEl.style.width = ''
    }
  }

  private observeWrapper(): void {
    if (typeof ResizeObserver === 'undefined') return
    this.observer = new ResizeObserver(() => {
      const available = this.dom.clientWidth
      if (available <= 0 || Math.abs(available - this.lastAvailable) < 1) return
      // 同步按缓存比例重算 px:不读布局、不 remeasure,列宽等比例缩放,
      // 侧栏拖拽无闪烁。px 模式必须重算(百分比才会自动跟随容器)。
      this.applyWidths(null)
    })
    this.observer.observe(this.dom)
  }

  destroy(): void {
    this.disposed = true
    this.observer?.disconnect()
    this.observer = null
    activeViews.delete(this)
    pending.delete(this)
  }
}
