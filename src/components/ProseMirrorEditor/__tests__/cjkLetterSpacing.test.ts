// CJK 字间距装饰 plugin 测试(Phase 1)
//
// 测例覆盖:
// 1. enabled=false → 无 .cjk-spacing DOM
// 2. enabled=true + 纯 CJK 段落 → 有 .cjk-spacing span
// 3. CJK + Latin 混排 → 只 CJK 字符段被包裹,Latin 不受影响
// 4. CJK 标点分段 → CJK 标点也算 CJK 字符(全角标点在 \uFF00-\uFFEF 范围)
// 5. 多段落 → 每段独立扫描
// 6. 代码块内 CJK → 不添加装饰(code_block 子树跳过)
// 7. 增量更新:在 CJK 段中间插入字符 → 装饰正确更新
// 8. 增量更新:删除 CJK 段部分字符 → 装饰正确更新
// 9. setMeta(cjkSpacingKey, { enabled: false }) → 装饰消失
// 10. setMeta(cjkSpacingKey, { enabled: true }) → 装饰出现

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import { cjkLetterSpacingPlugin, cjkSpacingKey } from '../plugins/cjkLetterSpacing'

// ============================================================
//  工具
// ============================================================

function makeView(initialMd: string, enabled = false): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(initialMd, schema),
    plugins: [cjkLetterSpacingPlugin],
  })
  const view = new EditorView(container, { state })
  if (enabled) {
    view.dispatch(view.state.tr.setMeta(cjkSpacingKey, { enabled: true }))
  }
  return view
}

function cjkSpans(view: EditorView): HTMLElement[] {
  return Array.from(view.dom.querySelectorAll('.cjk-spacing'))
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

describe('cjkLetterSpacingPlugin', () => {
  it('1. enabled=false → 无 .cjk-spacing DOM', () => {
    const view = makeView('这是一段中文', false)
    expect(cjkSpans(view).length).toBe(0)
    view.destroy()
  })

  it('2. enabled=true + 纯 CJK 段落 → 有 .cjk-spacing span', () => {
    const view = makeView('这是一段中文', true)
    const spans = cjkSpans(view)
    expect(spans.length).toBeGreaterThan(0)
    // 整个 CJK 文本应被一个连续 span 包裹
    expect(spans[0]!.textContent).toBe('这是一段中文')
    view.destroy()
  })

  it('3. CJK + Latin 混排 → 只 CJK 字符段被包裹', () => {
    const view = makeView('这是 English 中文 mixed', true)
    const spans = cjkSpans(view)
    expect(spans.length).toBe(2) // 「这是」和「中文」各一个 span
    expect(spans[0]!.textContent).toBe('这是')
    expect(spans[1]!.textContent).toBe('中文')
    view.destroy()
  })

  it('4. CJK 标点分段 → 全角标点也在 CJK 范围内,连续 CJK 标点+汉字一个 span', () => {
    const view = makeView('你好，世界。', true)
    const spans = cjkSpans(view)
    // 全角逗号 \uFF0C 和句号 \u3002 都在 CJK 范围内 → 整段一个 span
    expect(spans.length).toBe(1)
    expect(spans[0]!.textContent).toBe('你好，世界。')
    view.destroy()
  })

  it('5. 多段落 → 每段独立扫描', () => {
    const md = '第一段中文\n\n第二段中文'
    const view = makeView(md, true)
    const spans = cjkSpans(view)
    expect(spans.length).toBe(2)
    expect(spans[0]!.textContent).toBe('第一段中文')
    expect(spans[1]!.textContent).toBe('第二段中文')
    view.destroy()
  })

  it('6. 代码块内 CJK → 不添加装饰', () => {
    const md = '```js\n// 中文注释\nconst x = 1\n```'
    const view = makeView(md, true)
    const spans = cjkSpans(view)
    expect(spans.length).toBe(0)
    view.destroy()
  })

  it('7. 增量更新:在 CJK 段中间插入字符 → 装饰正确更新', () => {
    const view = makeView('你好', true)
    expect(cjkSpans(view)[0]!.textContent).toBe('你好')

    // 在「你」和「好」之间插入「们」
    const pos = 1 // paragraph 内容偏移: pos 0 = paragraph start, pos 1 = before 「你」
    // 找到精确位置:doc 第一个 paragraph,内容从 pos+1 开始
    const paraStart = 1 // <p> 的内容起始 pos
    view.dispatch(view.state.tr.insertText('们', paraStart + 1)) // 插入到「你」之后

    const spans = cjkSpans(view)
    expect(spans.length).toBe(1)
    expect(spans[0]!.textContent).toBe('你们好')
    view.destroy()
  })

  it('8. 增量更新:删除 CJK 段部分字符 → 装饰正确更新', () => {
    const view = makeView('你好世界', true)
    expect(cjkSpans(view)[0]!.textContent).toBe('你好世界')

    // 删除「好世」:pos 1 = 「你」之前,pos 2 = 「好」之前,pos 4 = 「界」之前
    // tr.delete(2, 4) 删除位置 2~4 之间的字符 = 「好世」
    const paraStart = 1
    view.dispatch(view.state.tr.delete(paraStart + 1, paraStart + 3))

    const spans = cjkSpans(view)
    expect(spans.length).toBe(1)
    expect(spans[0]!.textContent).toBe('你界')
    view.destroy()
  })

  it('9. setMeta({ enabled: false }) → 装饰消失', () => {
    const view = makeView('这是一段中文', true)
    expect(cjkSpans(view).length).toBeGreaterThan(0)

    view.dispatch(view.state.tr.setMeta(cjkSpacingKey, { enabled: false }))
    expect(cjkSpans(view).length).toBe(0)
    view.destroy()
  })

  it('10. setMeta({ enabled: true }) → 装饰出现', () => {
    const view = makeView('这是一段中文', false)
    expect(cjkSpans(view).length).toBe(0)

    view.dispatch(view.state.tr.setMeta(cjkSpacingKey, { enabled: true }))
    expect(cjkSpans(view).length).toBeGreaterThan(0)
    view.destroy()
  })
})
