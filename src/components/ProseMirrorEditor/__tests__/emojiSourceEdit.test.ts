// emojiSourceEdit plugin 测试。
//
// 覆盖：
//  - 触发：光标移到 emoji 左侧/右侧/NodeSelection → 替换为 :shortcode: 源码
//  - 非触发：光标不在 emoji 旁、docChanged（键入）不触发
//  - commit：光标移出 → 合法 shortcode 重建 emoji 节点
//  - commit 降级：编辑后不合法 → 保留纯文本
//  - Escape：还原原始 emoji 节点
//  - Decoration：源码文本有 .velo-emoji-source-edit class
//  - 预览 widget:源码合法时渲染 emoji 字符,残缺时不挂

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import type { Node as PMNode } from 'prosemirror-model'
import { emojiSourceEditPlugin, emojiSourceEditEscapeKeymap, emojiSourceEditKey } from '../plugins/emojiSourceEdit'

function makeDocWithEmoji(): PMNode {
  const para = schema.nodes.paragraph.create(null, [
    schema.text('hello '),
    schema.nodes.emoji.create({ shortcode: 'smile' }),
    schema.text(' world'),
  ])
  return schema.nodes.doc.create(null, [para])
}

function mountView(initialDoc = makeDocWithEmoji()): {
  view: EditorView
  cleanup: () => void
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const state = EditorState.create({
    schema,
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, 1),
    plugins: [
      emojiSourceEditPlugin,
      emojiSourceEditEscapeKeymap,
    ],
  })
  const view = new EditorView(host, { state })
  return { view, cleanup: () => { view.destroy(); host.remove() } }
}

function getState(view: EditorView) {
  const s = emojiSourceEditKey.getState(view.state)
  return { session: s?.session ?? null, active: !!s?.session }
}

function moveCursor(view: EditorView, pos: number): void {
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, pos))
  view.dispatch(tr)
}

/** The emoji node in the default doc is at position 7 (after "hello "). */
const EMOJI_POS = 7

describe('emojiSourceEdit: 触发', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('光标移到 emoji 左侧 → 激活 session,源码文本替换 emoji', () => {
    moveCursor(view, EMOJI_POS)
    const s = getState(view)
    expect(s.active).toBe(true)
    expect(view.state.doc.textBetween(EMOJI_POS, EMOJI_POS + 7, '\n', '\n')).toBe(':smile:')
    expect(view.state.doc.nodeAt(EMOJI_POS)?.type.name).not.toBe('emoji')
  })

  it('光标移到 emoji 右侧 → 激活 session', () => {
    moveCursor(view, EMOJI_POS + 1)
    const s = getState(view)
    expect(s.active).toBe(true)
    expect(view.state.doc.textBetween(EMOJI_POS, EMOJI_POS + 7, '\n', '\n')).toBe(':smile:')
  })

  it('NodeSelection 选中 emoji → 激活 session', () => {
    const tr = view.state.tr.setSelection(NodeSelection.create(view.state.doc, EMOJI_POS))
    view.dispatch(tr)
    const s = getState(view)
    expect(s.active).toBe(true)
  })

  it('光标不在 emoji 旁 → 不激活', () => {
    moveCursor(view, 3)
    expect(getState(view).active).toBe(false)
  })

  it('docChanged（键入）不触发 appendTransaction', () => {
    moveCursor(view, EMOJI_POS)
    expect(getState(view).active).toBe(true)
    moveCursor(view, EMOJI_POS - 1)
    expect(getState(view).active).toBe(false)
    view.dispatch(view.state.tr.insertText('x', EMOJI_POS - 1))
    expect(getState(view).active).toBe(false)
  })
})

describe('emojiSourceEdit: commit', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('光标移出源码范围 → 合法 shortcode 重建 emoji 节点', () => {
    moveCursor(view, EMOJI_POS)
    expect(getState(view).active).toBe(true)
    moveCursor(view, EMOJI_POS - 1)
    expect(getState(view).active).toBe(false)
    const node = view.state.doc.nodeAt(EMOJI_POS)
    expect(node?.type.name).toBe('emoji')
    expect(node?.attrs.shortcode).toBe('smile')
  })

  it('commit 后光标是 TextSelection 且在 emoji 之后(不是 NodeSelection)', () => {
    moveCursor(view, EMOJI_POS)
    expect(getState(view).active).toBe(true)
    // 从右侧移出 → 触发 commit
    moveCursor(view, EMOJI_POS + 8) // 越过 :smile: 源码(7 chars)+1
    expect(getState(view).active).toBe(false)
    // 光标应为 TextSelection,位于 emoji 之后(EMOJI_POS 之后)
    expect(view.state.selection instanceof TextSelection).toBe(true)
    expect((view.state.selection as TextSelection).from).toBeGreaterThan(EMOJI_POS)
  })

  it('在源码末尾键入字符 → commit 后光标在键入字符之后', () => {
    // 从右侧进入 session
    moveCursor(view, EMOJI_POS + 1)
    expect(getState(view).active).toBe(true)
    const editTo = getState(view).session!.editTo // = EMOJI_POS + 7 = 14
    // 在源码末尾(editTo)键入 's' → bias -1 使 editTo 不扩展 → 光标在 session 外
    view.dispatch(view.state.tr.insertText('s', editTo))
    // session 仍活跃(apply 未清),但 pendingCommit 已设 → view.update 触发 commit
    expect(getState(view).active).toBe(false)
    // emoji 重建, 's' 保留在 emoji 之后
    const emojiNode = view.state.doc.nodeAt(EMOJI_POS)
    expect(emojiNode?.type.name).toBe('emoji')
    // 's' 在 emoji 之后,与原有的 ' world' 合并为 's world' 文本节点
    const afterEmoji = view.state.doc.nodeAt(EMOJI_POS + 1)
    expect(afterEmoji?.isText).toBe(true)
    expect(afterEmoji?.text).toBe('s world')
    // 光标应在 's' 之后(EMOJI_POS + 2)
    expect(view.state.selection instanceof TextSelection).toBe(true)
    expect((view.state.selection as TextSelection).from).toBe(EMOJI_POS + 2)
  })

  it('编辑后 shortcode 不合法 → 保留纯文本（降级）', () => {
    moveCursor(view, EMOJI_POS)
    expect(getState(view).active).toBe(true)
    const editFrom = getState(view).session!.editFrom
    const editTo = getState(view).session!.editTo
    view.dispatch(view.state.tr.delete(editFrom, editTo).insertText(':notreal:', editFrom))
    moveCursor(view, editFrom - 1)
    expect(getState(view).active).toBe(false)
    const node = view.state.doc.nodeAt(editFrom)
    if (node) {
      expect(node.type.name).not.toBe('emoji')
    }
  })
})

describe('emojiSourceEdit: Escape', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('Escape → 还原原始 emoji 节点', () => {
    moveCursor(view, EMOJI_POS)
    expect(getState(view).active).toBe(true)
    view.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(getState(view).active).toBe(false)
    const node = view.state.doc.nodeAt(EMOJI_POS)
    expect(node?.type.name).toBe('emoji')
    expect(node?.attrs.shortcode).toBe('smile')
  })
})

describe('emojiSourceEdit: Decoration', () => {
  let view: EditorView
  let cleanup: () => void

  beforeEach(() => {
    const r = mountView()
    view = r.view
    cleanup = r.cleanup
  })
  afterEach(() => cleanup())

  it('session 活跃时源码文本有 .velo-emoji-source-edit class', () => {
    moveCursor(view, EMOJI_POS)
    // 检查 DOM 中是否有 .velo-emoji-source-edit 元素
    const el = view.dom.querySelector('.velo-emoji-source-edit')
    expect(el).not.toBeNull()
  })

  it('session 不活跃时无 decoration', () => {
    const el = view.dom.querySelector('.velo-emoji-source-edit')
    expect(el).toBeNull()
  })

  it('源码合法时渲染 emoji 预览 widget', () => {
    moveCursor(view, EMOJI_POS)
    const el = view.dom.querySelector('.velo-emoji-source-preview')
    expect(el).not.toBeNull()
    expect(el?.textContent).toBeTruthy() // emoji 字符
  })

  it('源码残缺时不挂预览 widget', () => {
    moveCursor(view, EMOJI_POS)
    expect(getState(view).active).toBe(true)
    // 删掉末尾 `:` → 源码残缺
    const editTo = getState(view).session!.editTo
    view.dispatch(view.state.tr.delete(editTo - 1, editTo))
    expect(getState(view).active).toBe(true)
    const el = view.dom.querySelector('.velo-emoji-source-preview')
    expect(el).toBeNull()
  })
})
