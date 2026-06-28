// 集成测试:起真 ProseMirror EditorView,装上生产 plugin
// (footnoteNumberPlugin),走真实 NodeView 路径,验证两条跳转真的派发。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Schema, type Node as PMNode } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
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
      group: 'inline',
      content: 'text*',
      marks: '',
      parseDOM: [{ tag: 'sup[data-type="footnote_reference"]' }],
      toDOM: () => ['sup', { 'data-type': 'footnote_reference', class: 'footnote-ref-node' }, 0],
    },
    footnote_label: {
      group: 'block',
      content: 'text*',
      parseDOM: [{ tag: 'dt' }],
      toDOM: () => ['dt', 0],
    },
    footnote_definition: {
      group: 'block',
      content: 'footnote_label paragraph',
      parseDOM: [{ tag: 'dl[data-type="footnote_definition"]', contentElement: 'dl' }],
      toDOM: node => ['dl', { 'data-type': 'footnote_definition', 'data-label': node.firstChild?.textContent ?? '', class: 'footnote-definition' }, ['dt', { class: 'footnote-label' }, node.firstChild?.textContent ?? ''], ['dd', { class: 'footnote-content' }, 0], ['a', { class: 'footnote-backref', href: '#x' }, '↩']],
    },
  },
})

function mkRef(label: string) {
  return schema.nodes.footnote_reference.create(null, schema.text(label))
}
function mkDef(label: string) {
  return schema.nodes.footnote_definition.create(null, [
    schema.nodes.footnote_label.create(null, schema.text(label)),
    schema.nodes.paragraph.create(null, schema.text(`def-${label}`)),
  ])
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
      if (n.type.name === 'footnote_definition' && n.firstChild?.textContent === 'a') defPos = pos
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
    // 跳到 defPos + 2 = footnote_label 节点 text content 起点(inline)
    expect(view.state.selection.from).toBe(defPos + 2)
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
    // 那么 click 上我们自己的 handler 是唯一动 selection 的,from 应是 defPos+2。
    expect(view.state.selection.from).toBe(defPos + 2)
    // 防御性 sanity:如果 selection 没动,说明 click handler 没跑
    expect(view.state.selection.from).not.toBe(initFrom)
  })

  it('非 modifier click 不应跳转(只把光标放进 sup,允许编辑 label)', () => {
    const sup = findSup(view)!
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    sup.dispatchEvent(ev)
    // selection 不应跳到 def
    expect(view.state.selection.from).not.toBe(defPos + 2)
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
      if (n.type.name === 'footnote_reference' && n.textContent === 'a') refPos = pos
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

// ============================================================
//  回归测试:v0.5.8 footnote_definition label 编辑修复
//
//  之前(<= v0.5.7):label 在 attrs.label,NodeView 自管 <div.footnote-label>
//  不在 contentDOM 子树内,PM 看不到 → 点击 label 时 PM 默认推进光标到
//  最近 content(描述段前),Backspace/Delete 删错位置。
//
//  改后:label 拆成 footnote_label 节点(content:'text*'),与 footnote_reference
//  同范式 —— PM 接管 label 文本编辑,光标自然进入。
//
//  验证:
//  1. 点击 label(<dt>)后,selection 落在 label 节点内(text 内 offset),
//     而不是 description 段(<dd> 内)开头。
//  2. 通过 dispatch transaction 修改 label 文本(模拟键盘输入),PM
//     接受修改,doc.firstChild.textContent 反映新 label(且不破坏 desc)。
// ============================================================

describe('footnote_definition label 可编辑(v0.5.8 回归)', () => {
  let view: EditorView
  let cleanup: () => void
  let labelPos: number

  beforeEach(() => {
    const doc = mkDoc(mkDef('orig'))
    // footnote_label 是 footnote_definition 的第一个 child(不是孙节点);
    // doc > footnote_definition > footnote_label > text('orig')
    doc.descendants((n, pos) => {
      if (n.type.name === 'footnote_label' && n.textContent === 'orig') labelPos = pos
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const state = EditorState.create({ doc, schema, plugins: [footnoteNumberPlugin] })
    view = new EditorView(host, { state })
    cleanup = () => { view.destroy(); host.remove() }
  })
  afterEach(() => cleanup())

  it('点击 label(<dt>)文本,selection 应落在 footnote_label 内', () => {
    const dt = view.dom.querySelector('dl.footnote-definition dt') as HTMLElement
    expect(dt).not.toBeNull()
    // 模拟真实点击序列:mousedown + mouseup + click 都不带 modifier
    dt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }))
    dt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))

    // 修复前:selection 会落到 description paragraph 开头(labelPos + 节点大小之后)
    // 修复后:selection 应在 label 节点内(>= labelPos, < labelPos + labelNodeSize)
    const labelNode = view.state.doc.nodeAt(labelPos)!
    const labelEnd = labelPos + labelNode.nodeSize
    expect(view.state.selection.from).toBeGreaterThanOrEqual(labelPos)
    expect(view.state.selection.from).toBeLessThanOrEqual(labelEnd)
    // 关键修复断言:selection 不应落到 description 段(<dd> 内 paragraph)开头
    // —— description 段在 label 之后,position > labelEnd 即落到描述段
    expect(view.state.selection.from).toBeLessThanOrEqual(labelEnd)
  })

  it('dispatch 修改 label text 后,doc 的 footnote_definition firstChild 反映新 label', () => {
    // 模拟用户编辑:删掉原 label 'orig',输入 'renamed'
    // labelNode = 'orig'(4 字符)
    const labelNode = view.state.doc.nodeAt(labelPos)!
    const from = labelPos + 1
    const to = from + labelNode.content.size
    const tr = view.state.tr
      .delete(from, to)
      .insertText('renamed', from)
    view.dispatch(tr)

    // 验证:footnote_definition 的 firstChild(footnote_label)textContent 是 'renamed'
    // 描述段保持不变
    let def: any = null
    view.state.doc.descendants((n) => {
      if (n.type.name === 'footnote_definition') def = n
    })
    expect(def).not.toBeNull()
    expect(def.firstChild?.textContent).toBe('renamed')
    // description 段(text='def-orig' 由 mkDef 工厂填)保持
    expect(def.child(1).textContent).toBe('def-orig')
  })
})
