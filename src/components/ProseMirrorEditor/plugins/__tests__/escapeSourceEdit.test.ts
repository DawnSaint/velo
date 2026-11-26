// 反斜杠转义源码态 + 实时输入 + markSourceEdit 联调 + **_xxx_** 逐字键入测试。

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Plugin } from 'prosemirror-state'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'

import { fromMarkdown, toMarkdown } from '../../editor/markdownIO'
import { schema } from '../../editor/schema'
import { hasEscapeMark } from '../../editor/escape'
import { getSourceEditRanges } from '../../editor/sourceEditSession'
import { SKIP_CONTENT_EMIT } from '../../editor/transactionMeta'
import { findHighlight } from '../../findreplace/findHighlight'
import { createPmBackend } from '../../findreplace/backend'
import {
  escapeSourceEditEscapeKeymap,
  escapeSourceEditKey,
  escapeSourceEditPlugin,
} from '../escapeSourceEdit'
import { markSourceEditKey, markSourceEditPlugin } from '../markSourceEdit'
import { syntaxAutoFormatPlugin } from '../syntaxAutoFormat'
import { _resetSyntaxRegistry, registerInlineSyntax } from '../../editor/syntaxRegistry'
import { escapeSyntax } from '../../syntax/inline/escape'
import { emphasisStarSyntax } from '../../syntax/inline/emphasisStar'
import { strongSyntax } from '../../syntax/inline/strong'
import { emphasisUnderscoreSyntax } from '../../syntax/inline/emphasis'
import { linkSyntax } from '../../syntax/inline/link'

const tick = (ms = 10): Promise<void> => new Promise(r => setTimeout(r, ms))

beforeAll(() => {
  _resetSyntaxRegistry()
  registerInlineSyntax(escapeSyntax)
  registerInlineSyntax(linkSyntax)
  registerInlineSyntax(emphasisStarSyntax)
  registerInlineSyntax(strongSyntax)
  registerInlineSyntax(emphasisUnderscoreSyntax)
})

function mountView(md: string, extra: Plugin[] = []): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(md, schema),
    plugins: [...extra, escapeSourceEditPlugin, escapeSourceEditEscapeKeymap, syntaxAutoFormatPlugin],
  })
  const view = new EditorView(container, { state })
  view.focus()
  return view
}

function blurEditor(): void {
  document.body.dispatchEvent(new Event('focusin', { bubbles: true }))
}

function escapedChars(doc: EditorState['doc']): string[] {
  const out: string[] = []
  doc.descendants((n) => {
    if (hasEscapeMark(n)) out.push(n.text ?? '')
  })
  return out
}

beforeEach(() => {
  document.querySelectorAll('.ProseMirror').forEach(el => el.parentElement?.remove())
})
afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach(el => el.parentElement?.remove())
})

describe('反斜杠转义源码态（Typora 风格展开 / 还原）', () => {
  it('默认只显示字符，光标点击/移入展开 \\，移出立即还原', () => {
    const view = mountView('128\\*128')
    expect(view.state.doc.textContent).toBe('128*128')
    expect(escapedChars(view.state.doc)).toEqual(['*'])

    // 光标落到 * 左侧（pos=4）→ 展开为 \*，且 `\` 挂浅灰样式
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4)))
    expect(view.state.doc.textContent).toBe('128\\*128')
    expect(view.dom.querySelectorAll('.velo-escape-slash')).toHaveLength(1)
    expect(view.dom.querySelector('.velo-escape-slash')?.textContent).toBe('\\')
    expect(getSourceEditRanges(view.state)).toContainEqual({ from: 4, to: 6 })

    // 光标移到别处 → 立即还原为 * + escape mark
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    expect(view.state.doc.textContent).toBe('128*128')
    expect(escapedChars(view.state.doc)).toEqual(['*'])
    expect(view.dom.querySelectorAll('.velo-escape-slash')).toHaveLength(0)
    view.destroy()
  })

  it('展开事务挂 SKIP_CONTENT_EMIT（不误标 dirty）', () => {
    const view = mountView('128\\*128')
    const selTr = view.state.tr.setSelection(TextSelection.create(view.state.doc, 4))
    const { transactions } = view.state.applyTransaction(selTr)
    expect(transactions.some(t => t.getMeta(SKIP_CONTENT_EMIT) === true)).toBe(true)
    view.destroy()
  })

  it('在展开后的 \\* 右边界继续输入普通字符 → 字符落在转义外且 \\* 立即收起', () => {
    const view = mountView('a\\*b')
    // 落到 * 右侧（pos=3）→ 展开为 a\*|b（光标落 pos=4）
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)))
    expect(view.state.doc.textContent).toBe('a\\*b')
    expect(view.state.selection.head).toBe(4)

    // 继续输入 X → X 不被转义吞并，\* 自动收起为 *
    view.dispatch(view.state.tr.insertText('X'))
    expect(view.state.doc.textContent).toBe('a*Xb')
    expect(escapedChars(view.state.doc)).toEqual(['*'])
    expect(escapeSourceEditKey.getState(view.state)?.revealed).toHaveLength(0)
    view.destroy()
  })

  it('展开后删掉 \\ 再移出光标 → 取消转义成为普通字符', () => {
    const view = mountView('a\\*b')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)))
    expect(view.state.doc.textContent).toBe('a\\*b')
    // 删掉 `\`（pos 2..3）
    view.dispatch(view.state.tr.delete(2, 3))
    expect(view.state.doc.textContent).toBe('a*b')
    // 光标移出
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    expect(escapedChars(view.state.doc)).toEqual([])
    view.destroy()
  })

  it('失焦还原为渲染态，Escape 放弃编辑并还原', () => {
    const view = mountView('a\\*b')
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)))
    expect(view.state.doc.textContent).toBe('a\\*b')
    blurEditor()
    expect(view.state.doc.textContent).toBe('a*b')
    expect(escapedChars(view.state.doc)).toEqual(['*'])

    // 再次展开并按 Escape
    view.dispatch(view.state.tr.setMeta(escapeSourceEditKey, { type: 'check' }))
    expect(view.state.doc.textContent).toBe('a\\*b')
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(view.state.doc.textContent).toBe('a*b')
    expect(escapedChars(view.state.doc)).toEqual(['*'])
    view.destroy()
  })

  it('查找面板打开期间不改 doc，改用纯装饰显示命中转义', () => {
    const view = mountView('128\\*128', [findHighlight])
    const backend = createPmBackend(view)
    const opts = { caseSensitive: false, wholeWord: false, regex: false }
    backend.setFindActive(true)
    const matches = backend.findMatches('\\*', opts)
    expect(matches).toEqual([{ from: 4, to: 5 }])
    backend.setHighlight(matches, 0)
    backend.setSelection(matches[0].from, matches[0].to)

    expect(view.state.doc.textContent).toBe('128*128')
    expect(view.dom.querySelectorAll('.velo-escape-inline')).toHaveLength(1)

    backend.clearHighlight()
    expect(view.state.doc.textContent).toBe('128\\*128')
    view.destroy()
  })
})

describe('用户报告场景 1：给已解析斜体的第一个 * 前加 \\', () => {
  const ORIGINAL = '以一张128*128图像为例（如人脸图像），展示数世界到底有多复杂。遍历每一个像素（特征）将其在区间\\[0,255]上连续取值，保持其余(128*-1）个特征不变。'

  it('点击斜体进入 markSourceEdit → 在第一个 * 前键入 \\ → 移出光标后整段不再是斜体', async () => {
    const view = mountView(ORIGINAL, [markSourceEditPlugin])

    // 初始状态：两个 * 之间被解析为斜体
    let emphasisPos = -1
    view.state.doc.descendants((n, pos) => {
      if (emphasisPos < 0 && n.isText && n.marks.some(m => m.type.name === 'emphasis')) {
        emphasisPos = pos + 2
      }
    })
    expect(emphasisPos).toBeGreaterThan(0)

    // 点击进入斜体源码态，应同时保留内层 \[0,255] 的反斜杠
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, emphasisPos)))
    await tick()
    const session = markSourceEditKey.getState(view.state)?.session
    expect(session).not.toBeNull()
    expect(view.state.doc.textBetween(session!.editFrom, session!.editTo)).toContain('\\[0,255]')

    // 把光标移到第一个 * 之前（editFrom）并输入 `\`
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, session!.editFrom)))
    view.dispatch(view.state.tr.insertText('\\'))
    await tick()

    // `\` 必须被纳入 session，而不是留在 session 之外
    const afterInsert = markSourceEditKey.getState(view.state)?.session
    expect(afterInsert).not.toBeNull()
    expect(view.state.doc.textBetween(afterInsert!.editFrom, afterInsert!.editTo).startsWith('\\*')).toBe(true)

    // 光标移出 session → commit 后整段不再有任何 emphasis，且 `*` 与 `[` 均带 escape mark
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    await tick()

    let hasEmphasis = false
    view.state.doc.descendants((n) => {
      if (n.isText && n.marks.some(m => m.type.name === 'emphasis')) hasEmphasis = true
    })
    expect(hasEmphasis).toBe(false)
    expect(escapedChars(view.state.doc)).toEqual(['*', '['])
    expect(toMarkdown(view.state.doc)).toContain('128\\*128')
    expect(toMarkdown(view.state.doc)).toContain('\\[0,255]')

    view.destroy()
  })

  it('在普通段落中直接键入含 \\* 与 \\[ 的整段文本 → 不会被 syntaxAutoFormat 误转斜体', () => {
    const view = mountView('')
    const input = '以一张128\\*128图像为例（如人脸图像），展示数世界到底有多复杂。遍历每一个像素（特征）将其在区间\\[0,255]上连续取值，保持其余(128*-1）个特征不变。'
    view.dispatch(view.state.tr.insertText(input, 1))

    let hasEmphasis = false
    view.state.doc.descendants((n) => {
      if (n.isText && n.marks.some(m => m.type.name === 'emphasis')) hasEmphasis = true
    })
    expect(hasEmphasis).toBe(false)
    expect(escapedChars(view.state.doc)).toEqual(['*', '['])
    expect(view.state.doc.textContent).toContain('128*128')
    expect(view.state.doc.textContent).toContain('[0,255]')

    // 继续在段尾打字也不会触发斜体
    view.dispatch(view.state.tr.insertText('。', view.state.doc.content.size - 1))
    view.state.doc.descendants((n) => {
      if (n.isText && n.marks.some(m => m.type.name === 'emphasis')) hasEmphasis = true
    })
    expect(hasEmphasis).toBe(false)
    view.destroy()
  })
})

describe('用户报告场景 2：WYSIWYG 逐字符输入与源码编辑 **_xxx_**', () => {
  it('逐字符键入 **_xxx_** → 渲染为加粗斜体的 xxx（不丢失斜体，不残留 **）', () => {
    const view = mountView('')
    for (const ch of '**_xxx_**') {
      view.dispatch(view.state.tr.insertText(ch, view.state.selection.head))
    }
    expect(view.state.doc.textContent).toBe('xxx')
    let marks: string[] = []
    view.state.doc.descendants((n) => {
      if (n.isText && n.text === 'xxx') marks = n.marks.map(m => m.type.name)
    })
    expect(marks).toContain('strong')
    expect(marks).toContain('emphasis')
    expect(toMarkdown(view.state.doc).trim()).toBe('**_xxx_**')
    view.destroy()
  })

  it('逐字符键入 **_x_**（单字符）、_**xxx**_ 与 __*零测集*__ 均渲染为加粗斜体', () => {
    for (const [input, expectedText] of [
      ['**_x_**', 'x'],
      ['_**xxx**_', 'xxx'],
      ['__*零测集*__', '零测集'],
    ]) {
      const view = mountView('')
      for (const ch of input) {
        view.dispatch(view.state.tr.insertText(ch, view.state.selection.head))
      }
      expect(view.state.doc.textContent, input).toBe(expectedText)
      let marks: string[] = []
      view.state.doc.descendants((n) => {
        if (n.isText && n.text === expectedText) marks = n.marks.map(m => m.type.name)
      })
      expect(marks, input).toContain('strong')
      expect(marks, input).toContain('emphasis')
      view.destroy()
    }
  })

  it('markSourceEdit 进入 **_xxx_** 再移出 → 保留 strong(*) 与 emphasis(_) 分隔符', async () => {
    const view = mountView('前 **_xxx_** 后', [markSourceEditPlugin])
    // 点击 xxx 内部进入 markSourceEdit
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4)))
    await tick()
    expect(view.state.doc.textContent).toBe('前 **_xxx_** 后')

    // 移出光标提交
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    await tick()
    expect(view.state.doc.textContent).toBe('前 xxx 后')
    let strongMarker: string | undefined
    let emphMarker: string | undefined
    view.state.doc.descendants((n) => {
      if (n.isText && n.text === 'xxx') {
        strongMarker = n.marks.find(m => m.type.name === 'strong')?.attrs.marker
        emphMarker = n.marks.find(m => m.type.name === 'emphasis')?.attrs.marker
      }
    })
    expect(strongMarker).toBe('*')
    expect(emphMarker).toBe('_')
    view.destroy()
  })
})
