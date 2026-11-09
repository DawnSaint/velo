// 字符级新增下划线的 overlay(#diff-wysiwyg)
//
// 一行里「正文 + 行内 code + 正文」全是新增时,视觉上应该是一条不断开的绿线。
// CSS 做不到:一条 Decoration.inline 会被 PM 在 code mark 边界拆成三个 span,
// 而 text-decoration 只画在有文字的 run 上 —— code 胶囊左右各 6px padding
// 里没有文字,必然留缝;skip-ink 还会在 CJK 笔画处把线切碎。实测把整段新增
// 包成单个 span 也没用,渲染像素与拆成三个 span 完全一致。
//
// 因此和整框一样改由 overlay 画:按每个新增片段的 DOM rect 折成「同一行的
// 连续区间」,给每段画一个绝对定位的 2px 空 div。盒子是盒级的,天然跨过
// padding / mark 边界 / 换行;坐标相对 layer(而不是视口),滚动不需要重算。
//
// 线的高度仍与 CSS underline 对齐,而不是拍一个固定偏移:
//   underlineTop = baseline + text-underline-offset
//   baseline     = rect.bottom - fontBoundingBoxDescent(font)
// descent 由 canvas measureText 按该片段真实 computed font 量出(jsdom 等
// 无 canvas 时退回 0.25em,实测 16/24/34px 分别是 4/6/9px)。offset 与
// thickness 直接读 computedStyle,与 @mixin diff-rule 单一真相源。
//
// 由 diffGroupFrames.ts 的 refresh 驱动:共用同一个 layer、同一套
// MutationObserver / ResizeObserver / rAF,不新增挂载点,也不碰 view.dom。
// 只扫已渲染 DOM —— 视口增量构建下视口外暂无装饰,滚动追加时 observer
// 会补画,与整框的已知边界一致。

import type { EditorView } from 'prosemirror-view'

/** 允许合并的水平间隙:只剩亚像素 / 舍入误差才连,夹着原文就断开 */
const MERGE_GAP = 2
/** 判定两个盒子在同一行所需的垂直重叠(px) */
const MIN_OVERLAP = 2

/** 单个新增片段的一个行内 fragment(已把 code 胶囊的 padding 算进左右) */
export interface InlineBox {
  left: number
  right: number
  top: number
  bottom: number
  /** rect.bottom - descent,该 fragment 的字母基线 */
  baseline: number
  /** text-underline-offset(px) */
  offset: number
  /** text-decoration-thickness(px) */
  thickness: number
}

/** 一条连续的下划线,坐标是视口坐标,渲染时再换算成 layer 内坐标 */
export interface UnderlineSegment {
  left: number
  right: number
  top: number
  height: number
}

export interface CollectedBoxes {
  boxes: InlineBox[]
  /** 需要接管的目标元素数(跳过脚注上标等走 outline 的) */
  targets: number
}

function px(value: string, fallback: number): number {
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

// 字体度量按 font shorthand 缓存:一屏里可能几百个片段,但字体组合通常个位数。
// jsdom 的 canvas.getContext 会打 not-implemented 日志,只尝试一次并吞掉。
const descentCache = new Map<string, number>()
let ctx: CanvasRenderingContext2D | null = null
let ctxTried = false

function fontDescent(cs: CSSStyleDeclaration, fontSize: number): number {
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const cached = descentCache.get(font)
  if (cached !== undefined) return cached
  if (!ctxTried) {
    ctxTried = true
    try {
      ctx = document.createElement('canvas').getContext('2d')
    } catch {
      ctx = null
    }
  }
  let d = 0
  if (ctx) {
    ctx.font = font
    d = ctx.measureText('Hg').fontBoundingBoxDescent || 0
  }
  if (!d) d = fontSize * 0.25 // canvas 不可用时的兜底,实测比值 ≈ 0.25
  if (descentCache.size > 256) descentCache.clear()
  descentCache.set(font, d)
  return d
}

/**
 * 整个行内 code 的内容都是新增时,才把胶囊左右 padding 算进线段。
 * 只新增了 code 内一半文字时不能外扩 —— 否则会把留存文字一起标成新增。
 */
function wholeAddedCode(el: HTMLElement, root: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el
  while (cur && cur !== root) {
    if (cur.tagName === 'CODE') {
      if (cur === el) return cur // decoration 直接落在 code 元素上
      if (cur.querySelector('.velo-diff-removed')) return null
      const added = cur.querySelectorAll('.velo-diff-added-inline')
      if (!added.length) return null
      let covered = 0
      for (const a of Array.from(added)) covered += a.textContent?.length ?? 0
      return covered === (cur.textContent?.length ?? 0) ? cur : null
    }
    cur = cur.parentElement
  }
  return null
}

function rectsOf(el: HTMLElement): DOMRect[] {
  const list = typeof el.getClientRects === 'function' ? Array.from(el.getClientRects()) : []
  if (list.length) return list
  // jsdom / 未布局的元素没有 client rects,退回 bounding rect
  const r = el.getBoundingClientRect()
  return r.width > 0 || r.height > 0 ? [r] : []
}

/** 收集当前已渲染 DOM 里所有字符级新增片段的几何 */
export function collectInlineBoxes(view: EditorView): CollectedBoxes {
  const boxes: InlineBox[] = []
  let targets = 0
  const root = view.dom as HTMLElement
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.velo-diff-added-inline'))) {
    // 脚注上标用 outline(下划线会画在抬高后的空白里);删除块里的是旧内容
    if (el.closest('.footnote-ref-node, .velo-diff-deleted-block, .velo-diff-deleted-group'))
      continue
    const cs = getComputedStyle(el)
    targets++

    const fontSize = px(cs.fontSize, 16)
    const descent = fontDescent(cs, fontSize)
    const offset = px(cs.textUnderlineOffset, 3)
    const thickness = px(cs.textDecorationThickness, 2)

    const code = wholeAddedCode(el, root)
    const ccs = code ? getComputedStyle(code) : null
    const padL = ccs ? px(ccs.paddingLeft, 0) : 0
    const padR = ccs ? px(ccs.paddingRight, 0) : 0

    for (const r of rectsOf(el)) {
      boxes.push({
        left: r.left - padL,
        right: r.right + padR,
        top: r.top,
        bottom: r.bottom,
        baseline: r.bottom - descent,
        offset,
        thickness,
      })
    }
  }
  return { boxes, targets }
}

/**
 * 按「同一行 + 水平相接」把片段折成连续线段。
 * 纯函数,几何可单测;不依赖 DOM / 字体。
 */
export function mergeInlineSegments(boxes: InlineBox[], gap = MERGE_GAP): UnderlineSegment[] {
  const valid = boxes
    .filter((b) => b.right - b.left > 0.5 && b.bottom - b.top > 0)
    .sort((a, b) => a.top - b.top || a.left - b.left)
  if (!valid.length) return []

  // 按 top 排序后,新盒子只可能与「当前行」重叠;同行不同字号的盒子靠垂直
  // 重叠判定,而不是比较 top 是否相等(它们共享 baseline,但 ascent 不同)。
  const lines: InlineBox[][] = []
  let current: InlineBox[] = []
  for (const b of valid) {
    const sameLine = current.some(
      (m) => Math.min(m.bottom, b.bottom) - Math.max(m.top, b.top) >= MIN_OVERLAP,
    )
    if (sameLine) current.push(b)
    else {
      if (current.length) lines.push(current)
      current = [b]
    }
  }
  if (current.length) lines.push(current)

  const segments: UnderlineSegment[] = []
  for (const line of lines) {
    const top = median(line.map((b) => b.baseline)) + median(line.map((b) => b.offset))
    const height = Math.max(1, median(line.map((b) => b.thickness)))
    const sorted = [...line].sort((a, b) => a.left - b.left)
    let left = sorted[0].left
    let right = sorted[0].right
    for (let i = 1; i < sorted.length; i++) {
      const b = sorted[i]
      if (b.left - right <= gap) {
        if (b.right > right) right = b.right
      } else {
        segments.push({ left, right, top, height })
        left = b.left
        right = b.right
      }
    }
    segments.push({ left, right, top, height })
  }
  return segments
}

export interface InlineUnderlines {
  refresh(): void
  destroy(): void
}

/**
 * 把下划线画进已有的 overlay layer。view 只用来读 view.dom,不写任何东西。
 */
export function createInlineUnderlines(
  layer: HTMLElement,
  container: HTMLElement,
  view: EditorView,
): InlineUnderlines {
  const lines: HTMLElement[] = []
  let disposed = false

  function refresh(): void {
    if (disposed) return
    const { boxes, targets } = collectInlineBoxes(view)
    const segments = mergeInlineSegments(boxes)
    const base = layer.getBoundingClientRect()

    while (lines.length < segments.length) {
      const el = document.createElement('div')
      el.className = 'velo-diff-inline-line'
      layer.appendChild(el)
      lines.push(el)
    }
    for (let i = 0; i < lines.length; i++) {
      const el = lines[i]
      const seg = segments[i]
      if (!seg) {
        if (el.style.display !== 'none') el.style.display = 'none'
        continue
      }
      const left = seg.left - base.left
      const top = seg.top - base.top
      const key = [
        Math.round(left * 100) / 100,
        Math.round(top * 100) / 100,
        Math.round((seg.right - seg.left) * 100) / 100,
        Math.round(seg.height * 100) / 100,
      ].join(',')
      if (el.dataset.box !== key) {
        el.style.display = ''
        el.style.left = `${left}px`
        el.style.top = `${top}px`
        el.style.width = `${seg.right - seg.left}px`
        el.style.height = `${seg.height}px`
        el.dataset.box = key
      }
    }
    // 有目标却一条线都画不出来(如 jsdom 无布局)时不解除 CSS 降级,
    // 否则会出现「既没有 overlay 线、underline 又被隐藏」的空标记。
    container.classList.toggle('velo-diff-inline-ready', targets === 0 || segments.length > 0)
  }

  return {
    refresh,
    destroy() {
      disposed = true
      for (const el of lines) el.remove()
      lines.length = 0
      container.classList.remove('velo-diff-inline-ready')
    },
  }
}
