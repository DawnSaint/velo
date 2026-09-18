// Diff Decoration Plugin —— WYSIWYG diff 模式的核心插件
//
// 渲染语义(#diff-wysiwyg / #diff-semantic-render):
// - added 文本:
//   整 block 新增 → Decoration.node 给整个 block 加背景
//   块内字符级新增 → Decoration.inline 只标记变化的字符
// - removed 文本 → Decoration.widget 红色背景文本片段(不占文档 pos,只视觉呈现),
//   配对修改的删除字符原位显示(VSCode 风格)
// - 整 block 删除 → 序列化旧 block 的带样式只读片段(标题保留字号、
//   列表保留缩进),而非裸文本
// - 同文异 key:
//   节点类型变更 → 左侧条 + tooltip(「段落 → 标题 2」)
//   仅格式变更 → 变化区间 Decoration.inline(amber 底 + tooltip「格式变更」)
//   其他(非文本 leaf 变更)→ 整块 amber 底色
// - 拆分 / 合并 → 边界提示 widget(「段落在此拆分」/「N 个段落已合并」)
//
// 注:未变更区折叠 + hunk 导航 + 首次进入自动跳转(#diff-autoscroll)已回退,
// 当前为未完成状态 —— 全文渲染,不做折叠。
//
// 比对层为 Block Tree Diff(blockDiff.ts):顶层 block 序列上跑 Myers,
// key 含类型 / attrs / 文本 / marks / 非文本 leaf,格式与结构变更不再不可见。
//
// 增量渲染(#diff-incremental):
// - 比对结果一次性算成 `DiffPlan`(按 op 分 entry),把"op → decoration 构造"
//   与"哪些 op 已经建进 DecorationSet"解耦
// - `decorations()` 只对本批次(视口内 + 粘性已建)的同 op 装饰,长文档不必
//   一次性为全文档构建 widget DOM
// - 滚动由 viewportPlugin 派 meta,只**追加**新进视口 op 的 decoration
//   (同 CodeHighlightWidget 的 seenSet 粘性范式:doc 只读,已建结果永久有效)
// - 选中版本条目变化时调用方只 dispatch setMeta({ oldDoc }),不销毁 EditorView
//
// 与 findHighlight / cjkLetterSpacing 同范式:
// - PluginKey 持有 diff 结果,apply 读 meta 更新,decorations 返回 DecorationSet

import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView } from 'prosemirror-view'
import { DOMSerializer } from 'prosemirror-model'
import type { Node as PMNode } from 'prosemirror-model'
import { diffChars } from '@/utils/lineDiff'
import {
  diffBlocks,
  diffInlineMarkRanges,
  nodeTypeLabel,
  type BlockEntry,
} from './blockDiff'
import { getViewport, isInViewport, viewportKey } from '../nodes/viewportPlugin'

export const diffDecorationKey = new PluginKey<DiffDecorationState>('veloDiffDecoration')

// ========== Diff Plan ==========

/** 一处变更 / 一段未变更 = 一个 entry。增量构建按 entry 粒度分批 */
export interface DiffPlanEntry {
  /** true = 变更 op(insert/delete/pair/split/merge);false = 未变更 block */
  changed: boolean
  /** 覆盖的 doc 范围(视口过滤用);delete 的 widget entry from === to */
  from: number
  to: number
  /** 该区域的装饰;未变更区为空 */
  decos: Decoration[]
}

export interface DiffPlan {
  entries: DiffPlanEntry[]
}

interface DiffDecorationState {
  /** 旧版本 PM Node(用于 diff 计算)。null = 无 diff,不渲染装饰 */
  oldDoc: PMNode | null
  plan: DiffPlan | null
  /** 已建进 decoSet 的 entry 下标(粘性:doc 只读,已建结果永久有效) */
  built: Set<number> | null
  decoSet: DecorationSet | null
}

export type DiffDecorationMeta = { oldDoc: PMNode | null }

// ============================================================
//  块内 offset → doc pos 映射
// ============================================================

/**
 * 把块内文本偏移量映射回 doc 绝对 pos。
 * 超出全部 segments(空块 / 偏移落在末尾)时返回块内容末尾。
 */
function offsetInBlock(offset: number, block: BlockEntry): number {
  if (block.segments.length === 0) return block.pos + 1
  let cum = 0
  for (const seg of block.segments) {
    if (offset < cum + seg.text.length) {
      return seg.pos + (offset - cum)
    }
    cum += seg.text.length
  }
  const last = block.segments[block.segments.length - 1]
  return last.pos + last.text.length
}

// ============================================================
//  装饰构造
// ============================================================

/** 构建红色删除 widget Decoration(配对修改的字符级删除,原位显示) */
function removedWidget(pos: number, text: string): Decoration {
  return Decoration.widget(pos, () => {
    const span = document.createElement('span')
    span.className = 'velo-diff-removed'
    span.textContent = text
    return span
  }, { side: -1 })
}

/**
 * 整 block 删除的 widget:序列化旧 block 为带样式的只读片段
 * (标题保留字号、列表保留缩进、图片 / 分割线保留原形),
 * 而非裸文本摘要。结构 + marks 都由 schema 的 toDOM 自然保留。
 */
function deletedBlockWidget(pos: number, node: PMNode): Decoration {
  return Decoration.widget(pos, () => {
    const wrapper = document.createElement('div')
    wrapper.className = 'velo-diff-deleted-block'
    wrapper.setAttribute('contenteditable', 'false')
    const frag = DOMSerializer.fromSchema(node.type.schema).serializeNode(node)
    wrapper.appendChild(frag)
    return wrapper
  }, { side: -1 })
}

/** 拆分 / 合并的边界提示 widget(「段落在此拆分」/「N 个段落已合并」) */
function boundaryHintWidget(pos: number, text: string): Decoration {
  return Decoration.widget(pos, () => {
    const div = document.createElement('div')
    div.className = 'velo-diff-boundary-hint'
    div.textContent = text
    return div
  }, { side: -1 })
}

// ============================================================
//  diff → DiffPlan(换 diff 基准时算一次)
// ============================================================

/**
 * 算出 newDoc vs oldDoc 的完整 diff 计划:
 * - entries:每个 op 一组 decoration + 覆盖的 doc 范围
 *
 * block 序列对齐必须对全文跑,无法按视口切分;但"装饰构造"按 entry 分组后
 * 可以按需分批 —— 见 collectVisibleDecos。
 */
export function buildDiffPlan(newDoc: PMNode, oldDoc: PMNode): DiffPlan {
  const { ops, oldBlocks, newBlocks } = diffBlocks(oldDoc, newDoc)
  const entries: DiffPlanEntry[] = []

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]

    if (op.kind === 'insert') {
      const b = newBlocks[op.newIndex]
      entries.push({
        changed: true,
        from: b.pos,
        to: b.pos + b.size,
        decos: [Decoration.node(b.pos, b.pos + b.size, { class: 'velo-diff-added' })],
      })
    }
    else if (op.kind === 'delete') {
      const pos = widgetInsertPos(ops, i, newBlocks, newDoc)
      entries.push({
        changed: true,
        from: pos,
        to: pos,
        decos: [deletedBlockWidget(pos, oldBlocks[op.oldIndex].node)],
      })
    }
    else if (op.kind === 'split') {
      const decos: Decoration[] = []
      // 第 2..N 个新 block 前加边界提示(首 block 是拆分前内容的延续,不标)
      for (let k = 1; k < op.newIndices.length; k++) {
        decos.push(boundaryHintWidget(newBlocks[op.newIndices[k]].pos, '段落在此拆分'))
      }
      const first = newBlocks[op.newIndices[0]]
      const last = newBlocks[op.newIndices[op.newIndices.length - 1]]
      entries.push({ changed: true, from: first.pos, to: last.pos + last.size, decos })
    }
    else if (op.kind === 'merge') {
      const b = newBlocks[op.newIndex]
      entries.push({
        changed: true,
        from: b.pos,
        to: b.pos + b.size,
        decos: [boundaryHintWidget(b.pos, `${op.oldIndices.length} 个段落已合并`)],
      })
    }
    else if (op.kind === 'pair') {
      const b = newBlocks[op.newIndex]
      entries.push({
        changed: true,
        from: b.pos,
        to: b.pos + b.size,
        decos: buildPairDecorations(oldBlocks[op.oldIndex], b),
      })
    }
    else {
      const b = newBlocks[op.newIndex]
      entries.push({ changed: false, from: b.pos, to: b.pos + b.size, decos: [] })
    }
  }

  return { entries }
}

/** delete 的 widget 插入位置:其后第一个引用新 block 的 op 的 block pos;无 → 文档末尾 */
function widgetInsertPos(
  ops: ReturnType<typeof diffBlocks>['ops'],
  i: number,
  newBlocks: BlockEntry[],
  newDoc: PMNode,
): number {
  for (let j = i + 1; j < ops.length; j++) {
    const next = ops[j]
    if (next.kind === 'delete') continue
    const idx = next.kind === 'split' ? next.newIndices[0] : next.newIndex
    return newBlocks[idx].pos
  }
  return newDoc.content.size
}

/** pair op(「修改」)的装饰:字符级 diff,或同文异 key 的语义标记 */
function buildPairDecorations(oldBlock: BlockEntry, newBlock: BlockEntry): Decoration[] {
  const decos: Decoration[] = []

  if (oldBlock.text === newBlock.text) {
    // 文本相同但 key 不同:节点类型 / 格式 / 非文本 leaf 变更
    const oldLabel = nodeTypeLabel(oldBlock.node)
    const newLabel = nodeTypeLabel(newBlock.node)
    if (oldLabel !== newLabel) {
      // 节点类型变更(含标题级别 / 代码块语言等关键 attrs):左侧条 + tooltip
      decos.push(
        Decoration.node(newBlock.pos, newBlock.pos + newBlock.size, {
          class: 'velo-diff-changed velo-diff-type-changed',
          title: `${oldLabel} → ${newLabel}`,
        }),
      )
      return decos
    }
    // 仅格式变更(marks):精确到变化区间的 inline 标记 + tooltip
    const ranges = diffInlineMarkRanges(oldBlock.node, newBlock.node)
    if (ranges.length === 0) {
      // 非文本 leaf 变更(图片 src / alt 等):整块 amber 底色兜底
      decos.push(
        Decoration.node(newBlock.pos, newBlock.pos + newBlock.size, { class: 'velo-diff-changed' }),
      )
      return decos
    }
    for (const r of ranges) {
      const from = offsetInBlock(r.from, newBlock)
      const to = offsetInBlock(r.to, newBlock)
      if (from < to) {
        decos.push(
          Decoration.inline(from, to, { class: 'velo-diff-format-changed', title: '格式变更' }),
        )
      }
    }
    return decos
  }

  // 文本不同 → 块内字符级 diff(block 可能跨 500 字符的表格 / 列表,上限放宽到 4000)
  const segs = diffChars(oldBlock.text, newBlock.text, 4000)
  let off = 0
  for (const seg of segs) {
    if (seg.type === 'added') {
      const from = offsetInBlock(off, newBlock)
      const to = offsetInBlock(off + seg.text.length, newBlock)
      if (from < to) {
        decos.push(Decoration.inline(from, to, { class: 'velo-diff-added-inline' }))
      }
      off += seg.text.length
    }
    else if (seg.type === 'removed') {
      // removed 片段不占新文本 offset,widget 原位插入(被删字符的原位置)
      decos.push(removedWidget(offsetInBlock(off, newBlock), seg.text))
    }
    else {
      off += seg.text.length
    }
  }
  return decos
}

// ============================================================
//  按视口分批构建 DecorationSet(#diff-incremental)
// ============================================================

/**
 * 找出视口内尚未构建的 entry，返回它们的装饰 + 更新 built 集合。
 * - viewport 为 null(无滚动容器 / 未就绪)→ 全量,退化为旧行为
 * - built 就地累积:只读 doc,已建过的 entry 不必重复构造(widget DOM 开销),
 *   后续滚动只追加新进视口的 entry
 */
function collectVisibleDecos(
  plan: DiffPlan,
  built: Set<number>,
  viewport: ReturnType<typeof getViewport>,
): Decoration[] {
  const decos: Decoration[] = []

  plan.entries.forEach((entry, i) => {
    if (!built.has(i) && !isInViewport(entry.from, entry.to - entry.from, viewport)) return
    built.add(i)
    for (const d of entry.decos) decos.push(d)
  })

  return decos
}

/** 全量构建(无视口过滤 / 无折叠):测试与一次性场景用 */
export function buildDecorations(newDoc: PMNode, oldDoc: PMNode): Decoration[] {
  return buildDiffPlan(newDoc, oldDoc).entries.flatMap(e => e.decos)
}

// ============================================================
//  Plugin
// ============================================================

export const diffDecorationPlugin = new Plugin<DiffDecorationState>({
  key: diffDecorationKey,
  state: {
    init: (): DiffDecorationState => ({
      oldDoc: null,
      plan: null,
      built: null,
      decoSet: null,
    }),
    apply(tr, prev, _oldState, newState) {
      const meta = tr.getMeta(diffDecorationKey) as DiffDecorationMeta | undefined

      // 换 diff 基准:重算 plan
      if (meta && 'oldDoc' in meta) {
        if (!meta.oldDoc) {
          return { oldDoc: null, plan: null, built: null, decoSet: null }
        }
        const plan = buildDiffPlan(newState.doc, meta.oldDoc)
        const built = new Set<number>()
        const decos = collectVisibleDecos(plan, built, getViewport(newState))
        return {
          oldDoc: meta.oldDoc,
          plan,
          built,
          decoSet: DecorationSet.create(newState.doc, decos),
        }
      }

      if (tr.docChanged) {
        return { oldDoc: prev.oldDoc, plan: null, built: null, decoSet: null }
      }

      // 滚动导致视口变化:粘性增量 —— 只追加新进视口的 entry
      if (tr.getMeta(viewportKey) && prev.plan) {
        const built = prev.built ?? new Set<number>()
        const newDecos = collectVisibleDecos(prev.plan, built, getViewport(newState))
        // 有新 decoration 才 add,避免无谓的 DecorationSet 重建
        const decoSet = newDecos.length > 0 && prev.decoSet
          ? prev.decoSet.add(newState.doc, newDecos)
          : prev.decoSet
        return {
          ...prev,
          built,
          decoSet,
        }
      }

      return prev
    },
  },
  props: {
    decorations(state: EditorState) {
      return diffDecorationKey.getState(state)?.decoSet ?? null
    },
  },
})

// ============================================================
//  外部 API
// ============================================================

/**
 * 更新 diff 装饰的旧版本 doc。
 * 选中版本条目变化时调它就够 —— 不需要销毁重建 EditorView。
 */
export function setDiffOldDoc(view: EditorView, oldDoc: PMNode | null): void {
  view.dispatch(view.state.tr.setMeta(diffDecorationKey, { oldDoc }))
}
