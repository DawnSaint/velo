// HTML 源码编辑 — Obsidian 风格的 source edit。
//
// 行内 HTML (html_inline):
//   1. 点击 html_inline atom 节点 → 替换成原始 HTML 源码文本,
//      光标落进源码首字符后,Decoration 加 .velo-html-source-edit 视觉指示。
//   2. 编辑态下:
//      - 用户编辑文本 → 普通 transaction,plugin state 随位置平移
//      - 光标移出源码范围 → apply 检测到,view.update 触发 commit
//      - commit:把源码文本重建为 html_inline 节点(NodeSelection 选中)
//      - Escape → keymap 还原成点击前的原始源码(放弃编辑)
//
// 块级 HTML (html_block):
//   1. NodeView 右上角按钮点击 → 替换成 code_block { language: 'html' },
//      光标落进 code_block 内。
//   2. 编辑态下:
//      - 用户在 code_block 内正常编辑(PM 原生 contenteditable,无 textarea 焦点问题)
//      - 光标移出 code_block → apply 检测到,view.update 触发 commit
//      - commit:把 code_block 文本重建为 html_block 节点(NodeSelection 选中)
//      - Escape → keymap 还原成原始 HTML 源码(放弃编辑)
//
// 设计要点:
//  - 行内走"替换成纯文本"(同 imageEdit 范式),块级走"替换成 code_block"。
//    块级不用纯文本是因为 HTML 源码常含换行,纯文本在 paragraph 中会被 PM
//    按 Enter 拆段;code_block { code: true } 天然保留换行,Enter 只换行不拆段。
//  - 块级不用 NodeView 内 textarea(math_block 范式)是因为 PM 对 atom 节点
//    自动设 contentEditable=false,textarea 嵌在 contentEditable=false 的 dom
//    内,点击 textarea 时浏览器原生 contenteditable 行为会抢焦点导致 textarea
//    blur → 误退出编辑。改用 code_block 彻底绕开 contentEditable=false 问题。
//  - session 状态机(apply mapping + pendingCommit + view.update 触发 commit +
//    Escape 还原)行内/块级各一套,互不干扰。
//  - trigger 事务挂 SKIP_CONTENT_EMIT —— 瞬时视图切换不是内容编辑。
//    commit / Escape 不挂 —— 需回写以同步 content(同 imageEdit / linkClick)。

import { keymap } from 'prosemirror-keymap'
import { NodeSelection, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { Decoration, DecorationSet } from 'prosemirror-view'

import { SKIP_CONTENT_EMIT } from '../editor/transactionMeta'

export const htmlSourceEditKey = new PluginKey('htmlSourceEdit')

interface HtmlEditSession {
  editFrom: number
  editTo: number
  originalSource: string
}

interface HtmlBlockEditSession {
  blockPos: number
  originalSource: string
}

interface HtmlEditState {
  session: HtmlEditSession | null
  blockSession: HtmlBlockEditSession | null
  pendingCommit: HtmlEditSession | null
  pendingBlockCommit: HtmlBlockEditSession | null
}

function emptyState(): HtmlEditState {
  return { session: null, blockSession: null, pendingCommit: null, pendingBlockCommit: null }
}

export const htmlSourceEditPlugin = new Plugin<HtmlEditState>({
  key: htmlSourceEditKey,

  state: {
    init() {
      return emptyState()
    },

    apply(tr, value, _oldState, newState) {
      const meta = tr.getMeta(htmlSourceEditKey) as
        | { type: 'start', session: HtmlEditSession }
        | { type: 'commit' | 'cancel' }
        | { type: 'startBlock', session: HtmlBlockEditSession }
        | { type: 'commitBlock' | 'cancelBlock' }
        | undefined

      // ---- 行内 session ----
      if (meta?.type === 'start') {
        return { ...value, session: meta.session, pendingCommit: null }
      }
      if (meta?.type === 'commit' || meta?.type === 'cancel') {
        return { ...value, session: null, pendingCommit: null }
      }

      // ---- 块级 session ----
      if (meta?.type === 'startBlock') {
        return { ...value, blockSession: meta.session, pendingBlockCommit: null }
      }
      if (meta?.type === 'commitBlock' || meta?.type === 'cancelBlock') {
        return { ...value, blockSession: null, pendingBlockCommit: null }
      }

      // ---- 普通事务:跟踪 session 位置 ----
      if (!value.session && !value.blockSession) return value

      let result = value

      // 行内 session 跟踪
      if (value.session) {
        const session = value.session
        const editFrom = tr.mapping.map(session.editFrom, 1)
        const editTo = tr.mapping.map(session.editTo, -1)
        const updated: HtmlEditSession = { ...session, editFrom, editTo }
        const sel = newState.selection
        const inside = sel.from >= editFrom && sel.to <= editTo
        result = { ...result, session: updated, pendingCommit: inside ? null : updated }
      }

      // 块级 session 跟踪
      if (value.blockSession) {
        const blockPos = tr.mapping.map(value.blockSession.blockPos)
        const node = newState.doc.nodeAt(blockPos)
        if (!node || node.type.name !== 'code_block') {
          // code_block 被删除/替换,清除 session
          result = { ...result, blockSession: null, pendingBlockCommit: null }
        } else {
          const updated: HtmlBlockEditSession = { ...value.blockSession, blockPos }
          const sel = newState.selection
          const nodeEnd = blockPos + node.nodeSize
          const inside = sel.from >= blockPos && sel.to <= nodeEnd
          result = { ...result, blockSession: updated, pendingBlockCommit: inside ? null : updated }
        }
      }

      return result
    },
  },

  props: {
    handleDOMEvents: {
      click(view, event) {
        return handleHtmlClick(view, event as MouseEvent)
      },
    },

    decorations(state) {
      const pluginState = htmlSourceEditKey.getState(state)
      if (!pluginState) return DecorationSet.empty
      const decos: Decoration[] = []

      // 行内 session
      if (pluginState.session) {
        const { editFrom, editTo } = pluginState.session
        decos.push(Decoration.inline(editFrom, editTo, { class: 'velo-html-source-edit' }))
      }

      // 块级 session:给 code_block 加 node decoration
      if (pluginState.blockSession) {
        const { blockPos } = pluginState.blockSession
        const node = state.doc.nodeAt(blockPos)
        if (node) {
          decos.push(Decoration.node(blockPos, blockPos + node.nodeSize, { class: '' }))
        }
      }

      return decos.length > 0 ? DecorationSet.create(state.doc, decos) : DecorationSet.empty
    },
  },

  view(_view) {
    return {
      update(view) {
        const pluginState = htmlSourceEditKey.getState(view.state)
        if (pluginState?.pendingCommit) {
          commitHtmlEdit(view)
        }
        if (pluginState?.pendingBlockCommit) {
          commitBlockHtmlEdit(view)
        }
      },
    }
  },
})

/** Escape → 放弃编辑,还原成点击前的 HTML 节点(原始 attrs.value)。 */
export const htmlSourceEditEscapeKeymap = keymap({
  Escape: (state, dispatch) => {
    const pluginState = htmlSourceEditKey.getState(state)
    if (!pluginState?.session && !pluginState?.blockSession) return false

    if (dispatch) {
      // ---- 行内 cancel ----
      if (pluginState.session) {
        const { editFrom, editTo, originalSource } = pluginState.session
        let tr = state.tr.delete(editFrom, editTo)
        const type = state.schema.nodes.html_inline
        if (type) {
          tr = tr.replaceWith(editFrom, editFrom, type.create({ value: originalSource }))
          tr = tr.setSelection(NodeSelection.create(tr.doc, editFrom))
        } else {
          tr = tr.insertText(originalSource, editFrom)
          tr = tr.setSelection(TextSelection.create(tr.doc, editFrom + 1))
        }
        tr = tr.setMeta(htmlSourceEditKey, { type: 'cancel' as const })
        dispatch(tr)
        return true
      }

      // ---- 块级 cancel ----
      if (pluginState.blockSession) {
        const { blockPos, originalSource } = pluginState.blockSession
        const node = state.doc.nodeAt(blockPos)
        let tr = state.tr.setMeta(htmlSourceEditKey, { type: 'cancelBlock' as const })
        if (node && node.type.name === 'code_block') {
          const htmlBlockType = state.schema.nodes.html_block
          if (htmlBlockType) {
            const htmlBlock = htmlBlockType.create({ value: originalSource })
            tr = tr.replaceWith(blockPos, blockPos + node.nodeSize, htmlBlock)
            tr = tr.setSelection(NodeSelection.create(tr.doc, blockPos))
          }
        }
        dispatch(tr)
        return true
      }
    }
    return true
  },
})

// ============================================================
//  Click handler (行内 HTML)
// ============================================================

function handleHtmlClick(view: EditorView, event: MouseEvent): boolean {
  // 阅读模式下不展开源码
  if (!view.editable) return false

  const target = event.target as Element | null
  if (!target) return false

  // 沿 DOM 向上找 .velo-html-inline(不处理 .velo-html-block)
  let el: Element | null = target
  let htmlEl: Element | null = null
  while (el && el !== view.dom) {
    if (el.classList?.contains('velo-html-inline')) {
      htmlEl = el
      break
    }
    el = el.parentElement
  }
  if (!htmlEl) return false

  // Ctrl/Cmd + 点击不展开(留给未来可能的"跳转"功能;当前只是不拦截)
  if (event.ctrlKey || event.metaKey) return false

  event.preventDefault()

  // 从 DOM 元素找到对应的 doc 位置
  const pos = view.posAtDOM(htmlEl, 0)
  if (pos == null || pos < 0) return false

  const node = view.state.doc.nodeAt(pos)
  if (!node) return false

  if (node.type.name !== 'html_inline') return false

  const source = node.attrs.value as string
  if (!source) return false

  // 替换 atom 节点为源码文本,光标落在源码首字符后
  let tr = view.state.tr.replaceWith(pos, pos + node.nodeSize, view.state.schema.text(source))
  tr = tr.setSelection(TextSelection.create(tr.doc, pos + 1))
  // 瞬时视图切换(html atom → 源码纯文本),不是内容编辑 —— 跳过内容回写
  tr = tr.setMeta(SKIP_CONTENT_EMIT, true)
  tr = tr.setMeta(htmlSourceEditKey, {
    type: 'start' as const,
    session: {
      editFrom: pos,
      editTo: pos + source.length,
      originalSource: source,
    },
  })
  view.dispatch(tr)
  return true
}

// ============================================================
//  Commit handlers
// ============================================================

/** 简单校验 HTML 标签是否平衡（开/闭配对）。
 *  不平衡时 commit 退化为纯文本，避免残缺标签被 DOMPurify 容错渲染后
 *  看起来仍然有效但实际破坏 round-trip（如 `</sup>` 删成 `</sp>`）。
 *  不覆盖所有 edge case，但能挡住常见的"删了一个字母导致标签残缺"。 */
function isBalancedHtml(source: string): boolean {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?\/?>/g
  const voidTags = new Set([
    'br', 'hr', 'img', 'input', 'meta', 'link', 'area',
    'base', 'col', 'embed', 'source', 'track', 'wbr',
  ])
  const stack: string[] = []
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(source)) !== null) {
    const tag = m[0]
    const name = m[1].toLowerCase()
    if (tag.startsWith('</')) {
      if (stack.length === 0 || stack[stack.length - 1] !== name) return false
      stack.pop()
    } else if (!tag.endsWith('/>') && !voidTags.has(name)) {
      stack.push(name)
    }
  }
  return stack.length === 0
}

/** 把 [editFrom, editTo] 范围重建为 html_inline 节点。
 *  源码 HTML 标签不平衡时退化为纯文本（不创建 html_inline 节点）。 */
function commitHtmlEdit(view: EditorView): void {
  const pluginState = htmlSourceEditKey.getState(view.state)
  if (!pluginState?.session) return

  const { editFrom, editTo } = pluginState.session
  const sourceText = view.state.doc.textBetween(editFrom, editTo, '\n', '\n')

  let tr = view.state.tr.setMeta(htmlSourceEditKey, { type: 'commit' as const })

  const type = view.state.schema.nodes.html_inline
  const trimmed = sourceText.trim()
  if (type && trimmed && isBalancedHtml(sourceText)) {
    // 合法 HTML → 重建 html_inline 节点,NodeSelection 选中
    tr = tr.replaceWith(editFrom, editTo, type.create({ value: sourceText }))
    tr = tr.setSelection(NodeSelection.create(tr.doc, editFrom))
  } else if (trimmed === '') {
    // 空源码 → 删除
    tr = tr.delete(editFrom, editTo)
    tr = tr.setSelection(TextSelection.create(tr.doc, editFrom))
  } else {
    // 标签不平衡 / type 不存在 → 保留纯文本（退化）
    tr = tr.setSelection(TextSelection.create(tr.doc, editFrom))
  }
  view.dispatch(tr)
}

/** 把 code_block 重建为 html_block 节点。 */
function commitBlockHtmlEdit(view: EditorView): void {
  const pluginState = htmlSourceEditKey.getState(view.state)
  if (!pluginState?.blockSession) return

  const { blockPos } = pluginState.blockSession
  const node = view.state.doc.nodeAt(blockPos)

  let tr = view.state.tr.setMeta(htmlSourceEditKey, { type: 'commitBlock' as const })

  if (!node || node.type.name !== 'code_block') {
    // code_block 已被删除,只清 session
    view.dispatch(tr)
    return
  }

  const sourceText = node.textContent
  const htmlBlockType = view.state.schema.nodes.html_block
  if (htmlBlockType) {
    const htmlBlock = htmlBlockType.create({ value: sourceText })
    tr = tr.replaceWith(blockPos, blockPos + node.nodeSize, htmlBlock)
    tr = tr.setSelection(NodeSelection.create(tr.doc, blockPos))
  }
  view.dispatch(tr)
}
