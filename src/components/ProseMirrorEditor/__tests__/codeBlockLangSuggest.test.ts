// ``` 语言建议下拉(codeBlockLangSuggestPlugin)测试。
//
// 覆盖:
//  - 状态检测:``` 激活 / 非 ``` 不激活 / 光标不在段末不激活 / code_block 内不激活
//  - 过滤:输入 p → 过滤匹配项
//  - 键盘导航:ArrowDown/Up 循环高亮
//  - Enter 有高亮 → 提交选中语言(拦截 codeBlockEnterCommand)
//  - Enter 无高亮 → 回退到 codeBlockEnterCommand(用原始文本)
//  - Escape → 关闭下拉,再输入恢复
//  - 点击条目 → 提交该语言
//  - DOM:激活时下拉出现在 body,关闭时移除

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { keymap } from 'prosemirror-keymap'
import { chainCommands, splitBlock } from 'prosemirror-commands'
import { schema } from '../editor/schema'
import { codeBlockLangSuggestPlugin, codeBlockLangSuggestKey } from '../plugins/codeBlockLangSuggest'
import { codeBlockEnterCommand } from '../syntax/block/codeBlock'

function mountView(initialDoc = schema.node('doc', null, [schema.node('paragraph')])): {
  view: EditorView
  cleanup: () => void
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const state = EditorState.create({
    schema,
    doc: initialDoc,
    selection: TextSelection.atEnd(initialDoc),
    plugins: [
      codeBlockLangSuggestPlugin,
      keymap({
        Enter: chainCommands(codeBlockEnterCommand, splitBlock),
      }),
    ],
  })
  const view = new EditorView(host, { state })
  return { view, cleanup: () => { view.destroy(); host.remove() } }
}

function typeText(view: EditorView, text: string): void {
  view.dispatch(view.state.tr.insertText(text))
}

function getState(view: EditorView) {
  return codeBlockLangSuggestKey.getState(view.state)!
}

function dispatchKey(view: EditorView, key: string): void {
  view.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

describe('codeBlockLangSuggest: 状态检测', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('输入 ``` → 激活,query 为空', () => {
    typeText(view, '```')
    const s = getState(view)
    expect(s.active).toBe(true)
    expect(s.query).toBe('')
  })

  it('输入 ```python → 激活,query=python', () => {
    typeText(view, '```python')
    const s = getState(view)
    expect(s.active).toBe(true)
    expect(s.query).toBe('python')
  })

  it('输入普通文本 → 不激活', () => {
    typeText(view, 'hello world')
    expect(getState(view).active).toBe(false)
  })

  it('输入 ```py x → 不激活(空格后有额外字符)', () => {
    typeText(view, '```py x')
    expect(getState(view).active).toBe(false)
  })

  it('光标不在段末 → 不激活', () => {
    typeText(view, '```python')
    // 把光标移到段落中间(``` 之后)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    expect(getState(view).active).toBe(false)
  })

  it('在 code_block 内 → 不激活', () => {
    // 先创建一个 code_block
    typeText(view, '```')
    dispatchKey(view, 'Enter')
    // view 自动转成 code_block,光标在里面
    expect(view.state.doc.firstChild!.type.name).toBe('code_block')
    // 在 code_block 内输入 ``` 不激活 suggest
    typeText(view, '```')
    expect(getState(view).active).toBe(false)
  })
})

describe('codeBlockLangSuggest: DOM 下拉', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('激活时下拉出现在 body', () => {
    typeText(view, '```')
    const dropdown = document.querySelector('.velo-lang-dropdown')
    expect(dropdown).not.toBeNull()
    // 应包含候选项
    const items = dropdown!.querySelectorAll('.velo-lang-dropdown-item')
    expect(items.length).toBeGreaterThan(0)
  })

  it('输入 ```p → 下拉项过滤匹配 p', () => {
    typeText(view, '```p')
    const items = document.querySelectorAll('.velo-lang-dropdown-item')
    expect(items.length).toBeGreaterThan(0)
    // 所有候选项应包含 p(不区分大小写)
    items.forEach(item => {
      const text = item.textContent || ''
      expect(text.toLowerCase()).toContain('p')
    })
  })

  it('无匹配时下拉隐藏', () => {
    typeText(view, '```zzzznotalang')
    const dropdown = document.querySelector('.velo-lang-dropdown') as HTMLDivElement
    expect(dropdown).not.toBeNull()
    expect(dropdown.style.display).toBe('none')
  })

  it('删除 ``` 后下拉移除', () => {
    typeText(view, '```')
    expect(document.querySelector('.velo-lang-dropdown')).not.toBeNull()
    // 删除所有字符
    view.dispatch(view.state.tr.delete(1, 4))
    expect(document.querySelector('.velo-lang-dropdown')).toBeNull()
  })
})

describe('codeBlockLangSuggest: 键盘导航', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('ArrowDown → 高亮第一项,再按 → 第二项', () => {
    typeText(view, '```')
    expect(getState(view).highlightIndex).toBe(-1)
    dispatchKey(view, 'ArrowDown')
    expect(getState(view).highlightIndex).toBe(0)
    dispatchKey(view, 'ArrowDown')
    expect(getState(view).highlightIndex).toBe(1)
  })

  it('ArrowUp 从 -1 → 最后一项(循环)', () => {
    typeText(view, '```')
    dispatchKey(view, 'ArrowUp')
    const s = getState(view)
    expect(s.highlightIndex).toBeGreaterThanOrEqual(0)
    // 应该是最后一项
    const items = document.querySelectorAll('.velo-lang-dropdown-item')
    expect(s.highlightIndex).toBe(items.length - 1)
  })

  it('高亮项有 highlighted class', () => {
    typeText(view, '```')
    dispatchKey(view, 'ArrowDown')
    const items = document.querySelectorAll('.velo-lang-dropdown-item')
    expect(items[0].classList.contains('highlighted')).toBe(true)
  })
})

describe('codeBlockLangSuggest: Enter 提交', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('有高亮 → Enter 提交选中语言', () => {
    typeText(view, '```py')
    // 第一个匹配应该是 python
    dispatchKey(view, 'ArrowDown')
    expect(getState(view).highlightIndex).toBe(0)
    dispatchKey(view, 'Enter')
    // 应转成 code_block,language = python(不是 "py")
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('code_block')
    expect(block.attrs.language).toBe('python')
  })

  it('无高亮 → Enter 回退到 codeBlockEnterCommand(用原始文本)', () => {
    typeText(view, '```python')
    // 不按 ArrowDown,highlightIndex = -1
    expect(getState(view).highlightIndex).toBe(-1)
    dispatchKey(view, 'Enter')
    // codeBlockEnterCommand 用原始文本 "python" 作为 lang
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('code_block')
    expect(block.attrs.language).toBe('python')
  })

  it('无高亮 + ```py → Enter 用原始文本 py', () => {
    typeText(view, '```py')
    dispatchKey(view, 'Enter')
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('code_block')
    expect(block.attrs.language).toBe('py')
  })

  it('空 lang + 无高亮 → Enter 用空 lang', () => {
    typeText(view, '```')
    dispatchKey(view, 'Enter')
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('code_block')
    expect(block.attrs.language).toBe('')
  })
})

describe('codeBlockLangSuggest: Escape', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('Escape → 下拉关闭,文本保留', () => {
    typeText(view, '```python')
    expect(document.querySelector('.velo-lang-dropdown')).not.toBeNull()
    dispatchKey(view, 'Escape')
    expect(document.querySelector('.velo-lang-dropdown')).toBeNull()
    // 文本保留
    expect(view.state.doc.firstChild!.textContent).toBe('```python')
  })

  it('Escape 后再输入 → 下拉恢复', () => {
    typeText(view, '```p')
    dispatchKey(view, 'Escape')
    expect(document.querySelector('.velo-lang-dropdown')).toBeNull()
    // 再输入一个字符
    typeText(view, 'y')
    expect(document.querySelector('.velo-lang-dropdown')).not.toBeNull()
  })
})

describe('codeBlockLangSuggest: 点击选择', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('点击候选项 → 提交该语言', () => {
    typeText(view, '```py')
    const items = document.querySelectorAll('.velo-lang-dropdown-item')
    expect(items.length).toBeGreaterThan(0)
    // 点击第一个匹配项(应该是 python)
    const item = items[0] as HTMLElement
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('code_block')
    // 第一个匹配 py 的应该是 python
    expect(block.attrs.language).toBe('python')
  })
})
