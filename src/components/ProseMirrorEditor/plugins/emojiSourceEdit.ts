// emoji 源码编辑 — Obsidian Live Preview 风格的光标驱动 session。
//
// 用户交互流程:
//   1. 光标(方向键 / 点击)落到 emoji 节点两侧或 NodeSelection 选中 emoji →
//      appendTransaction 把 emoji atom 替换成 `:shortcode:` 源码文本,
//      进入编辑 session。Decoration 给源码文本加 .velo-emoji-source-edit 标记,
//      并在源码文本左侧渲染 emoji 预览 widget(Decoration.widget side:-1),
//      让用户同时看到渲染态 emoji 和可编辑源码。
//      trigger 事务挂 SKIP_CONTENT_EMIT —— 瞬时视图切换不是内容编辑。
//   2. 编辑态下:
//      - 用户编辑源码 → 普通 transaction,plugin state 随位置平移,
//        预览 widget 实时跟随 shortcode 合法性变化
//      - 光标移出源码范围 → apply 检测到,view.update 触发 commit
//      - commit:`:shortcode:` 合法(在 node-emoji 表中)→ 重建 emoji 节点;
//        不合法 → 保留纯文本;空 → 删除
//      - Escape → keymap 还原成 originalSource 对应的 emoji 节点(放弃编辑)
//
// 设计要点(对照 markSourceEdit / imageEdit):
//  - 与 mark 不同:emoji 是 atom node 不是 mark,走"替换成纯文本"而非"剥 mark"
//  - 与 image 不同:触发方式是光标靠近(appendTransaction)而非按钮点击;
//    但预览 widget 范式同 imageEdit(Decoration.widget 渲染在源码旁)
//  - session 状态机(apply mapping + pendingCommit + view.update 触发 commit
//    + Escape 还原)复用 markSourceEdit / imageEdit 的骨架
//  - 触发守卫:仅 batch 含 `selectionChanged && !docChanged` 的 tr 才进
//  - 不在 code_block / 源码编辑 session 内触发

import { keymap } from 'prosemirror-keymap'
import { NodeSelection, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { has as emojiHas, get as emojiGet } from 'node-emoji'

import { SKIP_CONTENT_EMIT } from '../editor/transactionMeta'
import { linkClickPluginKey } from './linkClick'
import { imageEditKey } from '../image/imageEditPlugin'
import { markSourceEditKey } from './markSourceEdit'
import { htmlSourceEditKey } from './htmlSourceEdit'

export const emojiSourceEditKey = new PluginKey<EmojiSourceEditState>('emojiSourceEdit')

// 模块级 view 引用:appendTransaction 没有 view 参数,用它读 view.editable
let editorView: EditorView | null = null

interface EmojiEditSession {
  editFrom: number
  editTo: number
  originalSource: string
}

interface EmojiSourceEditState {
  session: EmojiEditSession | null
  pendingCommit: EmojiEditSession | null
}

function emptyState(): EmojiSourceEditState {
  return { session: null, pendingCommit: null }
}

/** 其他 session 范围内不触发 emoji source edit。 */
function inOtherEditSession(state: EditorState, pos: number): boolean {
  const linkSession = linkClickPluginKey.getState(state)?.session
  if (linkSession && pos >= linkSession.editFrom && pos <= linkSession.editTo) return true
  const imageSession = imageEditKey.getState(state)?.session
  if (imageSession && pos >= imageSession.editFrom && pos <= imageSession.editTo) return true
  const markSession = markSourceEditKey.getState(state)?.session
  if (markSession && pos >= markSession.editFrom && pos <= markSession.editTo) return true
  const htmlSession = htmlSourceEditKey.getState(state)?.session
  if (htmlSession && pos >= htmlSession.editFrom && pos <= htmlSession.editTo) return true
  return false
}

/** 检测光标是否落在 emoji 节点两侧或 emoji 被 NodeSelection 选中。
 *  返回 emoji 节点在 doc 中的位置(pos)和 shortcode。 */
function findAdjacentEmoji(state: EditorState): { pos: number, shortcode: string } | null {
  const sel = state.selection

  // NodeSelection on emoji
  if (sel instanceof NodeSelection && sel.node.type.name === 'emoji') {
    return { pos: sel.from, shortcode: sel.node.attrs.shortcode as string }
  }

  if (!sel.empty) return null

  const head = sel.head
  const $head = state.doc.resolve(head)

  // Left side: cursor at pos, nodeAfter is emoji
  const nodeAfter = $head.nodeAfter
  if (nodeAfter && nodeAfter.type.name === 'emoji') {
    return { pos: head, shortcode: nodeAfter.attrs.shortcode as string }
  }

  // Right side: cursor at pos, nodeBefore is emoji
  const nodeBefore = $head.nodeBefore
  if (nodeBefore && nodeBefore.type.name === 'emoji') {
    return { pos: head - 1, shortcode: nodeBefore.attrs.shortcode as string }
  }

  return null
}

/** 把 `:shortcode:` 文本解析回 shortcode。不合法返回 null。 */
function parseEmojiSource(text: string): string | null {
  const match = /^:([\w+-]+):$/.exec(text.trim())
  if (!match) return null
  const shortcode = match[1]
  return emojiHas(shortcode) ? shortcode : null
}

function commitEmojiEdit(view: EditorView): void {
  const pluginState = emojiSourceEditKey.getState(view.state)
  if (!pluginState?.session) return

  const { editFrom, editTo } = pluginState.session
  const sourceText = view.state.doc.textBetween(editFrom, editTo, '\n', '\n')
  // pendingCommit 时光标在 session 范围外,commit 后用 mapping 将光标映射到
  // 正确位置(emoji 之前/之后 + 范围外键入的字符之后),而非硬编码 editFrom+1。
  const selFrom = view.state.selection.from

  let tr = view.state.tr.setMeta(emojiSourceEditKey, { type: 'commit' as const })

  const shortcode = parseEmojiSource(sourceText)
  const emojiType = view.state.schema.nodes.emoji
  if (shortcode && emojiType) {
    // 合法 → 重建 emoji 节点
    tr = tr.replaceWith(editFrom, editTo, emojiType.create({ shortcode }))
  } else if (sourceText.trim() === '') {
    // 空源码 → 删除
    tr = tr.delete(editFrom, editTo)
  }
  // 不合法 → 保留纯文本(降级),不替换

  // 光标映射到 commit 后的正确位置:
  // - 右侧退出 + 键入字符: 光标在 editTo 外,映射后落在 emoji + 键入字符之后
  // - 左侧退出: 光标在 editFrom 前,映射后落在 emoji 之前
  const mappedPos = tr.mapping.map(selFrom)
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(mappedPos)))
  view.dispatch(tr)
}

export const emojiSourceEditPlugin = new Plugin<EmojiSourceEditState>({
  key: emojiSourceEditKey,

  state: {
    init() {
      return emptyState()
    },

    apply(tr, value, _oldState, newState) {
      const meta = tr.getMeta(emojiSourceEditKey) as
        | { type: 'start', session: EmojiEditSession }
        | { type: 'commit' | 'cancel' }
        | undefined

      if (meta?.type === 'start') {
        return { session: meta.session, pendingCommit: null }
      }
      if (meta?.type === 'commit' || meta?.type === 'cancel') {
        return emptyState()
      }
      if (!value.session) return value

      // 普通事务:editFrom +1 bias / editTo -1 bias 过 mapping
      const session = value.session
      const editFrom = tr.mapping.map(session.editFrom, 1)
      const editTo = tr.mapping.map(session.editTo, -1)
      const updated: EmojiEditSession = { ...session, editFrom, editTo }

      const sel = newState.selection
      const inside = sel.from >= editFrom && sel.to <= editTo
      return { session: updated, pendingCommit: inside ? null : updated }
    },
  },

  props: {
    decorations(state) {
      const pluginState = emojiSourceEditKey.getState(state)
      if (!pluginState?.session) return DecorationSet.empty
      const { editFrom, editTo } = pluginState.session

      const decos: Decoration[] = [
        Decoration.inline(editFrom, editTo, { class: 'velo-emoji-source-edit' }),
      ]

      // emoji 预览 widget:渲染在源码文本之前(side:-1),让用户同时看到
      // 渲染态 emoji 和可编辑 `:shortcode:` 源码。key 含当前源码文本,
      // 文本变 → 重建 widget → 实时预览。源码残缺 → 不挂 widget(emoji 隐藏)。
      const currentText = state.doc.textBetween(editFrom, editTo, '\n', '\n')
      const shortcode = parseEmojiSource(currentText)
      if (shortcode) {
        const emojiChar = emojiGet(shortcode)
        if (emojiChar) {
          decos.push(
            Decoration.widget(editFrom, () => {
              const span = document.createElement('span')
              span.className = 'velo-emoji-source-preview'
              span.textContent = emojiChar
              span.contentEditable = 'false'
              return span
            }, {
              side: -1,
              key: `emoji-source-preview:${currentText}`,
            }),
          )
        }
      }

      return DecorationSet.create(state.doc, decos)
    },
  },

  // 光标靠近 emoji → 换源码进 session。走 appendTransaction(同 markSourceEdit)
  appendTransaction(transactions, _oldState, newState) {
    // 阅读模式下不展开源码
    if (editorView && !editorView.editable) return null
    // 守卫 (a):已开会话不重复进
    if (emojiSourceEditKey.getState(newState)?.session) return null
    // 守卫 (b):仅纯选区变化(方向键 / 点击)触发;键入 / IME / 粘贴是 docChanged 不触发
    const moved = transactions.some(t => t.selectionSet && !t.docChanged)
    if (!moved) return null

    const sel = newState.selection
    const head = sel.head

    // code_block / math_block 内不触发
    const $pos = newState.doc.resolve(head)
    if ($pos.parent.type.name === 'code_block' || $pos.parent.type.name === 'math_block') return null

    // 其他 source edit session 活跃时不触发
    if (inOtherEditSession(newState, head)) return null

    const found = findAdjacentEmoji(newState)
    if (!found) return null

    const { pos, shortcode } = found
    const source = `:${shortcode}:`
    if (!source) return null

    // 光标落点:左进 → 源码起点;右进/NodeSelection → 源码末尾
    const isLeftSide = head === pos
    const cursorPos = isLeftSide ? pos : pos + source.length

    let tr: Transaction = newState.tr.replaceWith(pos, pos + 1, newState.schema.text(source))
    tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos))
    // 瞬时视图切换(emoji → 源码文本)不触发内容回写
    tr = tr.setMeta(SKIP_CONTENT_EMIT, true)
    tr = tr.setMeta(emojiSourceEditKey, {
      type: 'start' as const,
      session: {
        editFrom: pos,
        editTo: pos + source.length,
        originalSource: source,
      },
    })
    return tr
  },

  view(initialView) {
    editorView = initialView
    return {
      update(view) {
        const pluginState = emojiSourceEditKey.getState(view.state)
        if (pluginState?.pendingCommit) {
          commitEmojiEdit(view)
        }
      },
      destroy() {
        editorView = null
      },
    }
  },
})

/** Escape → 放弃编辑,还原成 originalSource 对应的 emoji 节点。 */
export const emojiSourceEditEscapeKeymap = keymap({
  Escape: (state, dispatch) => {
    const pluginState = emojiSourceEditKey.getState(state)
    if (!pluginState?.session) return false

    const { editFrom, editTo, originalSource } = pluginState.session
    if (!dispatch) return true

    const shortcode = parseEmojiSource(originalSource)
    let tr = state.tr.setMeta(emojiSourceEditKey, { type: 'cancel' as const })
    tr = tr.delete(editFrom, editTo)

    const emojiType = state.schema.nodes.emoji
    if (shortcode && emojiType) {
      tr = tr.replaceWith(editFrom, editFrom, emojiType.create({ shortcode }))
      tr = tr.setSelection(TextSelection.create(tr.doc, editFrom + 1))
    } else {
      // originalSource 不合法(不该发生)退回插文本
      tr = tr.insertText(originalSource, editFrom)
      tr = tr.setSelection(TextSelection.create(tr.doc, editFrom + 1))
    }
    dispatch(tr)
    return true
  },
})
