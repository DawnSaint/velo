// 字符实体源码态:点击 / 搜索跳转移入解码出来的空白处 → 显示 &#x20; 字面量
// (浅灰),光标移出区间或编辑器失焦即还原。查找面板打开期间不改 doc,改用纯
// 装饰显示命中。含用户改写字面量、加粗源码态集成。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Plugin } from 'prosemirror-state'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'

import { fromMarkdown } from '../../editor/markdownIO'
import { schema } from '../../editor/schema'
import { getCharRefSegments } from '../../editor/charRef'
import { getSourceEditRanges } from '../../editor/sourceEditSession'
import { SKIP_CONTENT_EMIT } from '../../editor/transactionMeta'
import { findHighlight, findHighlightKey } from '../../findreplace/findHighlight'
import { createPmBackend } from '../../findreplace/backend'
import {
  charRefSourceEditKey,
  charRefSourceEditPlugin,
  flushCharRefReveal,
} from '../charRefSourceEdit'
import { markSourceEditPlugin } from '../markSourceEdit'

function mountView(md: string, extra: Plugin[] = []): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(md, schema),
    plugins: [...extra, charRefSourceEditPlugin],
  })
  const view = new EditorView(container, { state })
  view.focus()
  return view
}

function blurEditor(): void {
  // 焦点移到编辑器之外的元素:document 上的 focusin 捕获监听会还原源码态。
  document.body.dispatchEvent(new Event('focusin', { bubbles: true }))
}

function charRefRaws(doc: EditorState['doc']): string[] {
  const out: string[] = []
  doc.descendants(n => {
    const segments = getCharRefSegments(n)
    if (segments) out.push(...segments.map(s => s.raw))
  })
  return out
}

beforeEach(() => {
  document.querySelectorAll('.ProseMirror').forEach(el => el.parentElement?.remove())
})
afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach(el => el.parentElement?.remove())
})

describe('字符实体源码态', () => {
  it('光标落在解码出的空白处 → 换成实体字面量 + 浅灰装饰', () => {
    const view = mountView('前 &#x20; 后')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 4)))

    expect(view.state.doc.textContent).toBe('前 &#x20; 后')
    expect(view.dom.querySelectorAll('.velo-char-ref-source')).toHaveLength(1)
    expect(view.dom.querySelector('.velo-char-ref-source')?.textContent).toBe('&#x20;')
    expect(charRefSourceEditKey.getState(view.state)?.revealed).toHaveLength(1)
    expect(getSourceEditRanges(view.state)).toContainEqual({ from: 3, to: 9 })
    view.destroy()
  })

  it('光标移到别处 → 立即还原(不必等编辑器失焦)', () => {
    const view = mountView('前 &#x20; 后')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 4)))
    expect(view.state.doc.textContent).toBe('前 &#x20; 后')

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    expect(view.state.doc.textContent).toBe('前   后')
    expect(charRefRaws(view.state.doc)).toEqual(['&#x20;'])
    expect(charRefSourceEditKey.getState(view.state)?.revealed).toHaveLength(0)
    expect(view.dom.querySelectorAll('.velo-char-ref-source')).toHaveLength(0)
    view.destroy()
  })

  it('光标在已展开的字面量内部移动 → 保持展开', () => {
    const view = mountView('前 &#x20; 后')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 4)))
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 5)))
    expect(view.state.doc.textContent).toBe('前 &#x20; 后')
    expect(charRefSourceEditKey.getState(view.state)?.revealed).toHaveLength(1)
    blurEditor()
    expect(view.state.doc.textContent).toBe('前   后')
    view.destroy()
  })

  it('光标从一处实体移到另一处 → 一笔事务里旧的还原、新的展开', () => {
    const view = mountView('**&#x20;/ &#x20;**')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 2)))
    expect(view.state.doc.textContent).toBe('&#x20;/  ')

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 9, 10)))
    expect(view.state.doc.textContent).toBe(' / &#x20;')
    expect(charRefSourceEditKey.getState(view.state)?.revealed).toHaveLength(1)
    expect(view.dom.querySelectorAll('.velo-char-ref-source')).toHaveLength(1)

    blurEditor()
    expect(view.state.doc.textContent).toBe(' /  ')
    expect(charRefRaws(view.state.doc)).toEqual(['&#x20;', '&#x20;'])
    view.destroy()
  })

  it('重复点同一空白处(光标没动)靠 check meta 重进源码态', () => {
    const view = mountView('前 &#x20; 后')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 4)))
    // 失焦还原后光标仍停在实体边界,再点同一处不产生 selection-only 事务。
    flushCharRefReveal(view)
    expect(view.state.doc.textContent).toBe('前   后')

    view.dispatch(view.state.tr.setMeta(charRefSourceEditKey, { type: 'check' }))
    expect(view.state.doc.textContent).toBe('前 &#x20; 后')
    expect(view.dom.querySelectorAll('.velo-char-ref-source')).toHaveLength(1)
    view.destroy()
  })

  it('进入源码态的 appendTransaction 挂 SKIP_CONTENT_EMIT(不误标 dirty)', () => {
    const view = mountView('前 &#x20; 后')
    const selTr = view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 4))
    // appendTransaction 的 tr 不经过 view.dispatch,只能从 applyTransaction 结果里取。
    const { transactions } = view.state.applyTransaction(selTr)
    expect(transactions.some(t => t.getMeta(SKIP_CONTENT_EMIT) === true)).toBe(true)
    view.destroy()
  })

  it('失焦还原成渲染态 + char_ref mark(字面量再次可跳转)', () => {
    const view = mountView('前 &#x20; 后')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 4)))
    expect(view.state.doc.textContent).toBe('前 &#x20; 后')

    blurEditor()
    expect(view.state.doc.textContent).toBe('前   后')
    expect(charRefRaws(view.state.doc)).toEqual(['&#x20;'])
    expect(view.dom.querySelectorAll('.velo-char-ref-source')).toHaveLength(0)
    expect(charRefSourceEditKey.getState(view.state)?.revealed).toHaveLength(0)
    view.destroy()
  })

  it('选区覆盖多处实体时一起显示,失焦一起还原', () => {
    const view = mountView('**&#x20;/ &#x20;**')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 2)))
    // 只选中第一处 → 只展开第一处(strong 是 mark,不是文本)
    expect(view.state.doc.textContent).toBe('&#x20;/  ')
    blurEditor()
    expect(charRefRaws(view.state.doc)).toEqual(['&#x20;', '&#x20;'])
    view.destroy()

    const view2 = mountView('**&#x20;/ &#x20;**')
    view2.dispatch(view2.state.tr.setSelection(TextSelection.create(view2.state.doc, 1, 5)))
    expect(view2.state.doc.textContent).toBe('&#x20;/ &#x20;')
    expect(view2.dom.querySelectorAll('.velo-char-ref-source')).toHaveLength(2)
    blurEditor()
    expect(charRefRaws(view2.state.doc)).toEqual(['&#x20;', '&#x20;'])
    view2.destroy()
  })

  it('用户在字面量里键入后失焦 → 保留编辑结果,不重建 mark', () => {
    const view = mountView('前 &#x20; 后')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 4)))
    const range = charRefSourceEditKey.getState(view.state)!.revealed[0]
    view.dispatch(view.state.tr.insertText('X', range.from, range.to))
    blurEditor()
    expect(view.state.doc.textContent).toBe('前 X 后')
    expect(charRefRaws(view.state.doc)).toEqual([])
    view.destroy()
  })

  it('查找面板打开期间退避,避免 matches 坐标漂移', () => {
    const view = mountView('前 &#x20; 后', [findHighlight])
    view.dispatch(view.state.tr.setMeta(findHighlightKey, { type: 'active', active: true }))
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 4)))
    expect(view.state.doc.textContent).toBe('前   后')
    expect(charRefSourceEditKey.getState(view.state)?.revealed).toHaveLength(0)
    view.destroy()
  })

  it('全文查找命中实体 → 纯装饰原位显示字面量,不改 doc / 不漂移 matches', () => {
    const view = mountView('前 &#x20; 后', [findHighlight])
    const backend = createPmBackend(view)
    const opts = { caseSensitive: false, wholeWord: false, regex: false }
    backend.setFindActive(true)
    const matches = backend.findMatches('&#x20;', opts)
    expect(matches).toEqual([{ from: 3, to: 4 }])
    backend.setHighlight(matches, 0)
    backend.setSelection(matches[0].from, matches[0].to)

    // doc 仍是渲染态:matches 坐标稳定,高亮背景覆盖字面量。
    expect(view.state.doc.textContent).toBe('前   后')
    expect(charRefSourceEditKey.getState(view.state)?.revealed).toHaveLength(0)
    expect(view.dom.querySelector('.velo-find-current')).not.toBeNull()
    expect(view.dom.querySelector('.velo-char-ref-inline')?.getAttribute('data-char-ref'))
      .toBe('&#x20;')
    // 高亮背景必须盖住字面量(PM 把两个同区间 inline deco 合并成一枚 span)。
    expect(view.dom.querySelector('.velo-find-current')?.contains(
      view.dom.querySelector('.velo-char-ref-inline') ?? null,
    )).toBe(true)
    expect(backend.findMatches('&#x20;', opts)).toEqual([{ from: 3, to: 4 }])

    // 面板关闭后焦点回编辑器:按当前选区重判,继续显示字面量。
    backend.clearHighlight()
    expect(view.state.doc.textContent).toBe('前 &#x20; 后')
    expect(view.dom.querySelector('.velo-char-ref-source')?.textContent).toBe('&#x20;')
    view.destroy()
  })

  it('全文查找命中的实体装饰按 segment 切分,没命中的实体不展开', () => {
    const view = mountView('a &#x20; b &#8203; c', [findHighlight])
    const backend = createPmBackend(view)
    const opts = { caseSensitive: false, wholeWord: false, regex: false }
    backend.setFindActive(true)
    const matches = backend.findMatches('&#x20;', opts)
    backend.setHighlight(matches, 0)
    backend.setSelection(matches[0].from, matches[0].to)

    expect(view.dom.querySelectorAll('.velo-char-ref-inline')).toHaveLength(1)
    expect(view.dom.querySelector('.velo-char-ref-inline')?.getAttribute('data-char-ref'))
      .toBe('&#x20;')
    view.destroy()
  })

  it('flushCharRefReveal 把 doc 统一回渲染态(查找后端算 matches 前调用)', () => {
    const view = mountView('前 &#x20; 后')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 4)))
    expect(view.state.doc.textContent).toBe('前 &#x20; 后')
    flushCharRefReveal(view)
    expect(view.state.doc.textContent).toBe('前   后')
    expect(charRefRaws(view.state.doc)).toEqual(['&#x20;'])
    view.destroy()
  })

  it('全局搜索点击结果:findMatches 命中 → setSelection 跳到并展示实体字面量', () => {
    const view = mountView('前 &#x20; 后')
    const backend = createPmBackend(view)
    const opts = { caseSensitive: false, wholeWord: false, regex: false }
    const matches = backend.findMatches('&#x20;', opts)
    expect(matches).toEqual([{ from: 3, to: 4 }])

    backend.focus()
    backend.setSelection(matches[0].from, matches[0].to)
    expect(view.state.doc.textContent).toBe('前 &#x20; 后')
    expect(view.dom.querySelectorAll('.velo-char-ref-source')).toHaveLength(1)

    // revealWorkspaceSearchMatch 随后会 clearHighlight(解除查找面板标记 +
    // recheck 重判):选区仍在实体内,源码态必须保持,不能被误还原。
    backend.clearHighlight()
    expect(view.state.doc.textContent).toBe('前 &#x20; 后')
    // 光标移到别处 → 立刻还原(用户报告的「跳转后移开仍残留字面量」)。
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    expect(view.state.doc.textContent).toBe('前   后')

    // 连续点下一条结果:findMatches 先 flush 源码态,坐标仍落在渲染态上。
    expect(backend.findMatches('&#x20;', opts)).toEqual([{ from: 3, to: 4 }])
    view.destroy()
  })

  it('加粗源码编辑态里实体显示为字面量并带浅灰样式(截图同款)', () => {
    const view = mountView('**&#x20;/ &#x20;**', [markSourceEditPlugin])
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)))
    expect(view.state.doc.textContent).toBe('**&#x20;/ &#x20;**')
    expect(view.dom.querySelectorAll('.velo-char-ref-source')).toHaveLength(2)
    // 本场景由 markSourceEdit 持有 session,实体插件不重复进 session
    expect(charRefSourceEditKey.getState(view.state)?.revealed).toHaveLength(0)
    view.destroy()
  })
})
