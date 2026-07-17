// 行内 HTML 源码编辑 — Obsidian 风格的 click-to-expand source edit。
//
// 用户交互流程:
//   1. 点击 html_inline atom 节点 → 替换成原始 HTML 源码文本
//      (attrs.value),光标落进源码首字符后,Decoration 加 .velo-html-source-edit
//      视觉指示。
//   2. 编辑态下:
//      - 用户编辑文本 → 普通 transaction,plugin state 随位置平移
//      - 光标移出源码范围 → apply 检测到,view.update 触发 commit
//      - commit:把源码文本重建为 html_inline 节点(NodeSelection 选中)
//      - Escape → keymap 还原成点击前的原始源码(放弃编辑)
//
// 设计要点(对照 imageEditPlugin.ts / linkClick.ts):
//  - html_inline 是 atom 节点(同 image),走"替换成纯文本"而非
//    linkClick 的"剥 mark";session 状态机(apply mapping + pendingCommit +
//    view.update 触发 commit + Escape 还原)完全复用 imageEdit 骨架。
//  - 触发用 handleDOMEvents.click(同 linkClick),检测点击目标是否在
//    .velo-html-inline 内。
//  - commit 后用 NodeSelection 选中重建的 HTML 节点(同 imageEdit)。
//  - trigger 事务挂 SKIP_CONTENT_EMIT —— 瞬时视图切换不是内容编辑。
//  - 块级 HTML (html_block) 不走点击展开 —— 块级 HTML 源码常含换行,
//    替换成纯文本后 PM 段落切分 / remark 重解析会破坏节点结构。
//    块级 HTML 的源码切换留待后续以 Typora 风格按钮实现。

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

interface HtmlEditState {
  session: HtmlEditSession | null
  pendingCommit: HtmlEditSession | null
}

function emptyState(): HtmlEditState {
  return { session: null, pendingCommit: null }
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
        | undefined

      if (meta?.type === 'start') {
        return { session: meta.session, pendingCommit: null }
      }
      if (meta?.type === 'commit' || meta?.type === 'cancel') {
        return emptyState()
      }
      if (!value.session) return value

      const session = value.session
      const editFrom = tr.mapping.map(session.editFrom, 1)
      const editTo = tr.mapping.map(session.editTo, -1)
      const updated: HtmlEditSession = { ...session, editFrom, editTo }

      const sel = newState.selection
      const inside = sel.from >= editFrom && sel.to <= editTo
      return { session: updated, pendingCommit: inside ? null : updated }
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
      if (!pluginState?.session) return DecorationSet.empty
      const { editFrom, editTo } = pluginState.session
      return DecorationSet.create(state.doc, [
        Decoration.inline(editFrom, editTo, { class: 'velo-html-source-edit' }),
      ])
    },
  },

  view(_view) {
    return {
      update(view) {
        const pluginState = htmlSourceEditKey.getState(view.state)
        if (pluginState?.pendingCommit) {
          commitHtmlEdit(view)
        }
      },
    }
  },
})

/** Escape → 放弃编辑,还原成点击前的 html_inline 节点(原始 attrs.value)。 */
export const htmlSourceEditEscapeKeymap = keymap({
  Escape: (state, dispatch) => {
    const pluginState = htmlSourceEditKey.getState(state)
    if (!pluginState?.session) return false

    const { editFrom, editTo, originalSource } = pluginState.session
    if (dispatch) {
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
    }
    return true
  },
})

// ============================================================
//  Click handler
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
