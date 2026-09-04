// B3 NodeView 延迟创建：视口外的 math 节点不调 katex.render，进入视口后才渲染；
// 滚出视口后缓存 innerHTML 并销毁 DOM，重新进入从缓存同步恢复（免 katex.render）。
//
// jsdom 无 IntersectionObserver，这里注入可控的 fake，手动触发 intersect/leave，
// 锁定"延迟 → 渲染 → 销毁(缓存) → 缓存恢复"契约。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../../editor/schema'
import { mathEditPlugin } from '../MathNodeViews'

// ---- fake IntersectionObserver ----
interface FakeEntry { target: Element; isIntersecting: boolean }
class FakeIO {
  private cb: (entries: FakeEntry[], obs: FakeIO) => void
  private targets = new Set<Element>()
  static last: FakeIO | null = null
  constructor(cb: (entries: FakeEntry[], obs: FakeIO) => void) {
    this.cb = cb
    FakeIO.last = this
  }
  observe(el: Element) { this.targets.add(el) }
  unobserve(el: Element) { this.targets.delete(el) }
  disconnect() { this.targets.clear() }
  /** 测试 helper：对 target 回调一次 intersect/leave。 */
  fire(el: Element, isIntersecting: boolean): void {
    if (!this.targets.has(el)) return
    this.cb([{ target: el, isIntersecting }], this)
  }
}

let savedIO: unknown
beforeEach(() => {
  savedIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  ;(globalThis as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO
  // 不重置 FakeIO.last：lazyRender 模块级缓存复用首个 fake 实例(不再调构造函数),
  // FakeIO.last 始终指向那个被缓存的实例,跨用例可用。
})
afterEach(() => {
  if (savedIO === undefined) {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  }
  else {
    ;(globalThis as { IntersectionObserver: unknown }).IntersectionObserver = savedIO
  }
  FakeIO.last?.disconnect()
  document.querySelectorAll('.ProseMirror').forEach((el) => el.parentElement?.remove())
})

/** 轮询等到 el 内出现 .katex（katex 懒加载是异步的），超时抛错。 */
function waitForKatex(el: HTMLElement, timeout = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (el.querySelector('.katex')) return resolve()
      if (Date.now() - start > timeout) return reject(new Error('katex 未在时限内渲染'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

function makeViewWithMathBlock(value: string): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  // B2:math_block 不再是 atom,content 含首尾 `$$`(独占行)。
  // doc 后跟空 paragraph 并显式设光标到 paragraph(节点外)→ display 态。
  const content = value ? `$$\n${value}\n$$` : '$$\n\n$$'
  const doc = schema.node('doc', null, [
    schema.node('math_block', null, schema.text(content)),
    schema.node('paragraph'),
  ])
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, doc.child(0).nodeSize + 1),
    plugins: [mathEditPlugin],
  })
  return new EditorView(container, { state })
}

function makeViewWithMathInline(source: string): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.node('math_inline', null, [schema.text(`$${source}$`)]),
      ]),
    ]),
    plugins: [mathEditPlugin],
  })
  return new EditorView(container, { state })
}

describe('B3 math_block 延迟渲染', () => {
  it('视口外不渲染 katex；进入视口渲染；滚出销毁并缓存；重新进入从缓存同步恢复', async () => {
    const view = makeViewWithMathBlock('x^2')
    const block = view.dom.querySelector('.math-block-node') as HTMLElement
    const io = FakeIO.last!

    // 初始（fake 不自动回调）：未渲染 katex
    expect(block.querySelector('.katex')).toBeNull()

    // 进入视口 → 渲染
    io.fire(block, true)
    await waitForKatex(block)
    expect(block.querySelector('.katex')).not.toBeNull()

    // 滚出 → 销毁 DOM、缓存 innerHTML、显示占位
    io.fire(block, false)
    expect(block.querySelector('.katex')).toBeNull()
    expect(block.querySelector('.math-lazy-placeholder')).not.toBeNull()

    // 重新进入 → 从缓存同步恢复（无需再等 katex 异步加载）
    io.fire(block, true)
    expect(block.querySelector('.katex')).not.toBeNull()

    view.destroy()
  })
})

describe('B3 math_inline 延迟渲染', () => {
  it('display 态视口外不渲染；进入视口渲染；edit 态始终渲染不被销毁', async () => {
    const view = makeViewWithMathInline('x^2')
    const node = view.dom.querySelector('.math-inline-node') as HTMLElement
    const display = node.querySelector('.math-inline-display') as HTMLElement
    const io = FakeIO.last!

    expect(node.dataset.mode).toBe('display')
    // 视口外不渲染
    expect(display.querySelector('.katex')).toBeNull()

    // 进入视口 → 渲染
    io.fire(node, true)
    await waitForKatex(display)
    expect(display.querySelector('.katex')).not.toBeNull()

    // 滚出 → 销毁 + 缓存
    io.fire(node, false)
    expect(display.querySelector('.katex')).toBeNull()

    // 把光标移入节点 → edit 态：syncMode 走 edit 分支强制渲染，且 leave 不销毁
    let pos = -1
    view.state.doc.descendants((n, p) => {
      if (n.type.name === 'math_inline') { pos = p + 1; return false }
      return true
    })
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
    view.dom.ownerDocument.dispatchEvent(new Event('selectionchange'))
    expect(node.dataset.mode).toBe('edit')
    // edit 态下 showDisplay 已渲染（katex 异步）
    await waitForKatex(display)
    expect(display.querySelector('.katex')).not.toBeNull()

    // edit 态下发 leave → 不销毁（katex 仍在）
    io.fire(node, false)
    expect(display.querySelector('.katex')).not.toBeNull()

    view.destroy()
  })
})
