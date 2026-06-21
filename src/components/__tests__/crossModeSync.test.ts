// 跨模式光标/浏览状态同步 —— 文本锚点 capture/apply 单元 + 往返测试。
//
// 关注点:同一 markdown 在 PM(prose)与 CM6(raw md)两边文本表示不同,经
// 归一化后锚点窗口应能跨边界匹配,光标落到对应位置。最佳努力:失败返回
// null/false,不抛。

import { describe, expect, it, beforeAll } from 'vitest'
import { EditorView as CmView } from '@codemirror/view'
import { EditorState as CmState, EditorSelection as CmSel } from '@codemirror/state'
import { EditorView as PmView } from 'prosemirror-view'
import { EditorState as PmState, TextSelection } from 'prosemirror-state'
import { schema } from '../ProseMirrorEditor/editor/schema'
import { fromMarkdown } from '../ProseMirrorEditor/editor/markdownIO'
import { normalizeAnchor, captureAnchor, applyAnchor } from '../crossModeSync'

// ============================================================
//  工具:起 PM view / CM6 view
// ============================================================

function makePmView(md: string): PmView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = PmState.create({ schema, doc: fromMarkdown(md, schema) })
  return new PmView(container, { state })
}

function makeCmView(md: string): CmView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = CmState.create({ doc: md })
  return new CmView({ state, parent: container })
}

/** 在 PM doc 里找某子串首次出现的文本起始 pos。 */
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

/** 把 PM 光标设到 pos(用 TextSelection.near 兜底块边界)。 */
function setPmCursor(view: PmView, pos: number): void {
  const sel = TextSelection.near(view.state.doc.resolve(pos))
  view.dispatch(view.state.tr.setSelection(sel))
}

/** 把 CM6 光标设到 pos。 */
function setCmCursor(view: CmView, pos: number): void {
  view.dispatch({ selection: CmSel.cursor(pos) })
}

// jsdom 不实现 getClientRects / getBoundingClientRect(on Range),PM tr.scrollIntoView()
// 与 CM6 scrollIntoView effect 都会走到。补零矩形 stub(production 浏览器原生实现,
// 不受影响)。
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
//  normalizeAnchor
// ============================================================

describe('normalizeAnchor', () => {
  it('剥 markdown 标记字符、保留正文', () => {
    const n = normalizeAnchor('# Hello **world**')
    expect(n).toContain('Hello')
    expect(n).toContain('world')
    expect(n).not.toContain('#')
    expect(n).not.toContain('*')
  })

  it('强调标记 * / _ / __ 归一化一致', () => {
    expect(normalizeAnchor('*a*')).toBe(normalizeAnchor('_a_'))
    expect(normalizeAnchor('**b**')).toBe(normalizeAnchor('__b__'))
    expect(normalizeAnchor('**b**')).toContain('b')
  })

  it('列表 / 引用标记被剥(`.` 不是标记,保留)', () => {
    expect(normalizeAnchor('- item')).not.toContain('-')
    expect(normalizeAnchor('> quote')).not.toContain('>')
    expect(normalizeAnchor('1. first')).toContain('first')
    expect(normalizeAnchor('1. first')).toContain('.')
  })

  it('纯标记 / 极短 → 长度 < 4', () => {
    expect(normalizeAnchor('***').length).toBeLessThan(4)
    expect(normalizeAnchor('').length).toBeLessThan(4)
    expect(normalizeAnchor('ab').length).toBeLessThan(4)
  })
})

// ============================================================
//  往返:PM → CM6 / CM6 → PM
// ============================================================

const MD = '# Title\n\nHello **world** here.\n\n- item one\n'

describe('跨模式锚点往返', () => {
  it('PM → CM6:光标在 world → CM6 落到 world 区域', () => {
    const pm = makePmView(MD)
    const worldPos = pmPosOf(pm.state.doc, 'world')
    expect(worldPos).toBeGreaterThanOrEqual(0)
    setPmCursor(pm, worldPos + 2) // world 中间

    const anchor = captureAnchor(pm, 'pm')
    expect(anchor).not.toBeNull()
    const a = anchor!

    const cm = makeCmView(MD)
    const ok = applyAnchor(cm, 'cm', a)
    expect(ok).toBe(true)

    const head = cm.state.selection.main.head
    // CM6 doc == 原始 MD 串,world 出现在 MD.indexOf('world')
    const mdWorld = MD.indexOf('world')
    expect(head).toBeGreaterThanOrEqual(mdWorld)
    expect(head).toBeLessThanOrEqual(mdWorld + 'world'.length)

    pm.destroy()
    cm.destroy()
  })

  it('CM6 → PM:光标在 world → PM 落到含 world 的段落', () => {
    const cm = makeCmView(MD)
    const mdWorld = MD.indexOf('world')
    setCmCursor(cm, mdWorld + 2) // world 中间

    const anchor = captureAnchor(cm, 'cm')
    expect(anchor).not.toBeNull()
    const a = anchor!

    const pm = makePmView(MD)
    const ok = applyAnchor(pm, 'pm', a)
    expect(ok).toBe(true)

    const head = pm.state.selection.head
    const $h = pm.state.doc.resolve(head)
    // 落在含 world 的段落里
    expect($h.parent.textContent).toContain('world')
    // 且光标在 world 范围内(pmPosOf 给 world 起始)
    const wStart = pmPosOf(pm.state.doc, 'world')
    expect(head).toBeGreaterThanOrEqual(wStart)
    expect(head).toBeLessThanOrEqual(wStart + 'world'.length)

    cm.destroy()
    pm.destroy()
  })

  it('标题行也同步:光标在 Title → 对端落到 Title', () => {
    const pm = makePmView(MD)
    const titlePos = pmPosOf(pm.state.doc, 'Title')
    setPmCursor(pm, titlePos + 1)

    const a = captureAnchor(pm, 'pm')!
    const cm = makeCmView(MD)
    expect(applyAnchor(cm, 'cm', a)).toBe(true)

    const head = cm.state.selection.main.head
    const mdTitle = MD.indexOf('Title')
    expect(head).toBeGreaterThanOrEqual(mdTitle)
    expect(head).toBeLessThanOrEqual(mdTitle + 'Title'.length)

    pm.destroy()
    cm.destroy()
  })

  it('无效锚点(空文档)→ captureAnchor 返回 null', () => {
    const pm = makePmView('')
    expect(captureAnchor(pm, 'pm')).toBeNull()
    pm.destroy()
  })

  it('view 为 null → 安全返回 null/false', () => {
    expect(captureAnchor(null, 'pm')).toBeNull()
    expect(applyAnchor(null, 'pm', { toks: ['hello'], cursorIdx: 0, intraOffset: 2 })).toBe(false)
  })
})

// ============================================================
//  特殊语法:链接 / 表格(多余 token 被 LCS 跳过)
//  — 回归:旧"整窗 indexOf"方案下这两类会失败跳顶
// ============================================================

const LINK_MD =
  '# Intro\n\nSome lead text here.\n\nThis is a [link text](https://example.com/page) inside a sentence.\n\nTrailing paragraph.\n'

describe('链接跨模式同步', () => {
  it('CM → PM:光标在 link text → PM 落到 link text(不跳顶)', () => {
    const cm = makeCmView(LINK_MD)
    const mdLink = LINK_MD.indexOf('link text')
    setCmCursor(cm, mdLink + 4) // link text 中间

    const a = captureAnchor(cm, 'cm')!
    const pm = makePmView(LINK_MD)
    expect(applyAnchor(pm, 'pm', a)).toBe(true)

    const head = pm.state.selection.head
    const wStart = pmPosOf(pm.state.doc, 'link text')
    // 必须落在 link text 区域(旧方案这里 ok=false、head=1 跳顶)
    expect(head).toBeGreaterThanOrEqual(wStart)
    expect(head).toBeLessThanOrEqual(wStart + 'link text'.length)

    cm.destroy()
    pm.destroy()
  })

  it('PM → CM:光标在 link text → CM 落到 link text', () => {
    const pm = makePmView(LINK_MD)
    const wStart = pmPosOf(pm.state.doc, 'link text')
    setPmCursor(pm, wStart + 4)

    const a = captureAnchor(pm, 'pm')!
    const cm = makeCmView(LINK_MD)
    expect(applyAnchor(cm, 'cm', a)).toBe(true)

    const head = cm.state.selection.main.head
    const mdLink = LINK_MD.indexOf('link text')
    expect(head).toBeGreaterThanOrEqual(mdLink)
    expect(head).toBeLessThanOrEqual(mdLink + 'link text'.length)

    pm.destroy()
    cm.destroy()
  })
})

const TABLE_MD =
  '# Intro\n\n| col a | col b |\n|---|---|\n| cell one | cell two |\n\nTrailing paragraph after table.\n'

describe('表格跨模式同步', () => {
  it('PM → CM:光标在 cell two → CM 落到 cell two(不跳顶)', () => {
    const pm = makePmView(TABLE_MD)
    const wStart = pmPosOf(pm.state.doc, 'cell two')
    expect(wStart).toBeGreaterThanOrEqual(0)
    setPmCursor(pm, wStart + 3)

    const a = captureAnchor(pm, 'pm')!
    const cm = makeCmView(TABLE_MD)
    expect(applyAnchor(cm, 'cm', a)).toBe(true)

    const head = cm.state.selection.main.head
    const mdCell = TABLE_MD.indexOf('cell two')
    // 必须落在 cell two(旧方案这里 ok=false、head=0 跳顶)
    expect(head).toBeGreaterThanOrEqual(mdCell)
    expect(head).toBeLessThanOrEqual(mdCell + 'cell two'.length)

    pm.destroy()
    cm.destroy()
  })

  it('CM → PM:光标在 cell one → PM 落到 cell one', () => {
    const cm = makeCmView(TABLE_MD)
    const mdCell = TABLE_MD.indexOf('cell one')
    setCmCursor(cm, mdCell + 3)

    const a = captureAnchor(cm, 'cm')!
    const pm = makePmView(TABLE_MD)
    expect(applyAnchor(pm, 'pm', a)).toBe(true)

    const head = pm.state.selection.head
    const wStart = pmPosOf(pm.state.doc, 'cell one')
    expect(head).toBeGreaterThanOrEqual(wStart)
    expect(head).toBeLessThanOrEqual(wStart + 'cell one'.length)

    cm.destroy()
    pm.destroy()
  })
})
