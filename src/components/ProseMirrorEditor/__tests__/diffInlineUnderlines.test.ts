import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EditorView } from 'prosemirror-view'
import {
  collectInlineBoxes,
  createInlineUnderlines,
  mergeInlineSegments,
  type InlineBox,
} from '../plugins/diffInlineUnderlines'

const box = (
  left: number,
  right: number,
  top = 19,
  bottom = 40,
  rest: Partial<InlineBox> = {},
): InlineBox => ({ left, right, top, bottom, baseline: 36, offset: 3, thickness: 2, ...rest })

function domRect(left: number, right: number, top: number, bottom: number): DOMRect {
  return {
    left,
    right,
    top,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect
}

function stubRects(el: Element, rects: DOMRect[]) {
  vi.spyOn(el, 'getClientRects').mockReturnValue(rects as unknown as DOMRectList)
}

beforeEach(() => {
  // jsdom 没装 canvas:显式返回 null,避免 not-implemented 日志,也让度量走
  // 稳定的 0.25em 兜底(16px → descent 4)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('mergeInlineSegments(线段几何)', () => {
  it('正文 / code / 正文三个相接片段 → 一条线', () => {
    const segs = mergeInlineSegments([
      box(40, 92.39),
      box(92.39, 201.81), // code 胶囊已含左右 padding
      box(201.81, 377.81),
    ])
    expect(segs).toEqual([{ left: 40, right: 377.81, top: 39, height: 2 }])
  })

  it('中间夹着未变更文字 → 断成两条,不误连', () => {
    const segs = mergeInlineSegments([box(40, 90), box(190, 240)])
    expect(segs).toHaveLength(2)
    expect(segs[0]).toMatchObject({ left: 40, right: 90 })
    expect(segs[1]).toMatchObject({ left: 190, right: 240 })
  })

  it('换行 → 每行各一条,top 随各自 baseline', () => {
    const segs = mergeInlineSegments([
      box(40, 120, 19, 40, { baseline: 36 }),
      box(40, 100, 60, 81, { baseline: 77 }),
    ])
    expect(segs).toHaveLength(2)
    expect(segs[0].top).toBe(39)
    expect(segs[1].top).toBe(80)
  })

  it('同行不同字号的盒子靠垂直重叠归并,baseline 取中位数', () => {
    // 正文 16px(bottom 40)/ code 14.4px(bottom 40、top 更高)共享一行
    const segs = mergeInlineSegments([
      box(40, 92, 19, 40, { baseline: 36 }),
      box(92, 200, 23, 40, { baseline: 36.4 }),
      box(200, 300, 19, 40, { baseline: 36 }),
    ])
    expect(segs).toHaveLength(1)
    expect(segs[0].top).toBe(39)
  })

  it('重叠区间合并,零宽 / 零高盒子忽略', () => {
    const segs = mergeInlineSegments([
      box(10, 60),
      box(50, 100),
      box(100, 100),
      box(200, 200, 10, 10),
    ])
    expect(segs).toEqual([{ left: 10, right: 100, top: 39, height: 2 }])
  })

  it('空输入 → 无线段', () => {
    expect(mergeInlineSegments([])).toEqual([])
  })
})

// ── DOM 收集 ──

function fakeView(html: string): { view: EditorView; root: HTMLElement } {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return { view: { dom: root } as unknown as EditorView, root }
}

describe('collectInlineBoxes(DOM 几何)', () => {
  it('整个 code 都是新增 → 把胶囊左右 padding 算进线段', () => {
    const { view, root } = fakeView(
      '<p><span class="velo-diff-added-inline" style="font-size:16px">结果带 </span>' +
        '<code style="padding:2px 6px"><span class="velo-diff-added-inline" style="font-size:14.4px">count</span></code>' +
        '<span class="velo-diff-added-inline" style="font-size:16px">，见文末</span></p>',
    )
    const spans = root.querySelectorAll<HTMLElement>('.velo-diff-added-inline')
    stubRects(spans[0], [domRect(40, 92.39, 19, 40)])
    stubRects(spans[1], [domRect(98.39, 195.81, 23, 40)])
    stubRects(spans[2], [domRect(201.81, 377.81, 19, 40)])

    const { boxes, targets } = collectInlineBoxes(view)
    expect(targets).toBe(3)
    expect(boxes).toHaveLength(3)
    // code 内片段左右各外扩 6px,正好与相邻正文片段首尾相接
    expect(boxes[1].left).toBe(92.39)
    expect(boxes[1].right).toBe(201.81)
    const segs = mergeInlineSegments(boxes)
    expect(segs).toHaveLength(1)
    expect(segs[0].left).toBe(40)
    expect(segs[0].right).toBe(377.81)
  })

  it('code 内只有一半新增 → 不外扩,不把留存文字标成新增', () => {
    const { view, root } = fakeView(
      '<p><code style="padding:2px 6px">' +
        '<span class="velo-diff-added-inline" style="font-size:16px">new</span> old</code></p>',
    )
    const span = root.querySelector<HTMLElement>('.velo-diff-added-inline')!
    stubRects(span, [domRect(50, 80, 19, 40)])
    const { boxes } = collectInlineBoxes(view)
    expect(boxes).toHaveLength(1)
    expect(boxes[0].left).toBe(50)
    expect(boxes[0].right).toBe(80)
  })

  it('脚注上标与删除块内的片段不进 overlay', () => {
    const { view, root } = fakeView(
      '<p><span class="velo-diff-added-inline footnote-ref-node">1</span>' +
        '<span class="velo-diff-deleted-block"><span class="velo-diff-added-inline">old</span></span>' +
        '<span class="velo-diff-added-inline">new</span></p>',
    )
    const last = root.querySelector<HTMLElement>('p > .velo-diff-added-inline:last-child')!
    stubRects(last, [domRect(10, 40, 19, 40)])
    const { boxes, targets } = collectInlineBoxes(view)
    expect(targets).toBe(1)
    expect(boxes).toHaveLength(1)
  })

  it('跨行的片段按 fragment 产出多个 box', () => {
    const { view, root } = fakeView('<p><span class="velo-diff-added-inline">long</span></p>')
    const span = root.querySelector<HTMLElement>('.velo-diff-added-inline')!
    stubRects(span, [domRect(40, 300, 19, 40), domRect(40, 120, 60, 81)])
    const { boxes } = collectInlineBoxes(view)
    expect(boxes).toHaveLength(2)
    expect(mergeInlineSegments(boxes)).toHaveLength(2)
  })
})

// ── overlay 渲染 / 降级 ──

describe('createInlineUnderlines(overlay)', () => {
  it('画出一条贯通线并解除 CSS 降级;destroy 后全部清理', () => {
    const { view, root } = fakeView(
      '<p><span class="velo-diff-added-inline">A</span>' +
        '<code style="padding:0 6px"><span class="velo-diff-added-inline">B</span></code>' +
        '<span class="velo-diff-added-inline">C</span></p>',
    )
    const spans = root.querySelectorAll<HTMLElement>('.velo-diff-added-inline')
    stubRects(spans[0], [domRect(40, 60, 19, 40)])
    stubRects(spans[1], [domRect(66, 90, 23, 40)])
    stubRects(spans[2], [domRect(96, 130, 19, 40)])

    const container = document.createElement('div')
    const layer = document.createElement('div')
    container.appendChild(layer)
    document.body.appendChild(container)
    vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(domRect(0, 800, 0, 400))

    const underlines = createInlineUnderlines(layer, container, view)
    underlines.refresh()
    const lines = layer.querySelectorAll<HTMLElement>('.velo-diff-inline-line')
    expect(lines).toHaveLength(1)
    expect(parseFloat(lines[0].style.left)).toBe(40)
    expect(parseFloat(lines[0].style.width)).toBe(90) // 130 - 40
    expect(parseFloat(lines[0].style.top)).toBe(39) // baseline 36 + offset 3
    expect(parseFloat(lines[0].style.height)).toBe(2)
    expect(container.classList.contains('velo-diff-inline-ready')).toBe(true)

    underlines.destroy()
    expect(layer.querySelector('.velo-diff-inline-line')).toBeNull()
    expect(container.classList.contains('velo-diff-inline-ready')).toBe(false)
  })

  it('有目标但拿不到几何 → 不解除降级,保证还有 CSS 下划线', () => {
    const { view, root } = fakeView('<p><span class="velo-diff-added-inline">A</span></p>')
    // jsdom 默认 rect 全 0,不 stub → 没有可画的线段
    expect(root.querySelector('.velo-diff-added-inline')).not.toBeNull()
    const container = document.createElement('div')
    const layer = document.createElement('div')
    container.appendChild(layer)
    document.body.appendChild(container)
    const underlines = createInlineUnderlines(layer, container, view)
    underlines.refresh()
    expect(layer.querySelectorAll('.velo-diff-inline-line')).toHaveLength(0)
    expect(container.classList.contains('velo-diff-inline-ready')).toBe(false)
    underlines.destroy()
  })

  it('没有新增片段 → 解除降级(无需画线)', () => {
    const { view } = fakeView('<p>plain</p>')
    const container = document.createElement('div')
    const layer = document.createElement('div')
    container.appendChild(layer)
    const underlines = createInlineUnderlines(layer, container, view)
    underlines.refresh()
    expect(container.classList.contains('velo-diff-inline-ready')).toBe(true)
    underlines.destroy()
  })
})
