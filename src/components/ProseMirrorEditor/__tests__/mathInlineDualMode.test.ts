// 行为合约:math_inline 走 B1 范式 —— content 含 `$` 分隔符,用户可编辑 $
//
//   - content = `$x^2$` 整体(含分隔符),PM 通过 contentDOM 直接管理,光标进入可编辑 $
//   - display mode (光标在节点外):隐藏 contentDOM,仅展示 katex 渲染 → 阅读纯净
//   - edit    mode (光标在节点内):展示 contentDOM(含 $)+ katex 渲染 → 源码与预览并列
//   - 渲染层从 textContent 剥离首尾 $ 后给 katex
//   - `$` 分隔符走主题色 var(--md-primary-color)
//   - 切换由 NodeView 监听 selectionchange 触发
//   - 降级:content 不匹配 `$...$`(首尾各至少一个 $,中间非空)→ mathInlineUnwrapPlugin
//     把节点替换成普通 text,用户删一个 $ 后自动降级,可重新打 $ 再成公式
//
// jsdom 不加载项目 SCSS,所以断言 data-mode 属性 + DOM 结构,而不是 computed style。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { mathEditPlugin } from '../nodes/MathNodeViews'

/** 构造含一个 math_inline 的 view。source 是纯 LaTeX(如 'x^2'),内部包 $ 成 `$x^2$`。 */
function makeViewWithMathInline(source: string): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('See '),
        schema.node('math_inline', null, [schema.text(`$${source}$`)]),
        schema.text(' here'),
      ]),
    ]),
    plugins: [mathEditPlugin],
  })
  return new EditorView(container, { state })
}

function getMathInlineEl(view: EditorView): HTMLElement {
  const el = view.dom.querySelector('.math-inline-node') as HTMLElement | null
  if (!el) throw new Error('math-inline-node not found')
  return el
}

/** 触发一次 selectionchange 同步事件,NodeView 监听器据此更新 data-mode */
function flushSelection(view: EditorView) {
  view.dom.ownerDocument.dispatchEvent(new Event('selectionchange'))
}

function posInMathInline(view: EditorView, offsetInMath: number): number {
  // 找到 math_inline 的绝对位置,加上 content offset(content 起点 = nodePos + 1)
  let pos = -1
  view.state.doc.descendants((node, p) => {
    if (node.type.name === 'math_inline') {
      pos = p + 1 + Math.min(offsetInMath, node.content.size)
      return false
    }
    return true
  })
  if (pos < 0) throw new Error('math_inline not found in doc')
  return pos
}

beforeEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    el.parentElement?.remove()
  })
})

afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    el.parentElement?.remove()
  })
})

describe('math_inline B1 范式(content 含 $ 分隔符,可编辑)', () => {
  it('节点结构:contentDOM 含 `$x^2$`,渲染层 contenteditable=false,默认 display', () => {
    const view = makeViewWithMathInline('x^2')
    flushSelection(view)

    const el = getMathInlineEl(view)
    expect(el.dataset.mode).toBe('display')

    // 无独立 prefix/suffix 元素(B1: $ 是 contentDOM 内文本的一部分)
    expect(el.querySelector('.math-source-prefix')).toBeNull()
    expect(el.querySelector('.math-source-suffix')).toBeNull()
    expect(el.querySelector('.math-inline-source')).not.toBeNull()
    expect(el.querySelector('.math-inline-display')).not.toBeNull()

    // contentDOM 文本 = `$x^2$`(含分隔符)
    const source = el.querySelector('.math-inline-source') as HTMLElement
    expect(source.textContent).toBe('$x^2$')

    // 渲染层 contenteditable=false:防光标漂入 / IME 启动
    const display = el.querySelector('.math-inline-display') as HTMLElement
    expect(display.getAttribute('contenteditable')).toBe('false')

    view.destroy()
  })

  it('selection 移入 math_inline → 切到 edit 模式', () => {
    const view = makeViewWithMathInline('x^2')
    expect(getMathInlineEl(view).dataset.mode).toBe('display')

    // selection 移到 contentDOM 内(offset 1 = 首个 $ 之后,'x' 之前)
    const pos = posInMathInline(view, 1)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
    flushSelection(view)

    expect(getMathInlineEl(view).dataset.mode).toBe('edit')

    view.destroy()
  })

  it('selection 从 math_inline 内移出 → 回到 display 模式', () => {
    const view = makeViewWithMathInline('x^2')

    const pos = posInMathInline(view, 1)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
    flushSelection(view)
    expect(getMathInlineEl(view).dataset.mode).toBe('edit')

    // 移出(到段首"See "前)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    flushSelection(view)
    expect(getMathInlineEl(view).dataset.mode).toBe('display')

    view.destroy()
  })

  it('光标在 math_inline 末尾(紧贴尾 $ 之前)也算在节点内', () => {
    const view = makeViewWithMathInline('x^2')
    // content = `$x^2$`,offset 4 = 末尾 $ 之前
    const pos = posInMathInline(view, 4)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
    flushSelection(view)
    expect(getMathInlineEl(view).dataset.mode).toBe('edit')
    view.destroy()
  })

  it('$$x^2$$ 双 $ 也是合法行内公式(不降级)', () => {
    const view = makeViewWithMathInline('x^2')
    // 改 content 为 `$$x^2$$`
    const pos = posInMathInline(view, 0)
    view.dispatch(view.state.tr.insertText('$', pos))
    view.dispatch(view.state.tr.insertText('$', pos + 5)) // 末尾 $ 后再加一个 $
    flushSelection(view)

    // 仍是 math_inline 节点(未被降级)
    expect(view.dom.querySelector('.math-inline-node')).not.toBeNull()
    const source = getMathInlineEl(view).querySelector('.math-inline-source') as HTMLElement
    expect(source.textContent).toBe('$$x^2$$')
    view.destroy()
  })

  it('$$x$$ display 模式:katex 输入是剥 $ 后的纯 x,渲染层不出现字面 $', async () => {
    // 用户主诉:输入 $$x$$ 移开光标后,看到「$ 跟 katex 渲染的 x」——怀疑渲染层
    // 把整个 $$x$$ 当 source 喂给 katex(报错降级到 .math-error,textContent 是 source)
    // 正确行为:stripDelimiters 剥首尾 $$ 给 katex.render("x", ...),katex 成功。
    const view = makeViewWithMathInline('x')
    // 把 content 改为 $$x$$
    const pos = posInMathInline(view, 0)
    view.dispatch(view.state.tr.insertText('$', pos))
    view.dispatch(view.state.tr.insertText('$', pos + 3)) // 末尾 $ 后再加一个 $
    flushSelection(view)

    // 默认 display 态
    expect(getMathInlineEl(view).dataset.mode).toBe('display')

    // 等 katex lazy load + 渲染
    await new Promise((r) => setTimeout(r, 250))

    const display = getMathInlineEl(view).querySelector('.math-inline-display') as HTMLElement
    // display 层应包含 katex 输出,且**不含**字面 $ 字符
    expect(display.querySelector('.katex')).not.toBeNull()
    expect(display.querySelector('.math-error')).toBeNull()
    expect(display.textContent).not.toContain('$')
    view.destroy()
  })

  it('display 模式下:source 变化时渲染层仍由 PM 维护', () => {
    const view = makeViewWithMathInline('x^2')
    expect(getMathInlineEl(view).dataset.mode).toBe('display')

    // dispatch 替换 content 首字符 `$` → 仍是 `$`(模拟程序化改)。
    // 实际改 source 第 1 位(offset 1,'x' → 'y')
    const pos = posInMathInline(view, 1)
    view.dispatch(view.state.tr.insertText('y', pos, pos + 1))
    flushSelection(view)

    const source = getMathInlineEl(view).querySelector('.math-inline-source') as HTMLElement
    expect(source.textContent).toBe('$y^2$')
    view.destroy()
  })

  it('edit 模式下:源码变化时渲染层实时更新(键入后看到渲染结果)', async () => {
    const view = makeViewWithMathInline('x')

    // 移入 → edit。content=`$x$`,offset 1 = 首 $ 之后 'x' 之前
    const pos = posInMathInline(view, 1)
    // 光标放 offset 2('x' 之后,尾 $ 之前)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)))
    flushSelection(view)
    expect(getMathInlineEl(view).dataset.mode).toBe('edit')

    // 在 'x' 之后(offset 2)键入 `^2` → content 变 `$x^2$`
    view.dispatch(view.state.tr.insertText('^2', pos + 1))
    flushSelection(view)

    const source = getMathInlineEl(view).querySelector('.math-inline-source') as HTMLElement
    expect(source.textContent).toBe('$x^2$')

    // 等 katex lazy load + 重渲染
    await new Promise((r) => setTimeout(r, 250))

    const display = getMathInlineEl(view).querySelector('.math-inline-display') as HTMLElement
    expect(display.querySelector('.katex')).not.toBeNull()
    view.destroy()
  })

  it('光标在 content 末尾输入非 $ 字符 → 移到节点外,math 收起成 display', () => {
    // 用户主诉:打完 `$x$` 光标停在尾 $ 后(edit 态),继续输入别的字符应移出节点收起。
    const view = makeViewWithMathInline('x')
    // content = `$x$`,offset 3 = 尾 $ 之后(content 末尾,close tag 之前)
    const pos = posInMathInline(view, 3)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
    flushSelection(view)
    expect(getMathInlineEl(view).dataset.mode).toBe('edit')

    // 模拟用户输入空格 —— 直接调 plugin 的 handleTextInput
    // (view.dispatch(tr.insertText) 是程序化插入,不触发 handleTextInput;真实键入走 DOM input)
    const handled = (mathEditPlugin.props as any).handleTextInput(view, pos, pos, ' ')
    expect(handled).toBe(true)
    flushSelection(view)

    // 节点仍在(未被降级,content 仍 `$x$`)
    const el = view.dom.querySelector('.math-inline-node') as HTMLElement
    expect(el).not.toBeNull()
    // 光标已移出节点 → data-mode 切回 display
    expect(el.dataset.mode).toBe('display')

    // 验证光标在节点之后 + 空格已插入
    let nodePos = -1
    view.state.doc.descendants((node, p) => {
      if (node.type.name === 'math_inline') { nodePos = p; return false }
      return true
    })
    // nodeSize = 5;空格插在节点后,光标 = nodePos + 5 + 1
    expect(view.state.selection.head).toBe(nodePos + 6)
    view.destroy()
  })

  it('光标在 content 末尾输入 $ → 留在节点内(编辑分隔符,不移出)', () => {
    const view = makeViewWithMathInline('x')
    const pos = posInMathInline(view, 3)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
    flushSelection(view)
    expect(getMathInlineEl(view).dataset.mode).toBe('edit')

    // 输入 $ —— handleTextInput 不拦截,返回 false
    const handled = (mathEditPlugin.props as any).handleTextInput(view, pos, pos, '$')
    expect(handled).toBe(false)
    // data-mode 仍是 edit(光标没移出)
    expect(getMathInlineEl(view).dataset.mode).toBe('edit')
    view.destroy()
  })

  it('降级:删掉尾 $ 后 content 变 `$x^2` → 节点 unwrap 成普通 text', () => {
    const view = makeViewWithMathInline('x^2')
    expect(view.dom.querySelector('.math-inline-node')).not.toBeNull()

    // 删掉末尾 $:content `$x^2$` → `$x^2`
    const pos = posInMathInline(view, 0)
    // content size = 5(`$x^2$`),末尾 $ 在 offset 5,删除区间 [pos+4, pos+5)
    view.dispatch(view.state.tr.delete(pos + 4, pos + 5))
    flushSelection(view)

    // appendTransaction 已把 math_inline 降级 → .math-inline-node 消失
    expect(view.dom.querySelector('.math-inline-node')).toBeNull()
    view.destroy()
  })

  it('降级:content 为 `$$`(空内容)→ 节点 unwrap 成普通 text `$$`', () => {
    // 直接构造 content=`$$` 的 math_inline
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        schema.node('paragraph', null, [
          schema.text('a'),
          schema.node('math_inline', null, [schema.text('$$')]),
          schema.text('b'),
        ]),
      ]),
      plugins: [mathEditPlugin],
    })
    const view = new EditorView(container, { state })

    // 初始(未 dispatch)节点仍在 —— EditorState.create 不触发 appendTransaction
    expect(view.dom.querySelector('.math-inline-node')).not.toBeNull()

    // dispatch 一个 docChanged tr 触发 appendTransaction:`$$` 不匹配 `^\$.+\$$`
    // (中间 `.+` 要求至少 1 字符,`$$` 中间为空)→ 降级成普通 text `$$`
    view.dispatch(view.state.tr.insertText(' ', 1))
    flushSelection(view)

    // 降级后 math_inline 消失,文本变成 `a $$b`(段首插了空格 + $$ 降级)
    expect(view.dom.querySelector('.math-inline-node')).toBeNull()
    expect(view.state.doc.textContent).toBe(' a$$b')
    view.destroy()
  })
})
