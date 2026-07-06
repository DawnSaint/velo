// 查找替换后端 (PM / CM6) round-trip 测试。
//
// 关注点:同一份 FindReplaceBackend 接口,两个实现(PM prose 文本 / CM6 raw markdown)
// 行为对仗 —— findMatches / setHighlight / selectMatch 落点 / replaceCurrent /
// replaceAll / getSelectionText 都按各自编辑器坐标正确工作。CM6 高亮 StateField
// 装进 state 才能收 effect,故 makeCmView 带 cmFindHighlightField。

import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { EditorView as CmView } from '@codemirror/view'
import { EditorState as CmState, EditorSelection as CmSel } from '@codemirror/state'
import { EditorView as PmView } from 'prosemirror-view'
import { EditorState as PmState, TextSelection, type Plugin } from 'prosemirror-state'
import { schema } from '../../editor/schema'
import { fromMarkdown } from '../../editor/markdownIO'
import { createPmBackend, createCmBackend } from '../backend'
import { cmFindHighlightField } from '../cmFindHighlight'
import { findHighlight, findHighlightKey } from '../findHighlight'
import { mermaidDecoration, mermaidDecoKey } from '../../nodes/MermaidDecoration'

const opt = (overrides: Partial<{ caseSensitive: boolean, wholeWord: boolean, regex: boolean }> = {}) => ({
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ...overrides,
})

function makePmView(md: string, plugins: Plugin[] = [findHighlight]): PmView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  // 装上 findHighlight 插件,否则 findHighlightKey.getState 拿不到、setHighlight 无接收方
  const state = PmState.create({ schema, doc: fromMarkdown(md, schema), plugins })
  return new PmView(container, { state })
}

function makeCmView(md: string): CmView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = CmState.create({ doc: md, extensions: [cmFindHighlightField] })
  return new CmView({ state, parent: container })
}

/** PM doc 里某子串首次出现的文本起始 pos。 */
function pmPosOf(doc: PmView['state']['doc'], needle: string): number {
  let found = -1
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text && node.text.includes(needle)) {
      found = pos + node.text.indexOf(needle)
      return false
    }
    return true
  })
  return found
}

function mermaidSourceState(view: PmView): string | undefined {
  const pre = view.dom.querySelector('pre[data-mermaid-source]') as HTMLElement | null
  return pre?.dataset.mermaidSource
}

// jsdom 不实现 getClientRects / getBoundingClientRect,PM scrollMatchIntoView 的
// coordsAtPos 路径会走到。补零矩形 stub(production 浏览器原生实现,不受影响)。
beforeAll(() => {
  const zeroRect = (): DOMRect => ({
    left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON() {},
  }) as unknown as DOMRect
  const zeroRects = (): DOMRectList => [zeroRect()] as unknown as DOMRectList
  for (const proto of [Element.prototype, Range.prototype]) {
    if (!proto.getClientRects) proto.getClientRects = zeroRects
    if (!proto.getBoundingClientRect) proto.getBoundingClientRect = zeroRect
  }
})

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ============================================================
//  PM 后端
// ============================================================

const PM_MD = '# Title\n\nHello world hello.\n\n- foo\n'

describe('PM 后端', () => {
  it('findMatches:多 hit 位置正确(prose 坐标)', () => {
    const view = makePmView(PM_MD)
    const be = createPmBackend(view)
    const matches = be.findMatches('hello', opt())
    expect(matches).toHaveLength(2)
    // 两 hit 都在含 hello 的段落里
    for (const m of matches) {
      const $p = view.state.doc.resolve(m.from)
      expect($p.parent.textContent).toContain('hello')
    }
    view.destroy()
  })

  it('setSelection + getSelectionText 往返', () => {
    const view = makePmView(PM_MD)
    const be = createPmBackend(view)
    const wStart = pmPosOf(view.state.doc, 'world')
    be.setSelection(wStart, wStart + 'world'.length)
    expect(be.getSelectionText()).toBe('world')
    view.destroy()
  })

  it('空选区 → getSelectionText 返回空串', () => {
    const view = makePmView(PM_MD)
    const be = createPmBackend(view)
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pmPosOf(view.state.doc, 'world')))))
    expect(be.getSelectionText()).toBe('')
    view.destroy()
  })

  it('replaceRange:替换后文本落回 + 返回新光标', () => {
    const view = makePmView(PM_MD)
    const be = createPmBackend(view)
    const wStart = pmPosOf(view.state.doc, 'world')
    const cursor = be.replaceRange(wStart, wStart + 'world'.length, 'earth')
    expect(cursor).toBe(wStart + 'earth'.length)
    expect(pmPosOf(view.state.doc, 'earth')).toBeGreaterThanOrEqual(0)
    expect(pmPosOf(view.state.doc, 'world')).toBe(-1)
    view.destroy()
  })

  // replacement 为空 = "删 match"。早期实现走 schema.text('') 直接抛
  // RangeError('Empty text nodes are not allowed'),PM 不允许构造空 text 节点;
  // 修法是 replaceRange 对空 newText 改走 tr.delete。覆盖三种调用形态:
  //   ① 单条空 replacement(replaceCurrent 的最常见形态)
  //   ② 多次连续空 replacement(模拟 replaceAll 在大段文本上的循环)
  //   ③ 跨 mark 边界的空 replacement(text 节点边界与 match 范围不完全重合
  //      时仍要正确删除 —— schema.text 的边界对齐问题被 delete 绕开)
  it('replaceRange:replacement 为空时正确删除 match(不抛 schema.text 空串错)', () => {
    const view = makePmView('Hello world hello.')
    const be = createPmBackend(view)
    // caseSensitive=true → 只命中小写 'hello',避开 'Hello' 也算命中的歧义,
    // 让断言能精准判断"只删了被替换的那条"。
    const matches = be.findMatches('hello', opt({ caseSensitive: true }))
    expect(matches).toHaveLength(1)
    // ① 单条空替换
    const cursor = be.replaceRange(matches[0].from, matches[0].to, '')
    expect(cursor).toBe(matches[0].from)
    expect(view.state.doc.textContent).toBe('Hello world .')
    // ② 剩余无 match
    expect(be.findMatches('hello', opt({ caseSensitive: true }))).toHaveLength(0)
    view.destroy()
  })

  // 替换范围跨越 PM 文本节点边界(同一段 prose 被 marks 切成多个 text node):
  // 用户在加粗的"world"里搜 world → match 范围是 doc 坐标,replaceWith 单节点会
  // 失败或丢 mark;空 replacement 走 tr.delete 同样要正确处理跨节点。
  it('replaceRange:replacement 为空时跨文本节点边界删除', () => {
    const view = makePmView('**Hello** *world* here')
    const be = createPmBackend(view)
    const matches = be.findMatches('world', opt())
    expect(matches).toHaveLength(1)
    // 不应抛
    be.replaceRange(matches[0].from, matches[0].to, '')
    expect(view.state.doc.textContent).not.toContain('world')
    view.destroy()
  })

  it('setSelection:命中隐藏 mermaid 源码时先展开且不抢查找框焦点', async () => {
    const view = makePmView('intro\n\n```mermaid\ngraph TD\n  A-->B\n```', [mermaidDecoration, findHighlight])
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    const be = createPmBackend(view)
    const [match] = be.findMatches('A-->B', opt())

    expect(mermaidSourceState(view)).toBe('hidden')
    be.setSelection(match.from, match.to)
    await Promise.resolve()

    expect(mermaidSourceState(view)).toBe('visible')
    expect(be.getSelectionText()).toBe('A-->B')
    expect(mermaidDecoKey.getState(view.state)?.pendingFocusSet.size).toBe(0)
    expect(document.activeElement).toBe(input)

    input.remove()
    view.destroy()
  })

  it('scrollMatchIntoView:刚展开 mermaid 时延后一帧再取坐标', () => {
    const view = makePmView('intro\n\n```mermaid\ngraph TD\n  A-->B\n```', [mermaidDecoration, findHighlight])
    const be = createPmBackend(view)
    const [match] = be.findMatches('A-->B', opt())
    const calls: string[] = []
    const originalCoordsAtPos = view.coordsAtPos.bind(view)
    view.coordsAtPos = ((pos: number) => {
      calls.push(mermaidSourceState(view) ?? 'missing')
      return originalCoordsAtPos(pos)
    }) as typeof view.coordsAtPos

    expect(mermaidSourceState(view)).toBe('hidden')
    be.scrollMatchIntoView(match.from)

    expect(calls).toEqual([])
    vi.advanceTimersByTime(16)

    expect(calls).toEqual(['visible'])
    expect(mermaidSourceState(view)).toBe('visible')

    view.destroy()
  })

  // 覆盖 revealWorkspaceSearchMatch / FindReplace.selectMatch 的真实调用顺序:
  // setSelection 先展开 mermaid(helper 是幂等的,第二次调必返 false),
  // 所以 scrollMatchIntoView 不能靠"再调一次 helper 当信号" ——
  // 必须读 setSelection 留下的标记才能 rAF,否则跨文件搜索冷启动会 scroll 偏。
  it('scrollMatchIntoView:setSelection 刚展开 mermaid 后也要 rAF(helper 幂等,标记走 WeakMap)', () => {
    const view = makePmView('intro\n\n```mermaid\ngraph TD\n  A-->B\n```', [mermaidDecoration, findHighlight])
    const be = createPmBackend(view)
    const [match] = be.findMatches('A-->B', opt())
    const calls: string[] = []
    const originalCoordsAtPos = view.coordsAtPos.bind(view)
    view.coordsAtPos = ((pos: number) => {
      calls.push(mermaidSourceState(view) ?? 'missing')
      return originalCoordsAtPos(pos)
    }) as typeof view.coordsAtPos

    expect(mermaidSourceState(view)).toBe('hidden')

    // 真实流程:setSelection 先展开(此处已变成 visible),再 scrollMatchIntoView
    be.setSelection(match.from, match.to)
    expect(mermaidSourceState(view)).toBe('visible')

    be.scrollMatchIntoView(match.from)

    // 关键断言:即便 mermaid 已被 setSelection 展开(再调 helper 也是 false),
    // 也要走 rAF,不能立刻 coordsAtPos
    expect(calls).toEqual([])
    vi.advanceTimersByTime(16)

    expect(calls).toEqual(['visible'])

    view.destroy()
  })

  it('scrollMatchIntoView:setSelection 没动 mermaid 时立即滚(不走 rAF)', () => {
    const view = makePmView('# Title\n\nHello world.\n', [mermaidDecoration, findHighlight])
    const be = createPmBackend(view)
    const wStart = pmPosOf(view.state.doc, 'world')
    const calls: string[] = []
    const originalCoordsAtPos = view.coordsAtPos.bind(view)
    view.coordsAtPos = ((pos: number) => {
      calls.push(String(pos))
      return originalCoordsAtPos(pos)
    }) as typeof view.coordsAtPos

    be.setSelection(wStart, wStart + 'world'.length)
    // 非 mermaid:scrollMatchIntoView 不该 rAF,本帧就 coordsAtPos
    be.scrollMatchIntoView(wStart)
    expect(calls.length).toBe(1)

    view.destroy()
  })

  it('setHighlight:推到 findHighlight 插件 state', () => {
    const view = makePmView(PM_MD)
    const be = createPmBackend(view)
    const matches = be.findMatches('hello', opt())
    be.setHighlight(matches, 0)
    const hl = findHighlightKey.getState(view.state)
    expect(hl?.matches.length).toBe(2)
    expect(hl?.currentIndex).toBe(0)
    be.clearHighlight()
    const hl2 = findHighlightKey.getState(view.state)
    expect(hl2?.matches.length).toBe(0)
    view.destroy()
  })

})

// ============================================================
//  CM6 后端
// ============================================================

const CM_MD = '# Title\n\nHello world hello.\n\n- foo\n'

describe('CM6 后端', () => {
  it('findMatches:多 hit 位置正确(raw md offset)', () => {
    const view = makeCmView(CM_MD)
    const be = createCmBackend(view)
    const matches = be.findMatches('hello', opt())
    expect(matches).toHaveLength(2)
    // offset == CM6 pos,直接校验落在 'hello' 出现处(大小写不敏感,Hello 也命中)
    for (const m of matches) {
      expect(view.state.doc.sliceString(m.from, m.to).toLowerCase()).toBe('hello')
    }
    view.destroy()
  })

  it('findMatches:raw markdown 标记也命中(PM 侧不会)', () => {
    const view = makeCmView('**bold** here')
    const be = createCmBackend(view)
    const matches = be.findMatches('**', opt())
    expect(matches.length).toBeGreaterThan(0)
    view.destroy()
  })

  it('setSelection + getSelectionText 往返', () => {
    const view = makeCmView(CM_MD)
    const be = createCmBackend(view)
    const mdWorld = CM_MD.indexOf('world')
    be.setSelection(mdWorld, mdWorld + 'world'.length)
    expect(be.getSelectionText()).toBe('world')
    view.destroy()
  })

  it('空选区 → getSelectionText 返回空串', () => {
    const view = makeCmView(CM_MD)
    const be = createCmBackend(view)
    view.dispatch({ selection: CmSel.cursor(CM_MD.indexOf('world')) })
    expect(be.getSelectionText()).toBe('')
    view.destroy()
  })

  it('replaceRange:替换后文本落回 + 返回新光标', () => {
    const view = makeCmView(CM_MD)
    const be = createCmBackend(view)
    const mdWorld = CM_MD.indexOf('world')
    const cursor = be.replaceRange(mdWorld, mdWorld + 'world'.length, 'earth')
    expect(cursor).toBe(mdWorld + 'earth'.length)
    expect(view.state.doc.toString()).toContain('earth')
    expect(view.state.doc.toString()).not.toContain('world')
    view.destroy()
  })

  // CM6 路径本身对空 insert 不限制(对照 PM 的 schema.text 抛错):
  // 锁定"未来若把 PM 改回同一写法,空 replacement 在 CM6 上仍然能跑通",
  // 避免两边契约分叉。
  it('replaceRange:replacement 为空时正确删除 match(CM6 不限空 insert)', () => {
    const view = makeCmView('Hello world hello.')
    const be = createCmBackend(view)
    const matches = be.findMatches('hello', opt({ caseSensitive: true }))
    expect(matches).toHaveLength(1)
    const cursor = be.replaceRange(matches[0].from, matches[0].to, '')
    expect(cursor).toBe(matches[0].from)
    expect(view.state.doc.toString()).toBe('Hello world .')
    view.destroy()
  })

  it('setHighlight:经 effect 更新 cmFindHighlightField', () => {
    const view = makeCmView(CM_MD)
    const be = createCmBackend(view)
    const matches = be.findMatches('hello', opt())
    be.setHighlight(matches, 1)
    const field = view.state.field(cmFindHighlightField)
    // DecorationSet 内部不暴露条目数 API,用 size
    expect(field.size).toBe(2)
    be.clearHighlight()
    expect(view.state.field(cmFindHighlightField).size).toBe(0)
    view.destroy()
  })
})
