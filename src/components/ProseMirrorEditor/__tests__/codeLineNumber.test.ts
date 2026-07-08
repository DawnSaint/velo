// WYSIWYG code_block 行号 plugin 测试(重构为 sticky widget)。
//
// 测例覆盖主要路径:
// 1. enabled=false → 无 .velo-code-lineno DOM
// 2. enabled=true + code_block 3 行 → 3 个 .velo-code-lineno,文本 1/2/3
// 3. 切 lang 不影响行号(行号数 = 行数,与 lang 无关)
// 4. mermaid code_block → 无行号
// 5. 空 code_block(无内容)→ 无行号
// 6. 跨多个 code_block → 每个独立行号,分别从 1 开始
// 7. docChanged 在 code_block 内加 1 行 → 重建 widget(行数从 3 变 4)
// 8. tr.setMeta(lineNumbersKey, { enabled: false }) → 行号消失
// 9. dark 模式 <html class="dark"> → 行号颜色由 var(--shiki-light) 翻面
//    到 var(--shiki-dark)(CSS cascade,ProseMirror / plugin 不参与)

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import { codeLineNumberPlugin, lineNumbersKey } from '../nodes/CodeLineNumberWidget'

// ============================================================
//  工具:起一个最小可工作的 EditorView,只挂 line number plugin
// ============================================================

function makeView(initialMd: string, enabled = false): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(initialMd, schema),
    plugins: [codeLineNumberPlugin],
  })
  const view = new EditorView(container, { state })
  // 通过 setMeta 把 enabled 翻到目标值(模拟"用户在设置面板打开开关")
  if (enabled !== false) {
    view.dispatch(view.state.tr.setMeta(lineNumbersKey, { enabled }))
  }
  return view
}

function findCodeBlockPos(view: EditorView): number {
  let pos = -1
  view.state.doc.descendants((node, p) => {
    if (node.type.name === 'code_block' && pos === -1) {
      pos = p
      return false
    }
    return true
  })
  return pos
}

// ============================================================
//  Setup
// ============================================================

beforeEach(() => {
  document.documentElement.classList.remove('dark')
  // plugin state.init 同步读 store.showCodeLineNumbers,需要 active pinia
  setActivePinia(createPinia())
})

afterEach(() => {
  // 清理所有 view(jsdom 不会自动 dispose)
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    const parent = el.parentElement
    if (parent) parent.remove()
  })
})

// ============================================================
//  测例
// ============================================================

describe('codeLineNumberPlugin', () => {
  it('1. enabled=false → 无 .velo-code-lineno DOM', () => {
    const view = makeView('```js\nconst x = 1\nconst y = 2\n```', false)
    expect(view.dom.querySelector('.velo-code-lineno')).toBeNull()
    view.destroy()
  })

  it('2. enabled=true + code_block 3 行 → 3 个 .velo-code-lineno,文本 1/2/3', () => {
    const view = makeView('```js\nconst x = 1\nconst y = 2\nconst z = 3\n```', true)
    const linenos = view.dom.querySelectorAll('.velo-code-lineno')
    expect(linenos.length).toBe(3)
    expect(linenos[0]?.textContent).toBe('1')
    expect(linenos[1]?.textContent).toBe('2')
    expect(linenos[2]?.textContent).toBe('3')
    view.destroy()
  })

  it('3. 切 lang 不影响行号(行号数 = 行数,与 lang 无关)', () => {
    // 用 python:3 行
    const view = makeView('```python\nx = 1\ny = 2\nz = 3\n```', true)
    expect(view.dom.querySelectorAll('.velo-code-lineno').length).toBe(3)
    // 切 lang 到 rust(同样 3 行,行数应保持 3)
    const pos = findCodeBlockPos(view)
    view.dispatch(view.state.tr.setNodeAttribute(pos, 'language', 'rust'))
    expect(view.dom.querySelectorAll('.velo-code-lineno').length).toBe(3)
    view.destroy()
  })

  it('4. mermaid code_block → 无行号', () => {
    const view = makeView('```mermaid\ngraph TD\n  A --> B\n  C --> D\n```', true)
    expect(view.dom.querySelector('.velo-code-lineno')).toBeNull()
    view.destroy()
  })

  it('5. 空 code_block(无内容)→ 无行号', () => {
    // ```\n``` 是空 fenced code,parse 后 code_block 内部 text 长度 0
    const view = makeView('```\n```', true)
    expect(view.dom.querySelector('.velo-code-lineno')).toBeNull()
    view.destroy()
  })

  it('6. 跨多个 code_block → 每个独立行号,分别从 1 开始', () => {
    const md = '```js\nconst a = 1\n```\n\n```py\nx = 1\nx = 2\nx = 3\n```'
    const view = makeView(md, true)
    const linenos = view.dom.querySelectorAll('.velo-code-lineno')
    // 第一个 code_block:1 行 → 1 个行号
    // 第二个 code_block:3 行 → 3 个行号
    expect(linenos.length).toBe(4)
    // 第一个 code_block 的行号
    expect(linenos[0]?.textContent).toBe('1')
    // 第二个 code_block 的行号从 1 重新开始
    expect(linenos[1]?.textContent).toBe('1')
    expect(linenos[2]?.textContent).toBe('2')
    expect(linenos[3]?.textContent).toBe('3')
    view.destroy()
  })

  it('7. docChanged 在 code_block 内加 1 行 → 重建 widget(行数从 3 变 4)', () => {
    const view = makeView('```js\nconst x = 1\nconst y = 2\nconst z = 3\n```', true)
    expect(view.dom.querySelectorAll('.velo-code-lineno').length).toBe(3)
    // 在 block 末尾前插入一个换行(让 lineCount 从 3 变 4)
    const pos = findCodeBlockPos(view)
    const blockEnd = pos + view.state.doc.nodeAt(pos)!.nodeSize - 1
    view.dispatch(view.state.tr.insertText('\n', blockEnd - 1))
    // key 变 → ProseMirror 重建 widget → 新行号 DOM
    expect(view.dom.querySelectorAll('.velo-code-lineno').length).toBe(4)
    view.destroy()
  })

  it('8. tr.setMeta(lineNumbersKey, { enabled: false }) → 行号消失', () => {
    const view = makeView('```js\nconst x = 1\n```', true)
    expect(view.dom.querySelector('.velo-code-lineno')).not.toBeNull()
    // 翻回关闭
    view.dispatch(view.state.tr.setMeta(lineNumbersKey, { enabled: false }))
    expect(view.dom.querySelector('.velo-code-lineno')).toBeNull()
    view.destroy()
  })

  it('9. dark 模式 <html class="dark"> → 行号颜色由 var(--shiki-light) 翻面到 var(--shiki-dark)', () => {
    // 行号 widget 走纯 CSS cascade,inline style 不写 color(颜色全部走 var() 切换);
    // jsdom 不解析 stylesheet,getComputedStyle 不会真切色,改测 inline style 验证:
    // widget 自身 inline style 只含 contentEditable(JS 设),颜色由 SCSS 接管。
    const view = makeView('```js\nconst x = 1\n```', true)
    const lineno = view.dom.querySelector('.velo-code-lineno') as HTMLElement | null
    expect(lineno).not.toBeNull()
    // widget DOM 由 Decoration.widget factory 创建,只设 className + textContent +
    // contentEditable,不写 color inline style(颜色由 SCSS 接管)
    const inline = lineno!.getAttribute('style') || ''
    expect(inline.includes('color:')).toBe(false)
    // 切 dark:ProseMirror / plugin 不参与,但确保不崩
    document.documentElement.classList.add('dark')
    view.dispatch(view.state.tr)
    expect(view.dom.querySelector('.velo-code-lineno')).not.toBeNull()
    view.destroy()
  })

  it('10. 空 code_block(仅 1 行无内容)→ 有 1 个行号(空行也编号)', () => {
    // ```\n \n``` 是 1 行空格的 code_block → 1 行,有行号 "1"
    const view = makeView('```\n \n```', true)
    const linenos = view.dom.querySelectorAll('.velo-code-lineno')
    expect(linenos.length).toBe(1)
    expect(linenos[0]?.textContent).toBe('1')
    view.destroy()
  })
})
