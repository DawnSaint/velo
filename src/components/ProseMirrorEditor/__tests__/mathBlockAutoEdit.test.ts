// 回归:`$$` + Enter 触发 math_block 自动进 edit 后,editor 不应被 katex 异步
// render 覆盖。
//
// 背景(commit 46c00e3 之后):
//   1. dollarEnterCmd 创建 math_block 并塞进 autoEditMathBlocks WeakSet
//   2. nodeView 工厂同步跑 showDisplay() → renderKatex(...) —— 这次调用是
//      async,因为 getKatex() lazy load 整个包
//   3. 工厂检查 WeakSet 后排 setTimeout(startEdit, 0)
//   4. 在 katex 包第一次加载时,import() 是真异步 I/O,setTimeout(0) 的
//      macrotask 会**先于** getKatex() resolve 触发 → startEdit 同步挂上
//      editor(给 dom 加 is-editing class、清空 innerHTML、appendChild editor)
//   5. 等 katex 加载完,renderKatex 继续往下走,katex.render(value, dom, ...)
//      直接写到 dom —— **覆盖刚挂好的 editor**
//   6. textarea.focus() 排队但 textarea 已经被覆盖,用户感知"输入框出现 →
//      立即消失,光标也没了",源码模式里看到两行相邻 `$$`,WYSIWYG 死结点
//
// 修复:renderKatex 在 await 前后各判一次 `is-editing || !isConnected`,
// 任一不通过就放弃写入 —— editor 已挂上就 bailing,katex 输出不再覆盖。
//
// 本测试直接复现完整链路(模拟 dollarEnterCmd),断言最终 dom 里 textarea
// 还在、is-editing class 还在。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { mathEditPlugin, triggerNextMathBlockAutoEdit } from '../nodes/MathNodeViews'

function makeViewWithDollarDollar(): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  // doc: [paragraph("$$")] —— selection 默认在 doc 末尾(= "$$" 之后)
  const state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('$$')]),
    ]),
    plugins: [mathEditPlugin],
  })
  const view = new EditorView(container, { state })
  // 显式把 selection 拉到 "$$" 末尾,对应 dollarEnterCmd 里的 $from.pos
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)))
  return view
}

beforeEach(() => {
  // 清理前一轮挂到 body 上的 view
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    el.parentElement?.remove()
  })
})

afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    el.parentElement?.remove()
  })
})

describe('math_block $$+Enter 自动进 edit', () => {
  it('katex 异步 render 不会覆盖刚挂上的 editor(textarea + is-editing 都在)', async () => {
    const view = makeViewWithDollarDollar()

    // 复现 dollarEnterCmd 的关键三步:
    //   1) 创建 math_block
    //   2) 塞进 WeakSet,NodeView 工厂识别到要 autoEdit
    //   3) tr.replaceWith 把 "$$" 替换成 math_block
    const $from = view.state.selection.$from
    const mathBlock = schema.nodes.math_block.create({ value: '' })
    triggerNextMathBlockAutoEdit(mathBlock)
    view.dispatch(view.state.tr.replaceWith($from.start(), $from.pos, mathBlock))

    // 给 setTimeout(0) + katex chunk 异步加载足够时间。
    // katex 包首屏懒加载,test 环境下首次 import 通常 <100ms;
    // 留 200ms 兜底,避免 CI 上偶发加载慢导致 flake。
    await new Promise(r => setTimeout(r, 200))

    const mathBlockEl = view.dom.querySelector('.math-block-node') as HTMLElement | null
    expect(mathBlockEl).not.toBeNull()

    // 核心断言:editor 还在(没被 katex.render 覆盖)
    expect(mathBlockEl!.classList.contains('is-editing')).toBe(true)
    const textarea = mathBlockEl!.querySelector('textarea')
    expect(textarea).not.toBeNull()

    // 反向断言:dom 里不该有 katex 的 .katex / .katex-display 之类输出节点
    // (katex.render 空字符串也会输出一个空的 .katex span,被覆盖就会有)
    expect(mathBlockEl!.querySelector('.katex')).toBeNull()

    view.destroy()
  })

  it('编辑态下输入事件不应被 PM 当成 tr.insertText 把 math_block 替换掉', () => {
    // 复现用户报的第二段:输入框出现后敲字符 → math 节点被替换消失。
    // 根因:math_block 的 NodeView 没有 stopEvent,PM 的 eventBelongsToView
    // 对 beforeinput / input / keydown 一路放行 → 默认 handleTextInput 走
    // tr.insertText(text, from, to) → math_block 当 NodeSelection 被替换。
    // 修复:NodeView.stopEvent 在 editing 态对输入事件返回 true。
    const view = makeViewWithDollarDollar()
    const $from = view.state.selection.$from
    const mathBlock = schema.nodes.math_block.create({ value: '' })
    triggerNextMathBlockAutoEdit(mathBlock)
    view.dispatch(view.state.tr.replaceWith($from.start(), $from.pos, mathBlock))

    // 等 setTimeout(startEdit) 跑完,math_block 进入编辑态(挂上 textarea)
    // 用同步的 microtask + macrotask 轮询到 is-editing
    const start = Date.now()
    const waitFor = () => {
      const el = view.dom.querySelector('.math-block-node') as HTMLElement | null
      if (el && el.classList.contains('is-editing') && el.querySelector('textarea')) return
      if (Date.now() - start > 500) throw new Error('startEdit 未在 500ms 内完成')
      setTimeout(waitFor, 5)
    }
    // 同步 flush 一轮 setTimeout
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        waitFor()
        const mathBlockEl = view.dom.querySelector('.math-block-node') as HTMLElement
        const textarea = mathBlockEl.querySelector('textarea') as HTMLTextAreaElement
        expect(textarea).not.toBeNull()

        // 记录:敲字符前 doc 里 math_block 还在
        let mathCount = 0
        view.state.doc.descendants((n) => {
          if (n.type.name === 'math_block') mathCount++
          return true
        })
        expect(mathCount).toBe(1)

        // 直接在 textarea 上派发 beforeinput + input,模拟用户敲 'x'
        // (绕过 jsdom 的 IME / 焦点行为,只测 PM 事件链这一段)
        const beforeInput = new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: 'x',
        })
        textarea.dispatchEvent(beforeInput)

        const inputEvt = new InputEvent('input', { bubbles: true, data: 'x' })
        textarea.dispatchEvent(inputEvt)

        // 核心断言:doc 里 math_block 还在,没被替换掉
        let mathCountAfter = 0
        view.state.doc.descendants((n) => {
          if (n.type.name === 'math_block') mathCountAfter++
          return true
        })
        expect(mathCountAfter).toBe(1)

        view.destroy()
        resolve()
      }, 50)
    })
  })
})

// ============================================================
//  空 value 渲染占位的回归
// ============================================================
//
// 复现:`$$`+Enter 出 math_block 编辑框 → 用户不输入直接 blur →
// 旧实现走 renderKatex('' → ' '),katex.render 出高度趋近 0 的
// katex-display,WYSIWYG 里看起来节点"消失",源码模式反而看到两行
// `$$`(即 remark-math 序列化空 math block 的形态)。
//
// 修复:showDisplay 在 value 为空时改渲染一个可见占位 (.math-empty-placeholder),
// 走 .math-node 上已有的 click listener 重新进 startEdit。

describe('math 空 value blur 后应保留可见占位', () => {
  function makeViewWithEmptyBlock(): EditorView {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        schema.node('math_block', { value: '' }),
      ]),
      plugins: [mathEditPlugin],
    })
    return new EditorView(container, { state })
  }

  it('空 math_block blur 后渲染 .math-empty-placeholder(不走 katex)', async () => {
    const view = makeViewWithEmptyBlock()
    // 等 factory 同步跑完 + showDisplay 的 renderKatex 完成首屏
    await new Promise(r => setTimeout(r, 50))

    const mathBlockEl = view.dom.querySelector('.math-block-node') as HTMLElement | null
    expect(mathBlockEl).not.toBeNull()

    // 核心断言:渲染了占位,而不是一个空 katex-display
    const placeholder = mathBlockEl!.querySelector('.math-empty-placeholder')
    expect(placeholder).not.toBeNull()
    expect(mathBlockEl!.querySelector('.katex')).toBeNull()

    view.destroy()
  })

  it('空 math_block 渲染后点击 placeholder 应重新进编辑态', async () => {
    const view = makeViewWithEmptyBlock()
    await new Promise(r => setTimeout(r, 50))

    const mathBlockEl = view.dom.querySelector('.math-block-node') as HTMLElement
    expect(mathBlockEl.querySelector('.math-empty-placeholder')).not.toBeNull()

    // 模拟用户点击占位(NodeView 在 dom 上挂 click listener → startEdit)
    mathBlockEl.querySelector('.math-empty-placeholder')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 20))

    // 进编辑态后:textarea 挂上 + is-editing class + 占位消失
    expect(mathBlockEl.classList.contains('is-editing')).toBe(true)
    expect(mathBlockEl.querySelector('textarea')).not.toBeNull()
    expect(mathBlockEl.querySelector('.math-empty-placeholder')).toBeNull()

    view.destroy()
  })

  it('有内容的 math_block blur 后仍走 katex 渲染(占位逻辑不影响正常路径)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        schema.node('math_block', { value: 'x^2' }),
      ]),
      plugins: [mathEditPlugin],
    })
    const view = new EditorView(container, { state })
    await new Promise(r => setTimeout(r, 50))

    const mathBlockEl = view.dom.querySelector('.math-block-node') as HTMLElement
    // 有内容 → 走 katex,不应有占位
    expect(mathBlockEl.querySelector('.math-empty-placeholder')).toBeNull()
    expect(mathBlockEl.querySelector('.katex')).not.toBeNull()

    view.destroy()
  })
})
