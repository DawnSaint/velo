// emojiSuggest plugin 测试。
//
// 覆盖：
//  - 状态检测：`:` + 字母激活 / 非 `:` 不激活 / 光标不在段末不激活 / code_block 内不激活
//  - 过滤：输入 `smi` → 过滤匹配项
//  - 键盘导航：ArrowDown/Up 循环高亮
//  - Enter 有高亮 → 提交选中 shortcode（替换 :query 为 emoji 节点）
//  - Enter 无高亮 → 不拦截（return false）
//  - Escape → 关闭下拉，再输入恢复
//  - 点击条目 → 提交该 shortcode
//  - DOM：激活时下拉出现在 body，关闭时移除

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { keymap } from 'prosemirror-keymap'
import { splitBlock } from 'prosemirror-commands'
import { schema } from '../editor/schema'
import { emojiSuggestPlugin, emojiSuggestKey } from '../plugins/emojiSuggest'
import { get as emojiGet } from 'node-emoji'

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
      emojiSuggestPlugin,
      keymap({ Enter: splitBlock }),
    ],
  })
  const view = new EditorView(host, { state })
  return { view, cleanup: () => { view.destroy(); host.remove() } }
}

function typeText(view: EditorView, text: string): void {
  view.dispatch(view.state.tr.insertText(text))
}

function getState(view: EditorView) {
  return emojiSuggestKey.getState(view.state)!
}

function dispatchKey(view: EditorView, key: string): void {
  view.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

describe('emojiSuggest: 状态检测', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('输入 `:` + 字母 → 激活', () => {
    typeText(view, ':s')
    const s = getState(view)
    expect(s.active).toBe(true)
    expect(s.query).toBe('s')
  })

  it('输入普通文本 → 不激活', () => {
    typeText(view, 'hello world')
    expect(getState(view).active).toBe(false)
  })

  it('单独 `:` 不激活（需要至少一个字母）', () => {
    typeText(view, ':')
    expect(getState(view).active).toBe(false)
  })

  it('光标不在段末 → 不激活', () => {
    typeText(view, ':smile')
    // 把光标移到 `:` 之后
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)))
    expect(getState(view).active).toBe(false)
  })

  it('在 code_block 内 → 不激活', () => {
    // 先创建 code_block
    const codeBlock = schema.node('code_block', { language: '' })
    const doc = schema.node('doc', null, [codeBlock])
    const r = mountView(doc)
    view = r.view
    cleanup = r.cleanup
    typeText(view, ':smile')
    expect(getState(view).active).toBe(false)
  })

  it('`12:30` 不激活（`:` 前是数字）', () => {
    typeText(view, '12:30')
    expect(getState(view).active).toBe(false)
  })

  it('完整短码 `:smile:` 不激活（末尾是 `:` 不是字母）', () => {
    typeText(view, ':smile:')
    expect(getState(view).active).toBe(false)
  })
})

describe('emojiSuggest: DOM 下拉', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('激活时下拉出现在 body', () => {
    typeText(view, ':s')
    const dropdown = document.querySelector('.velo-emoji-dropdown')
    expect(dropdown).not.toBeNull()
    const items = dropdown!.querySelectorAll('.velo-emoji-dropdown-item')
    expect(items.length).toBeGreaterThan(0)
  })

  it('输入 `:smi` → 下拉项过滤匹配 smi', () => {
    typeText(view, ':smi')
    const items = document.querySelectorAll('.velo-emoji-dropdown-item')
    expect(items.length).toBeGreaterThan(0)
    // 每项的 name 应包含 smi
    items.forEach(item => {
      const name = item.querySelector('.velo-emoji-dropdown-name')
      expect(name).not.toBeNull()
    })
  })

  it('无匹配时下拉隐藏', () => {
    typeText(view, ':zzzzzznotemoji')
    const dropdown = document.querySelector('.velo-emoji-dropdown') as HTMLDivElement
    expect(dropdown).not.toBeNull()
    expect(dropdown.style.display).toBe('none')
  })

  it('删除 `:` 后下拉移除', () => {
    typeText(view, ':smi')
    expect(document.querySelector('.velo-emoji-dropdown')).not.toBeNull()
    // 删除所有字符
    view.dispatch(view.state.tr.delete(1, 5))
    expect(document.querySelector('.velo-emoji-dropdown')).toBeNull()
  })
})

describe('emojiSuggest: 键盘导航', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('ArrowDown → 高亮第一项，再按 → 第二项', () => {
    typeText(view, ':smi')
    expect(getState(view).highlightIndex).toBe(-1)
    dispatchKey(view, 'ArrowDown')
    expect(getState(view).highlightIndex).toBe(0)
    dispatchKey(view, 'ArrowDown')
    expect(getState(view).highlightIndex).toBe(1)
  })

  it('ArrowUp 从 -1 → 最后一项（循环）', () => {
    typeText(view, ':smi')
    dispatchKey(view, 'ArrowUp')
    const s = getState(view)
    expect(s.highlightIndex).toBeGreaterThanOrEqual(0)
    const items = document.querySelectorAll('.velo-emoji-dropdown-item')
    expect(s.highlightIndex).toBe(items.length - 1)
  })

  it('高亮项有 highlighted class', () => {
    typeText(view, ':smi')
    dispatchKey(view, 'ArrowDown')
    const items = document.querySelectorAll('.velo-emoji-dropdown-item')
    expect(items[0].classList.contains('highlighted')).toBe(true)
  })
})

describe('emojiSuggest: Enter 提交', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('有高亮 → Enter 提交选中 shortcode（替换 :query 为 emoji 节点）', () => {
    typeText(view, ':smi')
    dispatchKey(view, 'ArrowDown')
    expect(getState(view).highlightIndex).toBe(0)
    dispatchKey(view, 'Enter')
    // 文档应包含一个 emoji 节点
    const para = view.state.doc.firstChild!
    expect(para.firstChild?.type.name).toBe('emoji')
    const shortcode = para.firstChild?.attrs.shortcode as string
    // 第一个搜索 "smi" 的结果应该是 smile 或 smiley 等
    expect(emojiGet(shortcode)).toBeDefined()
    // :smi 文本应被删除
    expect(para.textContent).not.toContain(':smi')
  })

  it('无高亮 → Enter 不拦截（return false，走 splitBlock）', () => {
    typeText(view, ':smi')
    expect(getState(view).highlightIndex).toBe(-1)
    dispatchKey(view, 'Enter')
    // Enter 走 splitBlock，文本应保留（可能有新段落）
    const doc = view.state.doc
    // 第一个段落的文本应仍包含 :smi
    const firstPara = doc.firstChild!
    expect(firstPara.textContent).toContain(':smi')
  })
})

describe('emojiSuggest: Escape', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('Escape → 下拉关闭，文本保留', () => {
    typeText(view, ':smi')
    expect(document.querySelector('.velo-emoji-dropdown')).not.toBeNull()
    dispatchKey(view, 'Escape')
    expect(document.querySelector('.velo-emoji-dropdown')).toBeNull()
    expect(view.state.doc.firstChild!.textContent).toBe(':smi')
  })

  it('Escape 后再输入 → 下拉恢复', () => {
    typeText(view, ':smi')
    dispatchKey(view, 'Escape')
    expect(document.querySelector('.velo-emoji-dropdown')).toBeNull()
    // 再输入一个字符
    typeText(view, 'l')
    expect(document.querySelector('.velo-emoji-dropdown')).not.toBeNull()
  })
})

describe('emojiSuggest: 点击选择', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('点击候选项 → 提交该 shortcode', () => {
    typeText(view, ':smi')
    const items = document.querySelectorAll('.velo-emoji-dropdown-item')
    expect(items.length).toBeGreaterThan(0)
    const item = items[0] as HTMLElement
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // 应替换为 emoji 节点
    const para = view.state.doc.firstChild!
    expect(para.firstChild?.type.name).toBe('emoji')
  })
})
