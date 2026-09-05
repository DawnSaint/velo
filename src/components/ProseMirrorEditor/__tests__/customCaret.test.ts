// 自绘 caret 插件回归测试(v0.7.3)。
//
// 关注路径:
//  1. 紧贴 fold_placeholder 的非文本位置,自绘 caret 必须取"文本边"矩形
//     (em-square 高度,纵向与文本对齐),不能取 atom 的大 line-box 矩形 —— 否则
//     在 heading 大 line-height 下 caret 漂到行上方(bug 2)。
//  2. 程序化把光标移到文本位置后 resetCustomCaret → overlay 隐藏,不残留旧位置
//     (bug 1:避免 fake caret "卡"在标题后)。
//  3. coordsAtPos 抛错时 sync 不抛、overlay 隐藏(try/catch 兜底,防卡死)。
//
// jsdom 无真实布局,故 mock coordsAtPos / domAtPos / canvas 字体度量 /
// getComputedStyle 给出可控矩形,直接验证 sync 的候选选取与定位结果。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { customCaretPlugin, resetCustomCaret } from '../plugins/customCaret'

const origGetContext = (HTMLCanvasElement.prototype as any).getContext
const origGetComputedStyle = window.getComputedStyle

beforeAll(() => {
  // jsdom 无 canvas 度量 → mock 出 em-square = 34 的字体度量(F)
  ;(HTMLCanvasElement.prototype as any).getContext = () => ({
    font: '',
    measureText: () => ({ fontBoundingBoxAscent: 28, fontBoundingBoxDescent: 6 }),
  })
  // 让 getComputedStyle 返回可控的 heading 度量(line-height 44.8 = h2 1.75×25.6)
  window.getComputedStyle = (() => ({
    lineHeight: '44.8px',
    fontSize: '25.6px',
    fontStyle: 'normal',
    fontWeight: '400',
    fontFamily: 'sans-serif',
    display: 'inline',
    position: 'static',
  })) as any
})

afterAll(() => {
  ;(HTMLCanvasElement.prototype as any).getContext = origGetContext
  window.getComputedStyle = origGetComputedStyle
})

function makeView() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  // heading 内:文本 "A" + 真实 fold_placeholder 内联 atom(heading content = inline*)
  const doc = schema.node('doc', null, [
    schema.node('heading', { level: 2 }, [
      schema.text('A'),
      schema.nodes.fold_placeholder.create(),
    ]),
  ])
  const state = EditorState.create({ schema, doc, plugins: [customCaretPlugin] })
  return new EditorView(container, { state })
}

afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    el.parentElement?.remove()
  })
})

describe('customCaret (v0.7.3)', () => {
  it('紧贴 fold_placeholder 的非文本位置:shrink 到 em-square,不漂到行上方(bug 2)', () => {
    const view = makeView()
    view.hasFocus = () => true
    // 光标放到 placeholder 前(pos 2)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)))

    // mock 几何:pos 2(占位符前)= atom 大盒(line box 高度 44.8, top=100)
    // → shrink 到 em-square(34),纵向居中:top = 100 + (44.8 - 34) / 2 = 105.4
    view.coordsAtPos = (() => ({ left: 50, right: 56, top: 100, bottom: 144.8 })) as any
    view.domAtPos = (() => {
      const heading = view.dom.querySelector('h2')!
      // offset=1 → childNodes[1] = placeholder 元素(非文本)→ 走非文本接管分支
      return { node: heading, offset: 1 } as any
    }) as any

    resetCustomCaret(view) // 同步重算

    const caret = view.dom.parentNode!.querySelector('.velo-fake-caret') as HTMLElement
    expect(caret).not.toBeNull()
    expect(caret.style.display).toBe('block')
    // 关键:height = em-square(34),而非 line-box(44.8)→ caret 不再"明显更高"
    expect(caret.style.height).toBe('34px')
    // shrink 居中:top = 100 + (44.8 - 34) / 2 = 105.4
    expect(caret.style.top).toBe('105.4px')
    view.destroy()
  })

  it('程序化把光标移到文本位置后 resetCustomCaret → overlay 隐藏(不残留,bug 1)', () => {
    const view = makeView()
    view.hasFocus = () => true
    // 先在非文本位置(pos 2)画一次 fake caret,模拟"卡在标题后"
    view.coordsAtPos = (() => ({ left: 50, right: 56, top: 100, bottom: 144.8 })) as any
    view.domAtPos = (() => ({ node: view.dom.querySelector('h2')!, offset: 1 })) as any
    resetCustomCaret(view)
    let caret = view.dom.parentNode!.querySelector('.velo-fake-caret') as HTMLElement
    expect(caret.style.display).toBe('block') // 先画出来(模拟旧状态)

    // 程序化把光标移到文本位置(pos 1 落在文本 "A" 内)
    view.domAtPos = (() => {
      const heading = view.dom.querySelector('h2')!
      return { node: heading.childNodes[0], offset: 1 } as any // 文本节点 → isTextPosition true
    }) as any
    view.coordsAtPos = (() => ({ left: 20, right: 30, top: 110, bottom: 144 })) as any
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    resetCustomCaret(view)

    caret = view.dom.parentNode!.querySelector('.velo-fake-caret') as HTMLElement
    expect(caret.style.display).toBe('none') // 文本位置应隐藏
    view.destroy()
  })

  it('coordsAtPos 抛错时 sync 不抛、overlay 隐藏(防卡死兜底)', () => {
    const view = makeView()
    view.hasFocus = () => true
    view.coordsAtPos = (() => { throw new Error('boom') }) as any
    view.domAtPos = (() => ({ node: view.dom.querySelector('h2')!, offset: 1 })) as any
    expect(() => resetCustomCaret(view)).not.toThrow()
    const caret = view.dom.parentNode!.querySelector('.velo-fake-caret') as HTMLElement
    expect(caret.style.display).toBe('none')
    view.destroy()
  })
})
