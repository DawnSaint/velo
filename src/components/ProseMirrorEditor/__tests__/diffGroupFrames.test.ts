import { describe, it, expect, vi, afterEach } from 'vitest'
import { Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { computeFrameBox, belongsToGroup, createDiffGroupFrames } from '../plugins/diffGroupFrames'
import type { DiffGroup } from '../plugins/diffDecoration'

// overlay 只读 plugin state 里的组信息。集成测试里直接注入组,免得为几个
// 几何断言重建整套 diff 计划。
const mockState = vi.hoisted(() => ({ groups: [] as DiffGroup[] }))
vi.mock('../plugins/diffDecoration', () => ({ getDiffGroups: () => mockState.groups }))

describe('computeFrameBox(整框几何)', () => {
  it('多个块的 rect 合并成一个包围盒', () => {
    const box = computeFrameBox(
      [
        { top: 100, bottom: 130 },
        { top: 140, bottom: 170 },
        { top: 180, bottom: 220 },
      ],
      40,
      600,
      0,
    )
    expect(box).toEqual({ top: 100, bottom: 220, left: 40, right: 600 })
  })

  it('左右坐标统一给定,与各 rect 自身的宽度无关', () => {
    // 模拟「段落 / 表格 / 警告框宽度不同」:函数签名里根本没有 left/right
    const box = computeFrameBox(
      [{ top: 10, bottom: 20 }, { top: 25, bottom: 60 }],
      -16,
      784,
      0,
    )
    expect(box!.left).toBe(-16)
    expect(box!.right).toBe(784)
    expect(box!.right - box!.left).toBe(800)
  })

  it('零高度节点(隐藏的 mermaid 源码 / 空 toc div)不参与上下边界', () => {
    const box = computeFrameBox(
      [
        { top: 50, bottom: 50 }, // display:none
        { top: 100, bottom: 120 },
        { top: 200, bottom: 200 }, // 空 div
        { top: 130, bottom: 160 },
      ],
      0,
      100,
      0,
    )
    expect(box!.top).toBe(100)
    expect(box!.bottom).toBe(160)
  })

  it('上下加呼吸空间', () => {
    const box = computeFrameBox([{ top: 100, bottom: 200 }], 0, 100)
    expect(box!.top).toBe(94)
    expect(box!.bottom).toBe(206)
  })

  it('没有有效 rect → null(不画空框)', () => {
    expect(computeFrameBox([], 0, 100)).toBeNull()
    expect(computeFrameBox([{ top: 10, bottom: 10 }], 0, 100)).toBeNull()
  })
})

describe('belongsToGroup(归组边界)', () => {
  // doc: <p>A</p>(0..3) <p>空</p>(3..5) <p>B</p>(5..8) <p>C</p>(8..11)
  // 组 = 单独新增的 B,posAtDOM 实测值见各用例
  const group: DiffGroup = { id: 'g1', kind: 'added', from: 5, to: 8, lastFrom: 5, entries: [0] }
  const at = (pos: number, cls = '') => {
    const el = document.createElement('p')
    if (cls) el.className = cls
    return { el, pos }
  }

  it('紧邻组前的空段落(from - 1)不得被误包进绿框', () => {
    // 回归:旧实现下界用 from - 1,空段 nodeSize === 2 时恰好落进来
    expect(belongsToGroup(at(4), group)).toBe(false)
  })

  it('组首块前的 widget(代码 header / 目录)按插入点 pos === from 纳入', () => {
    expect(belongsToGroup(at(5, 'ProseMirror-widget'), group)).toBe(true)
  })

  it('组首块(from + 1)与组末块之后的 widget(pos === to)纳入', () => {
    expect(belongsToGroup(at(6), group)).toBe(true)
    expect(belongsToGroup(at(8, 'ProseMirror-widget'), group)).toBe(true)
  })

  it('组后紧邻的未变更块(to + 1)排除', () => {
    expect(belongsToGroup(at(9), group)).toBe(false)
  })

  it('删除片段与 split/merge 边界 badge 排除', () => {
    expect(belongsToGroup(at(5, 'velo-diff-deleted-block ProseMirror-widget'), group)).toBe(false)
    expect(belongsToGroup(at(5, 'velo-diff-boundary-hint ProseMirror-widget'), group)).toBe(false)
  })
})

// ── 真实 EditorView 上的端到端几何 ──

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
})

function makeView(texts: string[]) {
  const doc = schema.node('doc', null, texts.map(t => schema.node('paragraph', null, [schema.text(t)])))
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({ schema, doc })
  const view = new EditorView(container, { state })
  return { container, view, doc }
}

function stubRect(el: Element, top: number, bottom: number, left = 0, right = 800) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    top, bottom, left, right, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}),
  } as DOMRect)
}

/** 按真实 doc 坐标造一个组(块的起止 pos 由 PM 自己给,不猜 nodeSize) */
function groupFromRange(view: EditorView, start: number, end: number, id: string): DiffGroup {
  const children = Array.from(view.dom.children)
  const from = view.posAtDOM(children[start], 0) - 1
  const lastFrom = view.posAtDOM(children[end], 0) - 1
  return { id, kind: 'added', from, to: lastFrom + view.state.doc.child(end).nodeSize, lastFrom, entries: [] }
}

afterEach(() => {
  vi.restoreAllMocks()
  mockState.groups = []
  document.body.innerHTML = ''
})

describe('createDiffGroupFrames(端到端)', () => {
  it('连续三段新增 → 只生成一个框,上下覆盖全部三块且左右统一', () => {
    const { container, view } = makeView(['旧段', '新一', '新二', '新三'])
    mockState.groups = [groupFromRange(view, 1, 3, 'g1')]

    stubRect(container, 0, 400, 0, 800)
    stubRect(view.dom, 0, 400, 0, 800)
    view.dom.style.paddingLeft = '64px'
    view.dom.style.paddingRight = '64px'
    // jsdom 的 getComputedStyle 会给未声明的 border-width 返回 16px,显式置零
    view.dom.style.borderLeftWidth = '0px'
    view.dom.style.borderRightWidth = '0px'
    // jsdom 默认 rect 全 0,逐块给出真实高度
    const children = Array.from(view.dom.children)
    children.forEach((el, i) => stubRect(el, 20 + i * 50, 60 + i * 50))

    const frames = createDiffGroupFrames(container, view)
    frames.refresh()
    const layer = container.querySelector('.velo-diff-frames')!
    const all = layer.querySelectorAll('.velo-diff-frame')
    expect(all.length).toBe(1)

    const frame = all[0] as HTMLElement
    // 组首块 top=70 / 组末块 bottom=210,上下各加 6px 呼吸空间
    expect(parseFloat(frame.style.top)).toBe(64)
    expect(parseFloat(frame.style.height)).toBe(152)
    // 统一 x:0 + 64 - 16 = 48,800 - 64 + 16 = 752
    expect(parseFloat(frame.style.left)).toBe(48)
    expect(parseFloat(frame.style.width)).toBe(704)

    frames.destroy()
    view.destroy()
  })

  it('两个不相邻的组 → 两个框;换 doc 后旧框被清理', () => {
    const { container, view } = makeView(['A', 'B', 'C'])
    stubRect(container, 0, 400, 0, 800)
    stubRect(view.dom, 0, 400, 0, 800)
    Array.from(view.dom.children).forEach((el, i) => stubRect(el, 10 + i * 40, 40 + i * 40))

    const frames = createDiffGroupFrames(container, view)
    mockState.groups = [
      groupFromRange(view, 0, 0, 'g1'),
      groupFromRange(view, 2, 2, 'g2'),
    ]
    frames.refresh()
    const layer = container.querySelector('.velo-diff-frames')!
    expect(layer.querySelectorAll('.velo-diff-frame').length).toBe(2)

    mockState.groups = [mockState.groups[0]]
    frames.refresh()
    expect(layer.querySelectorAll('.velo-diff-frame').length).toBe(1)
    expect(layer.querySelector('[data-diff-group="g2"]')).toBeNull()

    frames.destroy()
    expect(container.querySelector('.velo-diff-frames')).toBeNull()
    view.destroy()
  })

  it('同一 layer 也画字符级新增下划线,并解除其 CSS 降级', () => {
    const { container, view } = makeView(['A'])
    stubRect(container, 0, 400, 0, 800)
    stubRect(view.dom, 0, 400, 0, 800)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const p = view.dom.querySelector('p')!
    p.innerHTML = '<span class="velo-diff-added-inline" style="font-size:16px">new</span>'
    const span = p.querySelector('.velo-diff-added-inline')!
    const r = {
      top: 19,
      bottom: 40,
      left: 40,
      right: 120,
      x: 40,
      y: 19,
      width: 80,
      height: 21,
      toJSON: () => ({}),
    } as DOMRect
    vi.spyOn(span, 'getClientRects').mockReturnValue([r] as unknown as DOMRectList)

    const frames = createDiffGroupFrames(container, view)
    frames.refresh()
    const layer = container.querySelector('.velo-diff-frames')!
    expect(layer.querySelectorAll('.velo-diff-inline-line')).toHaveLength(1)
    expect(container.classList.contains('velo-diff-inline-ready')).toBe(true)

    frames.destroy()
    expect(container.classList.contains('velo-diff-inline-ready')).toBe(false)
    view.destroy()
  })

  it('destroy 之后异步回调不再把框加回来', () => {
    const { container, view } = makeView(['A'])
    stubRect(container, 0, 400, 0, 800)
    stubRect(view.dom, 0, 400, 0, 800)
    stubRect(view.dom.children[0], 10, 40)
    mockState.groups = [groupFromRange(view, 0, 0, 'g1')]
    const frames = createDiffGroupFrames(container, view)
    frames.destroy()
    frames.schedule()
    frames.refresh()
    expect(container.querySelector('.velo-diff-frame')).toBeNull()
    view.destroy()
  })
})
