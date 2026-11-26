// 反斜杠转义源码态 —— Typora 风格的「默认展示转义字符，光标进入展开 `\`，移开还原」。
//
// 与 charRefSourceEdit / markSourceEdit 同范式：
//   - 进入条件：编辑器可编辑 + 有焦点 + 纯选区变化（点击 / 方向键 / 搜索跳转）+
//     选区与带 escape mark 的 text 节点相交（含两端边界，1 字符转义无内部位置）。
//     事务挂 SKIP_CONTENT_EMIT，不触发 content 回写、不误标 dirty。
//   - 展示样式：展开后的 `\` 挂 `.velo-escape-slash`（浅灰 `--editor-text-muted`），
//     字符本身保持正文色；markSourceEdit 源码态内出现的 `\<punct>` 同步上色。
//   - 离开 / 失焦：
//     - 未修改 → 还原为解码字符 + escape mark（挂 SKIP_CONTENT_EMIT）；
//     - 用户改写（如删掉 `\` 取消转义，或改成 `\[`）→ 按编辑结果提交（不挂 SKIP_CONTENT_EMIT）。
//   - 查找面板打开期间不改 doc（防 matches 坐标漂移），改用纯装饰 `.velo-escape-inline`
//     在命中的转义字符前用 CSS `::before` 临时显示浅灰 `\`。

import { keymap } from 'prosemirror-keymap'
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { EditorState, Selection, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Mark, Node as PMNode, Schema } from 'prosemirror-model'

import {
  ESCAPE_MARK,
  ESCAPE_PAIR_RE,
  expandEscapedText,
  expandedOffsetFor,
  hasEscapeMark,
} from '../editor/escape'
import { SKIP_CONTENT_EMIT } from '../editor/transactionMeta'
import { findHighlightKey, isFindReplaceActive } from '../findreplace/findHighlight'
import type { FindHighlight } from '../findreplace/findHighlight'
import { linkClickPluginKey } from './linkClick'
import { imageEditKey } from '../image/imageEditPlugin'
import { markSourceEditKey } from './markSourceEdit'
import { htmlSourceEditKey } from './htmlSourceEdit'
import { emojiSourceEditKey } from './emojiSourceEdit'

export const escapeSourceEditKey = new PluginKey<EscapeSourceEditState>('escapeSourceEdit')

// appendTransaction 没有 view 参数，用模块级引用读 editable / hasFocus（同 charRefSourceEdit）。
let editorView: EditorView | null = null

interface RevealedEscapeRange {
  /** 源码态下 `\*` 区间（已映射到当前 doc） */
  from: number
  to: number
  /** 进入时的源码（如 `\*`）；离开时比对判断是否被用户编辑过 */
  raw: string
  /** 进入时的解码文本（如 `*`） */
  decoded: string
  /** 除 escape 外的原有 marks（strong / emphasis / link ...），还原时保留 */
  marks: Mark[]
}

interface EscapeSourceEditState {
  revealed: RevealedEscapeRange[]
}

type EscapeMeta =
  | { type: 'sync', keep: RevealedEscapeRange[], add: RevealedEscapeRange[] }
  | { type: 'restore' }
  | { type: 'check' }

function emptyState(): EscapeSourceEditState {
  return { revealed: [] }
}

/** 别的 source edit session 活跃时不新开转义源码态（mark 源码态自己会输出 `\<char>`）。 */
function inOtherEditSession(state: EditorState, pos: number): boolean {
  const sessions = [
    linkClickPluginKey.getState(state)?.session,
    imageEditKey.getState(state)?.session,
    markSourceEditKey.getState(state)?.session,
    htmlSourceEditKey.getState(state)?.session,
    emojiSourceEditKey.getState(state)?.session,
  ]
  return sessions.some(s => s && pos >= s.editFrom && pos <= s.editTo)
}

function collectTargets(doc: PMNode, sel: Selection): RevealedEscapeRange[] {
  const out: RevealedEscapeRange[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text || !hasEscapeMark(node)) return
    const end = pos + node.nodeSize
    // 含两端边界：1 字符的转义符号没有内部位置，点击或方向键落到左右边界即展开。
    if (pos <= sel.to && end >= sel.from) {
      out.push({
        from: pos,
        to: end,
        raw: expandEscapedText(node.text),
        decoded: node.text,
        marks: node.marks.filter(m => m.type.name !== ESCAPE_MARK),
      })
    }
  })
  return out
}

function mapSyncRange(r: RevealedEscapeRange, tr: Transaction): RevealedEscapeRange {
  return {
    ...r,
    from: tr.mapping.map(r.from, -1),
    to: tr.mapping.map(r.to, 1),
  }
}

/** 普通编辑事务：边界外键入留在区间外（from +1 / to -1），内部编辑留在区间内。 */
function mapEditRange(r: RevealedEscapeRange, tr: Transaction): RevealedEscapeRange {
  return {
    ...r,
    from: tr.mapping.map(r.from, 1),
    to: tr.mapping.map(r.to, -1),
  }
}

/**
 * 把用户编辑后的源码文本重新切分为普通文本与带 escape mark 的文本节点：
 * - 删掉 `\`（`\*` → `*`）→ 普通文本 `*`（取消转义）
 * - 改成另一转义（`\*` → `\[`）→ 带 escape mark 的 `[`
 * - 删掉字符只留 `\` → 普通文本 `\`
 */
function parseEditedEscapeNodes(text: string, baseMarks: Mark[], schema: Schema): PMNode[] {
  const escapeType = schema.marks[ESCAPE_MARK]
  if (!text) return []
  if (!escapeType) return [schema.text(text, baseMarks)]

  const out: PMNode[] = []
  ESCAPE_PAIR_RE.lastIndex = 0
  let lastIdx = 0
  let m: RegExpExecArray | null
  while ((m = ESCAPE_PAIR_RE.exec(text)) !== null) {
    if (m.index > lastIdx) {
      out.push(schema.text(text.slice(lastIdx, m.index), baseMarks))
    }
    out.push(schema.text(m[1], baseMarks.concat(escapeType.create())))
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < text.length) {
    out.push(schema.text(text.slice(lastIdx), baseMarks))
  }
  return out
}

interface SyncStep {
  from: number
  to: number
  nodes: PMNode[]
  /** 对应的 add 目标（用于计算展开后的精确光标落点） */
  addedTarget?: RevealedEscapeRange
}

function buildSyncTransaction(state: EditorState, allowAdd: boolean): Transaction | null {
  const existing = escapeSourceEditKey.getState(state)?.revealed ?? []
  const sel = state.selection
  const escapeType = state.schema.marks[ESCAPE_MARK]
  const keep = existing.filter(r => r.from <= sel.to && r.to >= sel.from)
  const add = allowAdd
    ? collectTargets(state.doc, sel).filter(t => !existing.some(r => r.from === t.from && r.to === t.to))
    : []
  const remove = existing.filter(r => !keep.includes(r))
  if (!remove.length && !add.length) return null

  const steps: SyncStep[] = []
  let hasUserEdit = false

  for (const r of remove) {
    if (!escapeType) continue
    const current = state.doc.textBetween(r.from, r.to, '\n', '\n')
    if (current === r.raw) {
      steps.push({
        from: r.from,
        to: r.to,
        nodes: [state.schema.text(r.decoded, r.marks.concat(escapeType.create()))],
      })
    } else {
      hasUserEdit = true
      const parsed = parseEditedEscapeNodes(current, r.marks, state.schema)
      // 文本里无新转义时（如把 `\*` 改成了 `*` 或 `\`），保持原地不动即可，避免多余 step。
      if (parsed.some(n => hasEscapeMark(n))) {
        steps.push({ from: r.from, to: r.to, nodes: parsed })
      }
    }
  }
  for (const t of add) {
    steps.push({
      from: t.from,
      to: t.to,
      nodes: [state.schema.text(t.raw, t.marks)],
      addedTarget: t,
    })
  }

  // 记录空选区落入新展开目标时的原始相对偏移，替换后重设光标，
  // 确保左右方向键穿越 `a*b` 时左右边界对称且不陷入回弹死循环。
  let cursorTarget: { origFrom: number, expandedOffset: number } | null = null
  if (sel.empty) {
    const hit = add.find(t => sel.head >= t.from && sel.head <= t.to)
    if (hit) {
      cursorTarget = {
        origFrom: hit.from,
        expandedOffset: expandedOffsetFor(hit.decoded, sel.head - hit.from),
      }
    }
  }

  let tr = state.tr
  for (const s of [...steps].sort((a, b) => b.from - a.from)) {
    if (s.nodes.length === 0) {
      tr = tr.delete(s.from, s.to)
    } else {
      tr = tr.replaceWith(s.from, s.to, s.nodes)
    }
  }

  if (cursorTarget) {
    let deltaBefore = 0
    for (const s of steps) {
      if (s.from < cursorTarget.origFrom) {
        const newLen = s.nodes.reduce((sum, n) => sum + n.nodeSize, 0)
        deltaBefore += newLen - (s.to - s.from)
      }
    }
    const targetPos = Math.max(
      0,
      Math.min(tr.doc.content.size, cursorTarget.origFrom + deltaBefore + cursorTarget.expandedOffset),
    )
    tr = tr.setSelection(TextSelection.create(tr.doc, targetPos))
  }

  if (!hasUserEdit) {
    tr = tr.setMeta(SKIP_CONTENT_EMIT, true)
  }
  tr = tr.setMeta(escapeSourceEditKey, { type: 'sync', keep, add } as EscapeMeta)
  return tr
}

/** 还原全部转义源码态。返回是否真的 dispatch 了事务。 */
function restoreAll(view: EditorView): boolean {
  const pluginState = escapeSourceEditKey.getState(view.state)
  if (!pluginState?.revealed.length) return false
  const escapeType = view.state.schema.marks[ESCAPE_MARK]
  let hasUserEdit = false
  let tr = view.state.tr.setMeta(escapeSourceEditKey, { type: 'restore' } as EscapeMeta)

  for (const r of [...pluginState.revealed].sort((a, b) => b.from - a.from)) {
    if (!escapeType) continue
    const current = tr.doc.textBetween(r.from, r.to, '\n', '\n')
    if (current === r.raw) {
      tr = tr.replaceWith(
        r.from,
        r.to,
        view.state.schema.text(r.decoded, r.marks.concat(escapeType.create())),
      )
    } else {
      hasUserEdit = true
      const parsed = parseEditedEscapeNodes(current, r.marks, view.state.schema)
      if (parsed.some(n => hasEscapeMark(n))) {
        tr = tr.replaceWith(r.from, r.to, parsed)
      }
    }
  }

  if (!hasUserEdit) {
    tr = tr.setMeta(SKIP_CONTENT_EMIT, true)
  }
  view.dispatch(tr)
  return true
}

/** 供查找后端在算 matches 前调用：统一 doc 形态到渲染态（同 flushCharRefReveal）。 */
export function flushEscapeReveal(view: EditorView): void {
  restoreAll(view)
}

/** 查找面板关闭 / 焦点回编辑器后，按当前选区重判一次。 */
export function recheckEscapeReveal(view: EditorView): void {
  if (view.isDestroyed || !view.editable || !view.hasFocus()) return
  if (isFindReplaceActive(view.state)) return
  view.dispatch(view.state.tr.setMeta(escapeSourceEditKey, { type: 'check' } as EscapeMeta))
}

function collectSlashDecorationsInRange(doc: PMNode, from: number, to: number): Decoration[] {
  const decos: Decoration[] = []
  if (to <= from) return decos
  const text = doc.textBetween(from, to, '\n', '\n')
  ESCAPE_PAIR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ESCAPE_PAIR_RE.exec(text)) !== null) {
    decos.push(Decoration.inline(from + m.index, from + m.index + 1, {
      class: 'velo-escape-slash',
    }))
  }
  return decos
}

/** 查找面板打开期间不能改 doc，用纯装饰在命中的转义字符前显示浅灰 `\`。 */
function collectFindMatchDecorations(doc: PMNode, hl: FindHighlight): Decoration[] {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text || !hasEscapeMark(node)) return
    for (let k = 0; k < node.text.length; k++) {
      const from = pos + k
      const to = from + 1
      if (!hl.matches.some(m => m.from < to && m.to > from)) continue
      decos.push(Decoration.inline(from, to, { class: 'velo-escape-inline' }))
    }
  })
  return decos
}

export const escapeSourceEditPlugin = new Plugin<EscapeSourceEditState>({
  key: escapeSourceEditKey,

  state: {
    init: emptyState,
    apply(tr, value) {
      const meta = tr.getMeta(escapeSourceEditKey) as EscapeMeta | undefined
      if (meta?.type === 'restore') return emptyState()
      if (meta?.type === 'sync') {
        return {
          revealed: [...meta.keep, ...meta.add]
            .map(r => mapSyncRange(r, tr))
            .filter(r => r.to > r.from),
        }
      }
      return {
        revealed: value.revealed.map(r => mapEditRange(r, tr)).filter(r => r.to > r.from),
      }
    },
  },

  props: {
    decorations(state) {
      const decos: Decoration[] = []
      const revealed = escapeSourceEditKey.getState(state)?.revealed ?? []
      for (const r of revealed) {
        decos.push(...collectSlashDecorationsInRange(state.doc, r.from, r.to))
      }
      // markSourceEdit 展开态中的 `\*` / `\[` 同步给 `\` 挂浅灰提示色。
      const markSession = markSourceEditKey.getState(state)?.session
      if (markSession) {
        decos.push(...collectSlashDecorationsInRange(state.doc, markSession.editFrom, markSession.editTo))
      }
      const hl = findHighlightKey.getState(state)
      if (hl?.active && hl.matches.length) {
        decos.push(...collectFindMatchDecorations(state.doc, hl))
      }
      return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty
    },

    handleDOMEvents: {
      mousedown(view) {
        // 失焦还原后光标仍在原位置，再点同一处不产生 selection-only 事务，补一笔 check meta。
        setTimeout(() => {
          if (editorView !== view || !view.editable || !view.hasFocus()) return
          if (isFindReplaceActive(view.state)) return
          if (inOtherEditSession(view.state, view.state.selection.head)) return
          const existing = escapeSourceEditKey.getState(view.state)?.revealed ?? []
          const targets = collectTargets(view.state.doc, view.state.selection)
          if (!targets.some(t => !existing.some(r => r.from === t.from && r.to === t.to))) return
          view.dispatch(view.state.tr.setMeta(escapeSourceEditKey, { type: 'check' } as EscapeMeta))
        }, 0)
        return false
      },
    },
  },

  appendTransaction(transactions, _oldState, newState) {
    if (!editorView || !editorView.editable || !editorView.hasFocus()) return null
    if (isFindReplaceActive(newState)) return null
    const forced = transactions.some(t =>
      (t.getMeta(escapeSourceEditKey) as EscapeMeta | undefined)?.type === 'check')
    const moved = forced || transactions.some(t => t.selectionSet && !t.docChanged)
    if (moved) {
      const allowAdd = !inOtherEditSession(newState, newState.selection.head)
      return buildSyncTransaction(newState, allowAdd)
    }
    // 边界外继续键入（如在 `128\*|128` 处输入新字符）使光标离开已展开区间：
    // 仅还原已离开的区间，不新开。
    const existing = escapeSourceEditKey.getState(newState)?.revealed ?? []
    const sel = newState.selection
    if (existing.some(r => !(r.from <= sel.to && r.to >= sel.from))) {
      return buildSyncTransaction(newState, false)
    }
    return null
  },

  view(initialView) {
    editorView = initialView
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target
      if (target instanceof Node && initialView.dom.contains(target)) return
      restoreAll(initialView)
    }
    const onWindowBlur = () => restoreAll(initialView)
    document.addEventListener('focusin', onFocusIn, true)
    window.addEventListener('blur', onWindowBlur)
    return {
      destroy() {
        document.removeEventListener('focusin', onFocusIn, true)
        window.removeEventListener('blur', onWindowBlur)
        editorView = null
      },
    }
  },
})

/** Escape → 还原所有展开中的转义字符为原始渲染态（放弃编辑）。 */
export const escapeSourceEditEscapeKeymap = keymap({
  Escape: (state, dispatch) => {
    const pluginState = escapeSourceEditKey.getState(state)
    if (!pluginState?.revealed.length) return false
    if (!dispatch) return true
    const escapeType = state.schema.marks[ESCAPE_MARK]
    let tr = state.tr
      .setMeta(escapeSourceEditKey, { type: 'restore' } as EscapeMeta)
      .setMeta(SKIP_CONTENT_EMIT, true)
    for (const r of [...pluginState.revealed].sort((a, b) => b.from - a.from)) {
      if (!escapeType) continue
      tr = tr.replaceWith(
        r.from,
        r.to,
        state.schema.text(r.decoded, r.marks.concat(escapeType.create())),
      )
    }
    dispatch(tr)
    return true
  },
})
