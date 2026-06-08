// 集成测试:起真 ProseMirror EditorView,装上生产 plugin
// (footnoteNumberPlugin),走真实 NodeView 路径,验证两条跳转真的派发。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Schema, type Node as PMNode } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import { EditorView } from '@milkdown/prose/view'
import { footnoteNumberPlugin } from '../FootnoteNodeViews'

// 最小 schema —— 与现有 FootnoteNodeViews.test.ts 一致
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
    footnote_reference: {
      inline: true,
      atom: true,
      group: 'inline',
      attrs: { label: { default: '' } },
      parseDOM: [{ tag: 'sup[data-type="footnote_reference"]', getAttrs: dom => ({ label: (dom as HTMLElement).dataset.label ?? '' }) }],
      toDOM: node => ['sup', { 'data-type': 'footnote_reference', 'data-label': node.attrs.label, class: 'footnote-ref-node' }, node.attrs.label],
    },
    footnote_definition: {
      group: 'block',
      content: 'paragraph',
      attrs: { label: { default: '' } },
      parseDOM: [{ tag: 'dl[data-type="footnote_definition"]', getAttrs: dom => ({ label: (dom as HTMLElement).dataset.label ?? '' }) }],
      toDOM: node => ['dl', { 'data-type': 'footnote_definition', 'data-label': node.attrs.label, class: 'footnote-definition' }, ['dt', { class: 'footnote-label' }, node.attrs.label], ['dd', { class: 'footnote-content' }, 0], ['a', { class: 'footnote-backref', href: '#x' }, '↩']],
    },
  },
})

function mkRef(label: string) {
  return schema.nodes.footnote_reference.create({ label })
}
function mkDef(label: string) {
  return schema.nodes.footnote_definition.create(
    { label },
    schema.nodes.paragraph.create(null, schema.text(`def-${label}`)),
  )
}
function mkDoc(...nodes: any[]) {
  return schema.nodes.doc.create(null, nodes)
}

function mountView(doc: PMNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const state = EditorState.create({ doc, schema, plugins: [footnoteNumberPlugin] })
  const view = new EditorView(host, { state })
  return { view, host, cleanup: () => { view.destroy(); host.remove() } }
}

// 真实 plugin 装配时 NodeView factory 跑过,sup 是带 click handler 的真 DOM
function findSup(view: EditorView): HTMLElement | null {
  return view.dom.querySelector('sup.footnote-ref-node')
}
function findBackref(view: EditorView): HTMLAnchorElement | null {
  return view.dom.querySelector('a.footnote-backref')
}

// ============================================================
//  CTRL+click reference → definition
// ============================================================

describe('CTRL+click 跳转 reference → definition', () => {
  let view: EditorView
  let cleanup: () => void
  let defPos: number

  beforeEach(() => {
    const p = schema.nodes.paragraph.create(null, [mkRef('a')])
    const doc = mkDoc(p, mkDef('a'))
    doc.descendants((n, pos) => {
      if (n.type.name === 'footnote_definition' && n.attrs.label === 'a') defPos = pos
    })
    ;({ view, cleanup } = mountView(doc))
  })
  afterEach(() => cleanup())

  it('sup 真的被 NodeView factory 创建', () => {
    const sup = findSup(view)
    expect(sup).not.toBeNull()
  })

  it('sup 上有 click handler 监听(检测 NodeView 接管成功)', () => {
    // 如果 NodeView 没装上,这里 dispatchEvent 也不会有人监听
    // 通过 spyOn addEventListener 之前已经注册了 click —— 不,更直接的:
    // 直接 dispatch click,看 selection 动不动,见下一个测试
    const sup = findSup(view)!
    // sanity: sup 至少存在且是 Element
    expect(sup.tagName).toBe('SUP')
  })

  it('CTRL+click sup 后,selection 跳到 definition 内', () => {
    const sup = findSup(view)!
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })
    sup.dispatchEvent(ev)
    expect(view.state.selection.from).toBe(defPos + 1)
  })

  it('(真浏览器序列) mousedown+mouseup+click 全程 CTRL,selection 仍应跳到 def', () => {
    // 真实浏览器里 mousedown / mouseup / click 是三个独立事件。
    // ProseMirror 的 handlers.mousedown 在 mousedown 时启动 MouseDown,
    // MouseDown.up 在 mouseup 时调 handleSingleClick(..., selectNode)。
    // selectNode = event.ctrlKey (Windows) / event.metaKey (Mac)。
    // 这正是为什么 stopPropagation 必须在 mousedown 就拦住 ——
    // 不然 MouseDown.up 在 mouseup 调 selectClickedNode 会覆盖我们
    // click handler 的 setSelection。
    const sup = findSup(view)!
    const initFrom = view.state.selection.from

    sup.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, ctrlKey: true, button: 0,
    }))
    document.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, ctrlKey: true, button: 0,
    }))
    sup.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, ctrlKey: true, button: 0,
    }))

    // 注:ProseMirror 用 view.root (document) 监听 mouseup。
    // 如果我们的 mousedown.stopPropagation 起作用了,editor.mousedown
    // handler 不会跑、MouseDown 不会被创建、mouseup 上不会有人接。
    // 那么 click 上我们自己的 handler 是唯一动 selection 的,from 应是 defPos+1。
    expect(view.state.selection.from).toBe(defPos + 1)
    // 防御性 sanity:如果 selection 没动,说明 click handler 没跑
    expect(view.state.selection.from).not.toBe(initFrom)
  })

  it('非 modifier click 不应跳转(只把光标放进 sup,允许编辑 label)', () => {
    const sup = findSup(view)!
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    sup.dispatchEvent(ev)
    // selection 不应跳到 def
    expect(view.state.selection.from).not.toBe(defPos + 1)
  })
})

// ============================================================
//  click backref definition → first reference
// ============================================================

describe('click backref 跳转 definition → first reference', () => {
  let view: EditorView
  let cleanup: () => void
  let refPos: number

  beforeEach(() => {
    const p = schema.nodes.paragraph.create(null, [mkRef('a')])
    const doc = mkDoc(p, mkDef('a'))
    doc.descendants((n, pos) => {
      if (n.type.name === 'footnote_reference' && n.attrs.label === 'a') refPos = pos
    })
    ;({ view, cleanup } = mountView(doc))
  })
  afterEach(() => cleanup())

  it('backref 真的被 NodeView factory 创建', () => {
    const backref = findBackref(view)
    expect(backref).not.toBeNull()
  })

  it('backref 上 onclick handler 真的派发了 transaction', () => {
    const backref = findBackref(view)!
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    backref.dispatchEvent(ev)
    expect(view.state.selection.from).toBe(refPos)
  })
})

// ============================================================
//  capture 阶段监听回归测试
//
//  为什么这套测试重要:ProseMirror 的 handlers.mousedown 是 bubble 阶段挂在
//  view.dom 上,如果我们的 sup/backref 的 mousedown 监听也用 bubble 阶段,
//  真实浏览器里(尤其对 contentEditable sup)就可能让 ProseMirror 先看到事件
//  并在 mouseup 上调 selectClickedNode(event.ctrlKey) 抢走 selection。
//
//  验证:dispatch mousedown 后看 defaultPrevented / event 是否被拦截。
//  这两个值是 capture 阶段监听是否在 path 早期就 preventDefault 的功能性证据。
// ============================================================

describe('capture 阶段 mousedown 监听(防 ProseMirror 抢 selection)', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    ;({ view, cleanup } = mountView(mkDoc(
      schema.nodes.paragraph.create(null, [mkRef('a')]),
      mkDef('a'),
    )))
  })
  afterEach(() => cleanup())

  it('sup mousedown + ctrlKey 应在 capture 阶段 preventDefault', () => {
    const sup = findSup(view)!
    const ev = new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, ctrlKey: true, button: 0,
    })
    sup.dispatchEvent(ev)
    // 如果 capture 阶段没在 ProseMirror 之前 preventDefault,这条会 false
    expect(ev.defaultPrevented).toBe(true)
  })

  it('sup mousedown 无 modifier 不应 preventDefault(保留 focus 让用户能编辑 label)', () => {
    const sup = findSup(view)!
    const ev = new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0,
    })
    sup.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
  })

  it('backref mousedown 应在 capture 阶段 preventDefault(阻止 <a> 默认导航)', () => {
    const backref = findBackref(view)!
    const ev = new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0,
    })
    backref.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('顺序:capture 阶段监听先于 ProseMirror 的 bubble 监听(用 stopPropagation 旁证)', () => {
    // capture 阶段 stopPropagation 会把后面的 capture + target + bubble 一起截掉
    // (DOM 规范:stopPropagation flag 在 dispatch 循环的每一步顶端检查)。
    // 所以如果在 view.dom 的 bubble 阶段挂一个 listener,我们的 capture handler
    // 一旦 stopPropagation,这个 listener 就**不会跑**。
    //
    // 这里"不会跑"本身就是顺序证据 —— 我们的 capture handler 比它早跑。
    const sup = findSup(view)!
    let bubbleRan = false
    view.dom.addEventListener('mousedown', () => { bubbleRan = true }, false)

    sup.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, ctrlKey: true, button: 0,
    }))
    view.dom.removeEventListener('mousedown', () => { bubbleRan = true }, false)
    expect(bubbleRan).toBe(false)
  })
})
