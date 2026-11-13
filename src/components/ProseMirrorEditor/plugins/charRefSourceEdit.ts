// 字符实体源码态 —— Typora 风格的「聚焦显示实体字面量,移开还原」。
//
// 与 mark/emoji/image 源码编辑同范式(把视图状态临时写进 doc),退出条件对齐
// 这些 session:光标移出已展开区间就还原;编辑器失焦也还原(兜底)。全局搜索
// 命中跳过来会一直显示 '&#x20;',直到用户把光标移到别处 / 失焦 —— 不再是
// 「只要编辑器还有焦点就一直赖着不还原」。
//
// 进入条件:编辑器有焦点 + 纯选区变化(点击 / 方向键 / 搜索 setSelection)+
// 选区与某个 char_ref text 节点相交。整个替换是一次 appendTransaction,挂
// SKIP_CONTENT_EMIT —— 瞬时视图切换不回写 content、不误标 dirty。
//
// 查找面板打开期间**不改 doc**(matches 坐标会漂移),改用纯 Decoration 把
// 命中到的 char_ref 节点原位显示成字面量(CSS ::after + data-char-ref);
// 高亮背景仍由 findHighlight 的 inline deco 画,两者叠加不冲突。

import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState, Selection, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Mark, Node as PMNode } from 'prosemirror-model'

import {
  CHAR_REF_MARK,
  CHAR_REF_RE,
  expandCharRefText,
  getCharRefSegments,
} from '../editor/charRef'
import type { CharRefSegment } from '../editor/charRef'
import { SKIP_CONTENT_EMIT } from '../editor/transactionMeta'
import { findHighlightKey, isFindReplaceActive } from '../findreplace/findHighlight'
import type { FindHighlight } from '../findreplace/findHighlight'
import { linkClickPluginKey } from './linkClick'
import { imageEditKey } from '../image/imageEditPlugin'
import { markSourceEditKey } from './markSourceEdit'
import { htmlSourceEditKey } from './htmlSourceEdit'
import { emojiSourceEditKey } from './emojiSourceEdit'

export const charRefSourceEditKey = new PluginKey<CharRefSourceEditState>('charRefSourceEdit')

// appendTransaction 没有 view 参数,用它读 editable / hasFocus(同 markSourceEdit)。
let editorView: EditorView | null = null

interface RevealedRange {
  /** 源码态下实体字面量区间(已映射到当前 doc) */
  from: number
  to: number
  /** 进入时的字面量;还原前校验,用户改过就不还原 */
  raw: string
  decoded: string
  segments: CharRefSegment[]
  /** 除 char_ref 外的原有 marks(strong / link ...),还原时保留 */
  marks: Mark[]
}

interface CharRefSourceEditState {
  revealed: RevealedRange[]
}

type CharRefMeta =
  /** keep/add 都是事务前坐标,state.apply 用 tr.mapping 统一映射 */
  | { type: 'sync', keep: RevealedRange[], add: RevealedRange[] }
  | { type: 'restore' }
  /** 不产生选区变化的点击 / 面板关闭,强制按当前选区重判一次 */
  | { type: 'check' }

function emptyState(): CharRefSourceEditState {
  return { revealed: [] }
}

/** 别的 source edit session 活跃时不新开实体源码态(mark 源码自己会输出实体字面量)。 */
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

function collectTargets(doc: PMNode, sel: Selection): RevealedRange[] {
  const out: RevealedRange[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const segments = getCharRefSegments(node)
    if (!segments) return
    const end = pos + node.nodeSize
    // 相交含两端边界:光标停在解码字符前/后(点击空白的常见落点)也算命中。
    if (pos <= sel.to && end >= sel.from) {
      out.push({
        from: pos,
        to: end,
        raw: expandCharRefText(segments),
        decoded: node.text,
        segments,
        marks: node.marks.filter(m => m.type.name !== CHAR_REF_MARK),
      })
    }
  })
  return out
}

function mapRange(r: RevealedRange, tr: Transaction): RevealedRange {
  return {
    ...r,
    from: tr.mapping.map(r.from, -1),
    to: tr.mapping.map(r.to, 1),
  }
}

interface SyncStep {
  from: number
  to: number
  node: PMNode
}

/**
 * 把 doc 对齐到「只展开与选区相交的实体」:光标移出区间的还原,新命中的展开。
 * 一次事务里同时做两类替换(倒序),避免光标从一处实体移到另一处时中间态闪烁。
 * 返回 null 表示无需改动。
 */
function buildSyncTransaction(state: EditorState, allowAdd: boolean): Transaction | null {
  const existing = charRefSourceEditKey.getState(state)?.revealed ?? []
  const sel = state.selection
  const charRefType = state.schema.marks[CHAR_REF_MARK]
  const keep = existing.filter(r => r.from <= sel.to && r.to >= sel.from)
  const add = allowAdd
    ? collectTargets(state.doc, sel).filter(t => !existing.some(r => r.from === t.from && r.to === t.to))
    : []
  const remove = existing.filter(r => !keep.includes(r))
  if (!remove.length && !add.length) return null

  const steps: SyncStep[] = []
  for (const r of remove) {
    // 用户改写了字面量 → 这段已是普通文本,保留编辑结果,只从 state 里丢掉。
    if (!charRefType || state.doc.textBetween(r.from, r.to, '\n', '\n') !== r.raw) continue
    steps.push({
      from: r.from,
      to: r.to,
      node: state.schema.text(r.decoded, r.marks.concat(charRefType.create({ segments: r.segments }))),
    })
  }
  for (const t of add) {
    steps.push({ from: t.from, to: t.to, node: state.schema.text(t.raw, t.marks) })
  }

  let tr = state.tr
  // 从后往前替换,前面的坐标不受影响。
  for (const s of [...steps].sort((a, b) => b.from - a.from)) {
    tr = tr.replaceWith(s.from, s.to, s.node)
  }
  tr = tr.setMeta(SKIP_CONTENT_EMIT, true)
  tr = tr.setMeta(charRefSourceEditKey, { type: 'sync', keep, add } as CharRefMeta)
  return tr
}

/** 还原全部实体源码态。返回是否真的 dispatch 了事务。 */
function restoreAll(view: EditorView): boolean {
  const state = charRefSourceEditKey.getState(view.state)
  if (!state?.revealed.length) return false
  const charRefType = view.state.schema.marks[CHAR_REF_MARK]
  let tr = view.state.tr
    .setMeta(charRefSourceEditKey, { type: 'restore' } as CharRefMeta)
    .setMeta(SKIP_CONTENT_EMIT, true)
  // 从后往前替换,前面的坐标不受影响。
  for (const r of [...state.revealed].sort((a, b) => b.from - a.from)) {
    if (!charRefType) continue
    if (tr.doc.textBetween(r.from, r.to, '\n', '\n') !== r.raw) {
      // 用户改写了字面量 → 这段已经是普通文本,保留编辑结果,不重建 mark。
      continue
    }
    tr = tr.replaceWith(r.from, r.to, view.state.schema.text(
      r.decoded,
      r.marks.concat(charRefType.create({ segments: r.segments })),
    ))
  }
  view.dispatch(tr)
  return true
}

/** 供查找后端在算 matches 前调用:统一 doc 形态到渲染态(同 flushMarkSourceEdit)。 */
export function flushCharRefReveal(view: EditorView): void {
  restoreAll(view)
}

/** 查找面板关闭 / 焦点回编辑器后,按当前选区重判一次(选区不在实体上就是空操作)。 */
export function recheckCharRefReveal(view: EditorView): void {
  if (view.isDestroyed || !view.editable || !view.hasFocus()) return
  if (isFindReplaceActive(view.state)) return
  view.dispatch(view.state.tr.setMeta(charRefSourceEditKey, { type: 'check' } as CharRefMeta))
}

// Decoration 只跟 doc 内容有关(源码态下 doc 里是实体字面量纯文本)。
// state.doc 是不可变值,只按引用 memo,选区 / setMeta 事务不会重扫全文。
let lastDoc: PMNode | null = null
let lastDecos: DecorationSet | null = null
let lastFindHl: FindHighlight | null = null

const RAW_LITERAL_EXCLUDED_BLOCKS = new Set([
  'code_block', 'math_block', 'frontmatter', 'html_block',
])

/** doc 里已经是字面量的实体(mark/emoji 源码编辑态、代码块外的裸串)上浅灰色。 */
function collectRawLiteralDecorations(doc: PMNode): Decoration[] {
  const decos: Decoration[] = []
  doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text || !node.text.includes('&')) return
    if (parent && RAW_LITERAL_EXCLUDED_BLOCKS.has(parent.type.name)) return
    if (node.marks.some(m => m.type.name === 'code')) return
    CHAR_REF_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = CHAR_REF_RE.exec(node.text)) !== null) {
      decos.push(Decoration.inline(pos + m.index, pos + m.index + m[0].length, {
        class: 'velo-char-ref-source',
      }))
    }
  })
  return decos
}

/**
 * 查找面板打开期间不能改 doc,用 inline 装饰把「命中到的实体解码字符」原位换成
 * 字面量(CSS ::after 读 data-char-ref)。一个 text 节点可能含多个实体,按 segment
 * 切分只装饰真正被 match 覆盖的那些,避免整段被撑开。
 */
function collectFindMatchDecorations(doc: PMNode, hl: FindHighlight): Decoration[] {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const segments = getCharRefSegments(node)
    if (!segments) return
    let offset = 0
    for (const seg of segments) {
      const from = pos + offset
      const to = from + seg.text.length
      offset += seg.text.length
      if (to <= from) continue
      if (!hl.matches.some(m => m.from < to && m.to > from)) continue
      decos.push(Decoration.inline(from, to, {
        class: 'velo-char-ref-inline',
        'data-char-ref': seg.raw,
      }))
    }
  })
  return decos
}

export const charRefSourceEditPlugin = new Plugin<CharRefSourceEditState>({
  key: charRefSourceEditKey,

  state: {
    init: emptyState,
    apply(tr, value) {
      const meta = tr.getMeta(charRefSourceEditKey) as CharRefMeta | undefined
      if (meta?.type === 'restore') return emptyState()
      if (meta?.type === 'sync') {
        return {
          revealed: [...meta.keep, ...meta.add]
            .map(r => mapRange(r, tr))
            .filter(r => r.to > r.from),
        }
      }
      // 用户键入 / 外部替换会让已展开区间平移,必须逐笔映射 —— 不能按 length
      // 相等复用旧 value,否则坐标会停在替换前(失焦还原写错位置)。
      return { revealed: value.revealed.map(r => mapRange(r, tr)).filter(r => r.to > r.from) }
    },
  },

  props: {
    decorations(state) {
      const hl = findHighlightKey.getState(state)
      const activeHl = hl?.active && hl.matches.length ? hl : null
      // 面板没开时纯按 doc 引用 memo;面板打开时 match 坐标会随导航变化,重算。
      if (state.doc === lastDoc && lastDecos && !activeHl && !lastFindHl) return lastDecos
      const decos = collectRawLiteralDecorations(state.doc)
      if (activeHl) decos.push(...collectFindMatchDecorations(state.doc, activeHl))
      lastDoc = state.doc
      lastFindHl = activeHl
      lastDecos = DecorationSet.create(state.doc, decos)
      return lastDecos
    },

    handleDOMEvents: {
      mousedown(view) {
        // 失焦还原后光标仍在原位置,再点同一空白处 PM 不派 selection-only 事务
        // (光标没动),appendTransaction 的「纯选区变化」守卫会漏掉。下一轮事件循环
        // 补一笔 check meta 让守卫重判;常规点击产生的 sync 会被 existing 去重。
        setTimeout(() => {
          if (editorView !== view || !view.editable || !view.hasFocus()) return
          if (isFindReplaceActive(view.state)) return
          if (inOtherEditSession(view.state, view.state.selection.head)) return
          const existing = charRefSourceEditKey.getState(view.state)?.revealed ?? []
          const targets = collectTargets(view.state.doc, view.state.selection)
          if (!targets.some(t => !existing.some(r => r.from === t.from && r.to === t.to))) return
          view.dispatch(view.state.tr.setMeta(charRefSourceEditKey, { type: 'check' } as CharRefMeta))
        }, 0)
        return false
      },
    },
  },

  appendTransaction(transactions, _oldState, newState) {
    if (!editorView || !editorView.editable || !editorView.hasFocus()) return null
    if (isFindReplaceActive(newState)) return null
    const forced = transactions.some(t =>
      (t.getMeta(charRefSourceEditKey) as CharRefMeta | undefined)?.type === 'check')
    const moved = forced || transactions.some(t => t.selectionSet && !t.docChanged)
    if (!moved) return null
    // 别的 session 活跃时只还原文、不新开(mark 源码态自己会输出实体字面量)。
    const allowAdd = !inOtherEditSession(newState, newState.selection.head)
    return buildSyncTransaction(newState, allowAdd)
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
