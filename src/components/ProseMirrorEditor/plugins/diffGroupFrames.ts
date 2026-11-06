// Diff 整框 overlay(#diff-wysiwyg)
//
// 一组连续新增的块只画**一个**框。框是一个绝对定位的空 div,由本模块按
// diff 计划里的 DiffGroup 计算位置后插入到 `.velo-diff-editor`(EditorView
// 的挂载点)里 —— 不碰 `view.dom` 内部,避免破坏 ProseMirror 的 DOM 映射。
//
// 为什么不再用 CSS 的 border 拼接:
// - CSS 没有「给一组兄弟套共同边框」的原语,只能逐块画左右边 + 首尾补横边,
//   要求所有相邻块同父级、紧邻、同一左右边界、零间隙;而代码 header / mermaid
//   SVG / 目录 / 删除片段都是插进兄弟链的 widget,必然出现断口与独立小框;
// - 各载体的盒模型不同,outline / 伪元素 / border 各用一套外扩量,框宽天然不齐;
// - 视口增量构建下,视口外的块暂时没有 decoration,`:has(+ …)` 猜出的组首
//   会随滚动漂移。
//
// 本模块的框:
// - 左右坐标**只取一次**(版心 ± FRAME_X),与块类型、缩进、NodeView 无关;
// - 上下取组内所有顶层 DOM 节点 rect 的并集 —— 含 widget,所以代码 header、
//   mermaid SVG、目录都自然被包住,不需要按节点类型写特例;
// - 组来自 diff 计划(getDiffGroups),全量稳定,不受滚动/增量构建影响;
// - 只读视图,pointer-events:none,不参与选区与编辑。

import type { EditorView } from 'prosemirror-view'
import { getDiffGroups, type DiffGroup } from './diffDecoration'

/** 框线离版心(content box)两侧的距离,所有组共用 */
const FRAME_X = 16
/** 框上下的呼吸空间 */
const FRAME_PAD_Y = 6

export interface DiffGroupFrames {
  /** 立即按当前 DOM / state 重算所有框 */
  refresh(): void
  /** 合并到下一帧重算(供 observer 调用) */
  schedule(): void
  destroy(): void
}

export interface FrameBox {
  top: number
  bottom: number
  left: number
  right: number
}

/**
 * 把一组 rect 折成一个框。刻意**忽略单个 rect 的 left / right**:
 * 左右一律用统一坐标,这是「所有框线宽度一致」的保证。
 * 零高度元素(隐藏的 mermaid 源码 pre、空的 toc div)不参与上下边界。
 */
export function computeFrameBox(
  rects: ReadonlyArray<{ top: number; bottom: number }>,
  left: number,
  right: number,
  padY = FRAME_PAD_Y,
): FrameBox | null {
  let top = Infinity
  let bottom = -Infinity
  for (const r of rects) {
    if (!(r.bottom > r.top)) continue
    if (r.top < top) top = r.top
    if (r.bottom > bottom) bottom = r.bottom
  }
  if (top === Infinity) return null
  return { top: top - padY, bottom: bottom + padY, left, right }
}

export interface ChildInfo {
  el: Element
  pos: number
  rect: DOMRect
}

/** 视觉上属于「新增内容」的 widget(PM 自动加 .ProseMirror-widget) */
function isFrameWidget(el: Element): boolean {
  return el.classList.contains('ProseMirror-widget')
    && !el.classList.contains('velo-diff-deleted-block')
    && !el.classList.contains('velo-diff-boundary-hint')
}

/** 顶层 DOM 节点 → doc pos。posAtDOM 对个别 NodeView 会抛,沿用上一个成功的 pos */
function collectChildren(view: EditorView): ChildInfo[] {
  const out: ChildInfo[] = []
  let lastPos = -1
  for (const el of Array.from(view.dom.children)) {
    let pos = lastPos
    try {
      pos = view.posAtDOM(el, 0)
      lastPos = pos
    }
    catch { /* 保持上一个 pos,让该节点跟随前一节点归组 */ }
    out.push({ el, pos, rect: el.getBoundingClientRect() })
  }
  return out
}

/**
 * 该顶层节点是否属于这个组。
 *
 * 组的 from/to 是 doc 位置区间。真实 EditorView 上实测的 posAtDOM(el, 0):
 *   - 顶层块 → blockPos + 1(内容起始位置)
 *   - widget  → 插入点的 pos(不占 doc pos)
 * 因此 widget 天然落在区间内,这一条同时覆盖:
 *   - 代码 header widget(插在 pre 之前,pos === from)、目录 widget
 *   - mermaid SVG widget(插在隐藏 pre 之后,pos === 块尾)
 * 下界必须严格取 group.from,不能用 from - 1:紧邻组前的**空段落**
 * (nodeSize === 2)posAtDOM 恰好是 from - 1,放宽一格就会把它误包进绿框。
 * 上界取 group.to:组后紧邻的未变更块是 to + 1,自然排除;而插在组末块
 * 之后的 widget 是 to,仍会被包住。
 */
export function belongsToGroup(info: Pick<ChildInfo, 'el' | 'pos'>, group: DiffGroup): boolean {
  if (info.pos < group.from || info.pos > group.to) return false
  // 删除片段是「旧内容」、边界 badge 属于 split/merge,都不该进新增绿框
  if (info.el.classList.contains('velo-diff-deleted-block')) return false
  if (info.el.classList.contains('velo-diff-boundary-hint')) return false
  return true
}

function topLevelChild(dom: HTMLElement, node: Node | null): Element | null {
  let cur: Node | null = node
  while (cur && cur.parentNode && cur.parentNode !== dom) cur = cur.parentNode
  return cur && cur.parentNode === dom && cur instanceof Element ? cur : null
}

/**
 * posAtDOM 整体失效时的兜底:用 group 首末块的 nodeDOM 找到顶层 child,
 * 取这段连续区间(同样自动包含中间的 widget)。
 */
function fallbackChildren(view: EditorView, group: DiffGroup): Element[] {
  const dom = view.dom
  const children = Array.from(dom.children)
  let first: Element | null = null
  let last: Element | null = null
  try {
    first = topLevelChild(dom, view.nodeDOM(group.from))
    last = topLevelChild(dom, view.nodeDOM(group.lastFrom))
  }
  catch { /* 落到下面的空结果 */ }
  let i = first ? children.indexOf(first) : -1
  let j = last ? children.indexOf(last) : -1
  if (i < 0 || j < i) return []
  // 端点外侧紧贴的 widget(代码 header / mermaid SVG)不占 doc pos,
  // nodeDOM 定位不到它们,按兄弟关系向两侧扩展进来。
  while (i > 0 && isFrameWidget(children[i - 1])) i--
  while (j + 1 < children.length && isFrameWidget(children[j + 1])) j++
  return children.slice(i, j + 1).filter(el => !el.classList.contains('velo-diff-deleted-block')
    && !el.classList.contains('velo-diff-boundary-hint'))
}

export function createDiffGroupFrames(
  container: HTMLElement,
  view: EditorView,
): DiffGroupFrames {
  const layer = document.createElement('div')
  layer.className = 'velo-diff-frames'
  // 挂在 container 上而不是 view.dom 内:PM 只管理 view.dom 的 children
  container.appendChild(layer)

  const frames = new Map<string, HTMLElement>()
  let raf = 0
  let disposed = false

  function refresh(): void {
    if (disposed) return
    const groups = getDiffGroups(view.state).filter(g => g.kind === 'added')
    const children = collectChildren(view)

    const pmRect = view.dom.getBoundingClientRect()
    const cs = getComputedStyle(view.dom)
    const padL = parseFloat(cs.paddingLeft) || 0
    const padR = parseFloat(cs.paddingRight) || 0
    const borderL = parseFloat(cs.borderLeftWidth) || 0
    const borderR = parseFloat(cs.borderRightWidth) || 0
    const left = pmRect.left + borderL + padL - FRAME_X
    const right = pmRect.right - borderR - padR + FRAME_X

    const base = container.getBoundingClientRect()
    const baseLeft = base.left + container.clientLeft
    const baseTop = base.top + container.clientTop

    const seen = new Set<string>()
    for (const group of groups) {
      let members = children.filter(c => belongsToGroup(c, group))
      if (members.length === 0) {
        members = fallbackChildren(view, group).map(el => ({
          el,
          pos: group.from,
          rect: el.getBoundingClientRect(),
        }))
      }
      const box = computeFrameBox(members.map(m => m.rect), left, right)
      if (!box) continue

      let frame = frames.get(group.id)
      if (!frame) {
        frame = document.createElement('div')
        frame.className = 'velo-diff-frame'
        frame.setAttribute('data-diff-group', group.id)
        layer.appendChild(frame)
        frames.set(group.id, frame)
      }
      const key = [
        Math.round((box.top - baseTop) * 100) / 100,
        Math.round((box.left - baseLeft) * 100) / 100,
        Math.round((box.right - box.left) * 100) / 100,
        Math.round((box.bottom - box.top) * 100) / 100,
      ].join(',')
      if (frame.dataset.box !== key) {
        frame.style.top = `${box.top - baseTop}px`
        frame.style.left = `${box.left - baseLeft}px`
        frame.style.width = `${box.right - box.left}px`
        frame.style.height = `${box.bottom - box.top}px`
        frame.dataset.box = key
      }
      seen.add(group.id)
    }

    for (const [id, el] of frames) {
      if (!seen.has(id)) {
        el.remove()
        frames.delete(id)
      }
    }
    // 有组却一个框都没画出来时不解除降级,避免「新增内容完全没有标记」
    const ready = groups.length === 0 || seen.size > 0
    container.classList.toggle('velo-diff-frames-ready', ready)
  }

  function schedule(): void {
    if (disposed || raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      refresh()
    })
  }

  const mo = new MutationObserver(schedule)
  mo.observe(view.dom, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  })
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
  ro?.observe(view.dom)
  window.addEventListener('resize', schedule)
  // 图片 / 内嵌资源的异步尺寸变化,load 不冒泡,需要捕获
  container.addEventListener('load', schedule, true)
  // jsdom / 旧 WebView 可能没有 fonts.ready,取到再挂
  const fontsReady = document.fonts?.ready
  if (fontsReady) void fontsReady.then(schedule).catch(() => { /* 字体加载失败不影响框 */ })

  return {
    refresh,
    schedule,
    destroy() {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      mo.disconnect()
      ro?.disconnect()
      window.removeEventListener('resize', schedule)
      container.removeEventListener('load', schedule, true)
      layer.remove()
      container.classList.remove('velo-diff-frames-ready')
      frames.clear()
    },
  }
}
