// 打字机模式 plugin 测试。
//
// jsdom 无真实布局(coordsAtPos 返回 0 → 居中 delta=0 → 不滚动),故**不测居中滚动
// 本身**(测行为不测实现 + 无布局测不了,反过度测试)。测可测的契约:
// 1. setMeta 翻 enabled,getState 正确读
// 2. handleScrollToSelection 在 enabled 时返 true(抑制 PM 最小滚动)、disabled 时返 false
//    —— 这是本插件最非显然的契约,删了会让 PM 抢滚动产生抖动,留防回归
// 3. view.update() 在 enabled 下 dispatch 选区变化 tr 不抛
//
// 居中滚动的真实行为(光标恒在视口中线)依赖 WebView2 布局,归手动 / E2E 验证。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../../editor/schema'
import { fromMarkdown } from '../../editor/markdownIO'
import { typewriterModePlugin, typewriterModeKey, setTypewriterModeEnabled } from '../typewriterMode'

function makeView(initialMd: string, enabled = false): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(initialMd, schema),
    plugins: [typewriterModePlugin],
  })
  const view = new EditorView(container, { state })
  if (enabled) {
    view.dispatch(view.state.tr.setMeta(typewriterModeKey, { enabled: true }))
  }
  return view
}

/** 读 plugin spec 上挂的 handleScrollToSelection,直接调它判定返回。
 *  spec.props 方法带 this: Plugin 上下文类型,故用 .call 绑定到 plugin 实例调用。 */
function scrollHandler(view: EditorView): boolean {
  const fn = typewriterModePlugin.spec.props?.handleScrollToSelection
  return typeof fn === 'function' ? fn.call(typewriterModePlugin, view) : false
}

beforeEach(() => {
  document.body.innerHTML = ''
  // 重置模块级镜像,防上一个用例的 setTypewriterModeEnabled 污染本用例的 state.init
  setTypewriterModeEnabled(false)
})

afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    const parent = el.parentElement
    if (parent) parent.remove()
  })
})

describe('typewriterModePlugin', () => {
  it('disabled 时 getState.enabled=false 且 handleScrollToSelection 返 false', () => {
    const view = makeView('第一段\n\n第二段', false)
    expect(typewriterModeKey.getState(view.state)!.enabled).toBe(false)
    expect(scrollHandler(view)).toBe(false)
  })

  it('setMeta 翻 enabled → getState.enabled=true 且 handleScrollToSelection 返 true', () => {
    const view = makeView('第一段\n\n第二段', false)
    view.dispatch(view.state.tr.setMeta(typewriterModeKey, { enabled: true }))
    expect(typewriterModeKey.getState(view.state)!.enabled).toBe(true)
    expect(scrollHandler(view)).toBe(true)
  })

  it('setMeta 翻回 false → handleScrollToSelection 返 false(零回归)', () => {
    const view = makeView('第一段\n\n第二段', true)
    expect(scrollHandler(view)).toBe(true)
    view.dispatch(view.state.tr.setMeta(typewriterModeKey, { enabled: false }))
    expect(scrollHandler(view)).toBe(false)
  })

  it('enabled 下 dispatch 选区变化 tr 不抛(update 居中路径无异常)', () => {
    const view = makeView('第一段\n\n第二段\n\n第三段', true)
    expect(() => {
      // 把光标移到第二段(第一段 3 字 + \n\n = 5 字符偏移后是第二段开头,+1 跳 doc opening token)
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)))
    }).not.toThrow()
  })

  it('模块级镜像经 setTypewriterModeEnabled 同步后,state.init 读到正确初值', () => {
    setTypewriterModeEnabled(true)
    const view = makeView('第一段', false)
    // makeView 未 dispatch setMeta,enabled 初值来自 state.init 读 currentEnabled
    expect(typewriterModeKey.getState(view.state)!.enabled).toBe(true)
    expect(scrollHandler(view)).toBe(true)
  })
})
