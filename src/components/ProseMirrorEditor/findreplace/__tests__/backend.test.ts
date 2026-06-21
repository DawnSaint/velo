// 查找替换后端 (PM / CM6) round-trip 测试。
//
// 关注点:同一份 FindReplaceBackend 接口,两个实现(PM prose 文本 / CM6 raw markdown)
// 行为对仗 —— findMatches / setHighlight / selectMatch 落点 / replaceCurrent /
// replaceAll / getSelectionText 都按各自编辑器坐标正确工作。CM6 高亮 StateField
// 装进 state 才能收 effect,故 makeCmView 带 cmFindHighlightField。

import { describe, expect, it, beforeAll } from 'vitest'
import { EditorView as CmView } from '@codemirror/view'
import { EditorState as CmState, EditorSelection as CmSel } from '@codemirror/state'
import { EditorView as PmView } from 'prosemirror-view'
import { EditorState as PmState, TextSelection } from 'prosemirror-state'
import { schema } from '../../editor/schema'
import { fromMarkdown } from '../../editor/markdownIO'
import { createPmBackend, createCmBackend } from '../backend'
import { cmFindHighlightField } from '../cmFindHighlight'
import { findHighlight, findHighlightKey } from '../findHighlight'

const opt = (overrides: Partial<{ caseSensitive: boolean, wholeWord: boolean, regex: boolean }> = {}) => ({
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ...overrides,
})

function makePmView(md: string): PmView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  // 装上 findHighlight 插件,否则 findHighlightKey.getState 拿不到、setHighlight 无接收方
  const state = PmState.create({ schema, doc: fromMarkdown(md, schema), plugins: [findHighlight] })
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

function setPmCursor(view: PmView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))))
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
    setPmCursor(view, pmPosOf(view.state.doc, 'world'))
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
