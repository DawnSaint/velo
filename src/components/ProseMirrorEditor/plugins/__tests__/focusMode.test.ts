// 专注模式 plugin 测试。
//
// 测例覆盖:
// 1. enabled=false → 无 .velo-focus-active DOM
// 2. enabled=true → 光标所在顶层块挂 .velo-focus-active
// 3. 光标移到另一段 → .velo-focus-active 跟随到新段
// 4. 光标在嵌套结构(blockquote 内段落)内 → 顶层块(blockquote)高亮
// 5. setMeta 翻 enabled=false → .velo-focus-active 消失

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../../editor/schema'
import { fromMarkdown } from '../../editor/markdownIO'
import { focusModePlugin, focusModeKey, setFocusModeEnabled } from '../focusMode'

function makeView(initialMd: string, enabled = false): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(initialMd, schema),
    plugins: [focusModePlugin],
  })
  const view = new EditorView(container, { state })
  if (enabled) {
    view.dispatch(view.state.tr.setMeta(focusModeKey, { enabled: true }))
  }
  return view
}

/** 把光标设到 doc 中指定文本位置(基于 textBetween 的字符偏移)。 */
function setCursor(view: EditorView, textOffset: number) {
  const pos = textOffset + 1 // +1 跳过 doc 的 opening token
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
}

beforeEach(() => {
  document.body.innerHTML = ''
  // 重置模块级镜像,防止上一个用例的 setFocusModeEnabled 污染本用例的 state.init
  setFocusModeEnabled(false)
})

afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    const parent = el.parentElement
    if (parent) parent.remove()
  })
})

describe('focusModePlugin', () => {
  it('enabled=false → 无 .velo-focus-active', () => {
    const view = makeView('第一段\n\n第二段\n\n第三段', false)
    expect(view.dom.querySelector('.velo-focus-active')).toBeNull()
  })

  it('enabled=true → 光标所在段落挂 .velo-focus-active', () => {
    const view = makeView('第一段\n\n第二段\n\n第三段', true)
    // 光标默认在第一段
    const active = view.dom.querySelector('.velo-focus-active')
    expect(active).not.toBeNull()
    expect(active!.textContent).toContain('第一段')
  })

  it('光标移到另一段 → .velo-focus-active 跟随', () => {
    const view = makeView('第一段\n\n第二段\n\n第三段', true)

    // 光标移到第二段(第一段 3 字 + 空行 = 4 字符偏移后是第二段开头)
    // textBetween(0, pos) 在 PM 里:第一段 "第一段" = 3 字符 + \n + \n = 5,
    // 第二段从 pos=6 开始(textOffset=5)
    setCursor(view, 5)
    const active = view.dom.querySelector('.velo-focus-active')
    expect(active).not.toBeNull()
    expect(active!.textContent).toContain('第二段')
    expect(active!.textContent).not.toContain('第一段')
  })

  it('光标在 blockquote 内段落 → 顶层 blockquote 高亮', () => {
    const view = makeView('> 引用内段落\n\n普通段落', true)

    // 光标默认在 blockquote 内
    const active = view.dom.querySelector('.velo-focus-active')
    expect(active).not.toBeNull()
    expect(active!.textContent).toContain('引用内段落')
    // blockquote 的 DOM 是 <blockquote>,确认高亮的是 blockquote 而非内层 <p>
    expect(active!.tagName).toBe('BLOCKQUOTE')
  })

  it('setMeta 翻 enabled=false → .velo-focus-active 消失', () => {
    const view = makeView('第一段\n\n第二段', true)
    expect(view.dom.querySelector('.velo-focus-active')).not.toBeNull()

    view.dispatch(view.state.tr.setMeta(focusModeKey, { enabled: false }))
    expect(view.dom.querySelector('.velo-focus-active')).toBeNull()
  })
})
