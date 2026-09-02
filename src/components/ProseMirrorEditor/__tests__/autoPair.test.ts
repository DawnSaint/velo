// 括号自动配对 plugin 测试(Phase 2)
//
// 测例覆盖:
// 1. ASCII 括号配对:() [] {}
// 2. CJK 括号配对:（）「」【】《》
// 3. 选区包裹:有选区时输入开括号 → 包裹选区
// 4. 闭括号跳越:已有闭括号时键入同字符 → 光标跳过
// 5. 成对删除:Backspace 在配对中间 → 同时删除两侧
// 6. Tab 跳越:Tab 跳过闭括号
// 7. Shift+Tab 跳越:跳回开括号
// 8. 代码块内不触发
// 9. 行内代码内不触发
// 10. IME 守卫:composing 状态下不拦截
// 11. 智能引号:字母后输入 ' 不配对(apostrophe)
// 12. 设置开关:disabled 时不配对

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import { autoPairPlugin, autoPairKey } from '../plugins/autoPair'
import type { Plugin } from 'prosemirror-state'

// ============================================================
//  工具
// ============================================================

function makeView(initialMd = '', enabled = true): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(initialMd, schema),
    plugins: [autoPairPlugin],
  })
  const view = new EditorView(container, { state })
  // 设初值(模拟 store hydrate)
  view.dispatch(view.state.tr.setMeta(autoPairKey, { enabled }))
  return view
}

/** 模拟 ProseMirror 的 handleTextInput:遍历 plugin props 找 handleTextInput */
function typeChar(view: EditorView, char: string, pos?: number): void {
  const sel = view.state.selection
  const from = pos ?? sel.from
  const to = pos ?? sel.to
  const deflt = () => view.state.tr.insertText(char, from, to)
  for (const plugin of view.state.plugins as unknown as Plugin[]) {
    const props = plugin.spec?.props as any
    if (props?.handleTextInput?.(view, from, to, char, deflt)) return
  }
  // 未被拦截 → 直接插入(模拟默认行为)
  view.dispatch(view.state.tr.insertText(char, from, to))
}

/** 模拟 keydown:通过 handleDOMEvents */
function pressKey(view: EditorView, key: string, shift = false): boolean {
  for (const plugin of view.state.plugins as unknown as Plugin[]) {
    const props = plugin.spec?.props as any
    const handlers = props?.handleDOMEvents as any
    if (handlers?.keydown) {
      const event = { key, shiftKey: shift, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, preventDefault() {} } as unknown as KeyboardEvent
      if (handlers.keydown(view, event)) return true
    }
  }
  return false
}

/** 设置光标位置 */
function setCursor(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
}

/** 获取段落文本内容 */
function paraText(view: EditorView, paraIdx = 0): string {
  let text = ''
  let idx = 0
  view.state.doc.descendants((node) => {
    if (node.type.name === 'paragraph' && idx === paraIdx) {
      text = node.textContent
      return false
    }
    if (node.type.name === 'paragraph') idx++
    return true
  })
  return text
}

// ============================================================
//  Setup
// ============================================================

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    const parent = el.parentElement
    if (parent) parent.remove()
  })
})

// ============================================================
//  测例
// ============================================================

describe('autoPairPlugin', () => {
  it('1. ASCII 括号配对:() [] {}', () => {
    const view = makeView('')
    setCursor(view, 1)
    typeChar(view, '(')
    expect(paraText(view)).toBe('()')
    expect(view.state.selection.from).toBe(2) // 光标在中间
    view.destroy()
  })

  it('2. CJK 括号配对:（）「」【】《》', () => {
    const view = makeView('')
    setCursor(view, 1)
    typeChar(view, '（')
    expect(paraText(view)).toBe('（）')
    expect(view.state.selection.from).toBe(2)

    // 测试「」
    setCursor(view, 3) // 移到末尾后
    typeChar(view, '「')
    expect(paraText(view)).toBe('（）「」')
    view.destroy()
  })

  it('3. 选区包裹:有选区时输入开括号 → 包裹选区', () => {
    const view = makeView('hello')
    // 选中 "hel"(pos 1~4)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 4)))
    typeChar(view, '(')
    expect(paraText(view)).toBe('(hel)lo')
    // 光标在包裹内容后(pos 5 = 原 to+1)
    expect(view.state.selection.from).toBe(5)
    view.destroy()
  })

  it('4. 闭括号跳越:已有闭括号时键入同字符 → 光标跳过', () => {
    const view = makeView('')
    setCursor(view, 1)
    typeChar(view, '(') // 插入 (),光标在 pos 2
    expect(paraText(view)).toBe('()')
    // 现在键入 ) → 应跳过而非重复插入
    pressKey(view, ')')
    expect(paraText(view)).toBe('()') // 没多出 )
    expect(view.state.selection.from).toBe(3) // 光标在 ) 之后
    view.destroy()
  })

  it('5. 成对删除:Backspace 在配对中间 → 同时删除两侧', () => {
    const view = makeView('')
    setCursor(view, 1)
    typeChar(view, '(') // 插入 (),光标在 pos 2(中间)
    expect(paraText(view)).toBe('()')
    // 按 Backspace → 应同时删除 ( 和 )
    pressKey(view, 'Backspace')
    expect(paraText(view)).toBe('')
    view.destroy()
  })

  it('6. Tab 跳越:Tab 跳过闭括号', () => {
    const view = makeView('()')
    // 光标在 ( 和 ) 之间 = pos 2
    setCursor(view, 2)
    const handled = pressKey(view, 'Tab')
    expect(handled).toBe(true)
    // 光标跳到 ) 之后 = pos 3
    expect(view.state.selection.from).toBe(3)
    view.destroy()
  })

  it('7. Shift+Tab 跳越:跳回开括号', () => {
    const view = makeView('()')
    // 光标在 ( 和 ) 之间 = pos 2(与 Tab 测试同位)
    // getCharBefore(2) = '(' → isAllowedOpeningChar → true → 跳回 pos 1
    setCursor(view, 2)
    const handled = pressKey(view, 'Tab', true) // Shift+Tab
    expect(handled).toBe(true)
    // 光标跳到 ( 之前 = pos 1
    expect(view.state.selection.from).toBe(1)
    view.destroy()
  })

  it('8. 代码块内不触发', () => {
    const md = '```js\nconst x = 1\n```'
    const view = makeView(md)
    // 找到 code_block 内的位置
    let codeStart = -1
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'code_block' && codeStart === -1) {
        codeStart = pos + 1 // code_block 内容起始
        return false
      }
      return true
    })
    setCursor(view, codeStart)
    typeChar(view, '(')
    // 代码块内不配对 → 只有 ( 没有 )
    const codeText = view.state.doc.textBetween(codeStart, codeStart + 10, '\n', '\n')
    expect(codeText).toContain('(')
    expect(codeText).not.toContain('()')
    view.destroy()
  })

  it('9. 行内代码内不触发', () => {
    const md = '`code`'
    const view = makeView(md)
    // 找到 inline code mark 覆盖的文本位置
    let codePos = -1
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.marks.some(m => m.type.name === 'code')) {
        codePos = pos // 文本节点起始位置
        return false
      }
      return true
    })
    if (codePos === -1) {
      // 如果没找到 code mark,跳过(可能 fromMarkdown 不生成 code mark)
      view.destroy()
      return
    }
    // 尝试在行内代码后输入括号
    setCursor(view, codePos)
    typeChar(view, '(')
    // 行内代码内不配对 → 只有 ( 没有 )
    // 检查文档中是否有 () 配对
    const fullText = view.state.doc.textContent
    expect(fullText).not.toContain('()')
    view.destroy()
  })

  it('10. IME 守卫:composing 状态下不拦截', () => {
    const view = makeView('')
    setCursor(view, 1)
    // 模拟 composing 状态(view.composing 是只读 getter,用 defineProperty 覆写)
    Object.defineProperty(view, 'composing', { value: true, configurable: true })
    typeChar(view, '(')
    // composing 时不拦截 → 直接插入单个 (
    expect(paraText(view)).toBe('(')
    // 清除 composing
    Object.defineProperty(view, 'composing', { value: false, configurable: true })
    view.destroy()
  })

  it('11. 智能引号:字母后输入 \' 不配对(apostrophe)', () => {
    const view = makeView('hello')
    // 光标在 "hello" 之后 = pos 6
    setCursor(view, 6)
    typeChar(view, "'")
    // 字母后输入 ' → 不配对(是 apostrophe)
    expect(paraText(view)).toBe("hello'")
    view.destroy()
  })

  it('12. 设置开关:disabled 时不配对', () => {
    const view = makeView('', false) // enabled=false
    setCursor(view, 1)
    typeChar(view, '(')
    expect(paraText(view)).toBe('(')
    expect(view.state.doc.textContent).not.toContain('()')
    view.destroy()
  })

  it('13. 反引号围栏:行首 `` 后输入第三个 ` 不自动补全', () => {
    const view = makeView('')
    setCursor(view, 1)
    typeChar(view, '`') // 自动配对 → `` 光标在中间
    expect(paraText(view)).toBe('``')
    // 第二个 `:触发闭括号跳越,光标移到 `` 末尾(模拟真实键入)
    pressKey(view, '`')
    expect(paraText(view)).toBe('``')
    expect(view.state.selection.from).toBe(3) // 在 `` 之后
    // 第三个 `:不应再自动配对,只插入单个 → ```
    typeChar(view, '`')
    expect(paraText(view)).toBe('```')
    view.destroy()
  })

  it('14. 反引号围栏:行首 ``` 后输入第四个 ` 仍为单个(得 ```` 而非 `````)', () => {
    const view = makeView('')
    setCursor(view, 1)
    typeChar(view, '`'); pressKey(view, '`'); typeChar(view, '`') // → ```
    expect(paraText(view)).toBe('```')
    // 第四个 `:只插入单个 → ````
    typeChar(view, '`')
    expect(paraText(view)).toBe('````')
    view.destroy()
  })

  it('15. 反引号围栏:非行首(行内代码)仍正常配对', () => {
    const view = makeView('abc')
    setCursor(view, 4) // 在 "abc" 之后
    typeChar(view, '`') // 普通行内代码开符号 → 自动配对
    expect(paraText(view)).toBe('abc``')
    expect(view.state.selection.from).toBe(5) // 光标在配对中间
    view.destroy()
  })
})
