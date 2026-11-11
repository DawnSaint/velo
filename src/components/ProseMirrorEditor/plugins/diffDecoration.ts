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
// - 表格 → 二维网格结构化 diff(tableDiff.ts):整列 / 整行删除渲染为独立的
//   红色幽灵列 / 幽灵行,单元格内改动只在单元格内做字符级 diff
// - 多文本容器(列表 / 引用 / 脚注 …)→ 按容器分组对齐(group),
//   删除内容独立成块,不再映射进留存的相邻段落
//
// 注:未变更区折叠 + hunk 导航 + 首次进入自动跳转(#diff-autoscroll)已回退,
// 当前为未完成状态 —— 全文渲染,不做折叠。
//
// 比对层为 Block Tree Diff(blockDiff.ts):顶层 block 序列上跑 Myers,
// key 含类型 / attrs / 文本 / marks / 非文本 leaf,格式与结构变更不再不可见。
// 字符级 diff 一律以「单个文本容器」为最小作用域(diffCommon.ts),跨容器
// 拼接文本做 diff 会把删除内容映射进留存容器(表格删列混排 BUG 的根因)。
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
import {
  diffBlocks,
  diffInlineMarkRanges,
  nodeTypeLabel,
  type BlockDiffOp,
  type BlockEntry,
} from './blockDiff'
import {
  alignSequence,
  charDiffDecorations,
  offsetInSegments,
} from './diffCommon'
import { buildTablePairDecorations } from './tableDiff'
import { getViewport, isInViewport, viewportKey } from '../nodes/viewportPlugin'
import { attachImageErrorFallback } from '../editor/imageErrorPlaceholder'

export const diffDecorationKey = new PluginKey<DiffDecorationState>('veloDiffDecoration')

// ========== Diff Plan ==========

/** 一处变更 / 一段未变更 = 一个 entry。增量构建按 entry 粒度分批 */
interface DiffPlanEntry {
  /** true = 变更 op(insert/delete/pair/split/merge);false = 未变更 block */
  changed: boolean
  /** 覆盖的 doc 范围(视口过滤用);delete 的 widget entry from === to */
  from: number
  to: number
  /** 该区域的装饰;未变更区为空 */
  decos: Decoration[]
  /** 所属整框组(仅连续 insert / delete 有) */
  groupId?: string
}

/**
 * 连续同类变更块组成的「整框组」。
 *
 * 组边界来自 diff 计划而不是 DOM 兄弟关系 —— 后者会被 Decoration.widget
 * (代码 header / mermaid SVG / 目录 / 删除片段)打断,且视口增量构建时
 * 视口外的块暂时没有 decoration,用 CSS `:has(+ …)` 猜组首会随滚动漂移。
 * 渲染层(diffGroupFrames.ts)据此为每组画**一个**绝对定位的框。
 */
export interface DiffGroup {
  id: string
  kind: 'added' | 'deleted'
  /** 组覆盖的 doc 范围(用于把顶层 DOM 节点归组) */
  from: number
  to: number
  /** 组内最后一个块的起始 pos(兜底定位用) */
  lastFrom: number
  /** 组内 entry 下标 */
  entries: number[]
}

export interface DiffPlan {
  entries: DiffPlanEntry[]
  /** 只含连续 insert / delete;pair / split / merge 不组成整框 */
  groups: DiffGroup[]
}

interface DiffDecorationState {
  /** 旧版本 PM Node(用于 diff 计算)。null = 无 diff,不渲染装饰 */
  oldDoc: PMNode | null
  plan: DiffPlan | null
  /** 已建进 decoSet 的 entry 下标(粘性:doc 只读,已建结果永久有效) */
  built: Set<number> | null
  decoSet: DecorationSet | null
}

/** 把 widget 片段里的图片 src 转成 WebView 可加载的 URL(由只读视图注入) */
export type ImageSrcResolver = (url: string) => string

type DiffDecorationMeta = {
  oldDoc: PMNode | null
  resolveImageSrc?: ImageSrcResolver
}

// ============================================================
//  装饰构造
// ============================================================

/**
 * widget 里的 DOM 由 DOMSerializer 生成,**不经过 image NodeView** ——
 * schema 的 image.toDOM 只输出 markdown 里的原始 src(通常是 `assets/x.png`
 * 这类相对路径),WebView 加载不到。序列化后统一改写 <img src>,并给每个
 * <img> 挂同一份加载失败兜底(占位符由 editor/imageErrorPlaceholder.ts 生成)。
 */
function serializeDeletedNode(
  node: PMNode,
  resolveSrc?: ImageSrcResolver,
): HTMLElement | Text {
  const dom = DOMSerializer.fromSchema(node.type.schema).serializeNode(node)
  // serializeNode 也可能返回 Text 节点,它没有 querySelectorAll
  if (!('querySelectorAll' in dom)) return dom

  const prepare = (el: Element): void => {
    if (el.tagName !== 'IMG') return
    const img = el as HTMLImageElement
    const raw = img.getAttribute('src')
    if (!raw) return
    // 挂在改写 src 之前:改写会重新发起加载。即使没有 resolver(纯逻辑 /
    // 测试路径),失败兜底也要挂 —— 否则删除片段里仍是浏览器破图。
    attachImageErrorFallback(img, raw)
    if (resolveSrc) {
      const next = resolveSrc(raw)
      if (next !== raw) img.setAttribute('src', next)
    }
  }
  // serializeNode 对 inline 节点可能直接返回 <img>,querySelectorAll 不含自身
  prepare(dom)
  for (const img of Array.from(dom.querySelectorAll('img[src]'))) prepare(img)
  return dom
}

/** 保证删除片段 widget 的根节点不是 <img>。
 *
 * DOMSerializer 对 inline image 直接返回 <img>;若它作为 Decoration.widget 的
 * 根节点,加载失败兜底的 replaceWith 会把 PM viewdesc 持有的根节点换掉。包一层
 * 稳定容器后根节点不变,替换的只是容器内的子节点。
 * 非 <img> 一律原样返回 —— `velo-diff-deleted-group` 有时必须落在 <li> / <h2>
 * 自身(见 _editor-diff.scss 的 `> li.velo-diff-deleted-group` / `:is(headings)`)。
 * 导出供单测直接覆盖这条防御分支:buildDiffPlan 很难稳定构造出 IMG 根节点。 */
export function ensureStableDeletedWidgetRoot(dom: HTMLElement): HTMLElement {
  if (dom.tagName !== 'IMG') return dom
  const frame = document.createElement('span')
  frame.className = 'velo-diff-deleted-image-frame'
  frame.appendChild(dom)
  return frame
}

/**
 * 整 block 删除的 widget:序列化旧 block 为带样式的只读片段
 * (标题保留字号、列表保留缩进、图片 / 分割线保留原形),
 * 而非裸文本摘要。结构 + marks 都由 schema 的 toDOM 自然保留。
 */
function deletedBlockWidget(
  pos: number,
  node: PMNode,
  groupId?: string,
  resolveSrc?: ImageSrcResolver,
): Decoration {
  // ignoreSelection: 同字符级删除 widget,保留浏览器原生选区
  return Decoration.widget(pos, () => {
    const wrapper = document.createElement('div')
    wrapper.className = 'velo-diff-deleted-block'
    if (groupId) wrapper.setAttribute('data-diff-group-id', groupId)
    wrapper.appendChild(serializeDeletedNode(node, resolveSrc))
    return wrapper
  }, { side: -1, ignoreSelection: true })
}

/**
 * 多文本容器 block 内「删掉一个容器」的红色片段。
 * 序列化的是整个块级单元(列表项 → `<li>`,引用内段落 → `<p>`),DOM 类型
 * 与新文档中同位置的节点一致,插在下一个留存容器之前,不会混进它的文本。
 */
function deletedGroupWidget(
  pos: number,
  blockPos: number,
  index: number,
  node: PMNode,
  resolveSrc?: ImageSrcResolver,
): Decoration {
  return Decoration.widget(pos, () => {
    const dom = serializeDeletedNode(node, resolveSrc) as HTMLElement
    dom.classList.add('velo-diff-deleted-group')
    return ensureStableDeletedWidgetRoot(dom)
  }, {
    side: -1,
    ignoreSelection: true,
    // key 带 block pos:多个 block 同时删容器时全局唯一,PM 不会复用错 DOM
    key: `velo-diff-deleted-group-${blockPos}-${index}`,
  })
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
/**
 * 预扫描 ops,给「连续的 insert」/「连续的 delete」分配整框组 id。
 * 分组只看 diff 计划里的相邻关系 —— 与 DOM 里是否夹着 widget、该块是否
 * 已被视口增量构建过都无关,所以组边界不会随滚动变化。
 */
function planGroupIds(ops: ReturnType<typeof diffBlocks>['ops']): (string | null)[] {
  const ids: (string | null)[] = new Array(ops.length).fill(null)
  let seq = 0
  for (let i = 0; i < ops.length;) {
    const kind = ops[i].kind
    if (kind !== 'insert' && kind !== 'delete') { i++; continue }
    let j = i
    while (j + 1 < ops.length && ops[j + 1].kind === kind) j++
    const id = `dg${seq++}`
    for (let k = i; k <= j; k++) ids[k] = id
    i = j + 1
  }
  return ids
}

/**
 * pair 是否等价于「整块新增」。
 *
 * 多文本容器(列表 / 引用 …)整体换成另一批容器时,buildGroupedPairDecorations
 * 会给每个新容器单独加 velo-diff-added —— 这些 decoration 不带 groupId,只能
 * 落到单块描边降级规则,一串连续新增行就被画成 N 个独立小绿框。按顶层 insert
 * 渲染才同时符合语义(整块都是新的)与整框分组。
 *
 * 只在「容器对齐结果全是 insert」时提升:出现 delete(红色幽灵项)/ pair / equal
 * 说明还有删除片段、字符级修改或留存内容,提升会把它们吞掉。
 */
function isWholeBlockInsert(oldBlock: BlockEntry, newBlock: BlockEntry): boolean {
  // 表格走二维网格 diff,单容器 block 走字符级 diff,都不该提升
  if (oldBlock.node.type.name === 'table' || newBlock.node.type.name === 'table') return false
  if (oldBlock.groups.length <= 1 && newBlock.groups.length <= 1) return false
  if (oldBlock.text === newBlock.text) return false
  const ops = alignSequence(oldBlock.groups.map(g => g.text), newBlock.groups.map(g => g.text))
  return ops.length > 0 && ops.every(op => op.kind === 'insert')
}

function joinGroup(
  groups: Map<string, DiffGroup>,
  id: string,
  kind: DiffGroup['kind'],
  from: number,
  to: number,
  lastFrom: number,
  entryIndex: number,
): void {
  const g = groups.get(id)
  if (!g) {
    groups.set(id, { id, kind, from, to, lastFrom, entries: [entryIndex] })
    return
  }
  g.from = Math.min(g.from, from)
  g.to = Math.max(g.to, to)
  g.lastFrom = Math.max(g.lastFrom, lastFrom)
  g.entries.push(entryIndex)
}

export function buildDiffPlan(
  newDoc: PMNode,
  oldDoc: PMNode,
  resolveSrc?: ImageSrcResolver,
): DiffPlan {
  const { ops, oldBlocks, newBlocks } = diffBlocks(oldDoc, newDoc)
  // 整组容器全新增的 pair 按顶层 insert 渲染,才能与相邻新增块一起进整框组
  const renderOps: BlockDiffOp[] = ops.map(op =>
    op.kind === 'pair' && isWholeBlockInsert(oldBlocks[op.oldIndex], newBlocks[op.newIndex])
      ? { kind: 'insert' as const, newIndex: op.newIndex }
      : op,
  )
  const groupIds = planGroupIds(renderOps)
  const entries: DiffPlanEntry[] = []
  const groups = new Map<string, DiffGroup>()

  for (let i = 0; i < renderOps.length; i++) {
    const op = renderOps[i]
    const groupId = groupIds[i] ?? undefined

    if (op.kind === 'insert') {
      const b = newBlocks[op.newIndex]
      const from = b.pos
      const to = b.pos + b.size
      const attrs: Record<string, string> = { class: 'velo-diff-added' }
      if (groupId) attrs['data-diff-group-id'] = groupId
      const entry: DiffPlanEntry = {
        changed: true,
        from,
        to,
        decos: [Decoration.node(from, to, attrs)],
      }
      if (groupId) {
        entry.groupId = groupId
        joinGroup(groups, groupId, 'added', from, to, b.pos, entries.length)
      }
      entries.push(entry)
    }
    else if (op.kind === 'delete') {
      const pos = widgetInsertPos(renderOps, i, newBlocks, newDoc)
      const entry: DiffPlanEntry = {
        changed: true,
        from: pos,
        to: pos,
        decos: [deletedBlockWidget(pos, oldBlocks[op.oldIndex].node, groupId, resolveSrc)],
      }
      if (groupId) {
        entry.groupId = groupId
        joinGroup(groups, groupId, 'deleted', pos, pos, pos, entries.length)
      }
      entries.push(entry)
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
        decos: buildPairDecorations(oldBlocks[op.oldIndex], b, resolveSrc),
      })
    }
    else {
      const b = newBlocks[op.newIndex]
      entries.push({ changed: false, from: b.pos, to: b.pos + b.size, decos: [] })
    }
  }

  return { entries, groups: [...groups.values()] }
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

/** pair op(「修改」)的装饰:结构感知 diff / 字符级 diff / 同文异 key 语义标记 */
function buildPairDecorations(
  oldBlock: BlockEntry,
  newBlock: BlockEntry,
  resolveSrc?: ImageSrcResolver,
): Decoration[] {
  // 表格:二维网格结构化 diff。返回 null 表示结构未变(仅 marks / 非文本 leaf 变更),
  // 落到下面的「同文异 key」逻辑,避免吞掉格式变更标记。
  if (oldBlock.node.type.name === 'table' && newBlock.node.type.name === 'table') {
    const tableDecos = buildTablePairDecorations(oldBlock, newBlock)
    if (tableDecos !== null) return tableDecos
  }

  if (oldBlock.text === newBlock.text) {
    return buildSameTextDecorations(oldBlock, newBlock)
  }

  // 多文本容器(列表 / 引用 / 脚注 …):按容器分组对齐,字符级 diff 只在单个
  // 容器内做,删除的容器独立成块 —— 否则删除内容会被 offset 映射进相邻留存
  // 容器(与表格删列同源的混排 BUG)。
  if (oldBlock.groups.length > 1 || newBlock.groups.length > 1) {
    return buildGroupedPairDecorations(oldBlock, newBlock, resolveSrc)
  }

  return charDiffDecorations(oldBlock.text, newBlock)
}

/** 文本相同但 key 不同:节点类型 / 格式 / 非文本 leaf 变更 */
function buildSameTextDecorations(oldBlock: BlockEntry, newBlock: BlockEntry): Decoration[] {
  const decos: Decoration[] = []
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
    const from = offsetInSegments(r.from, newBlock)
    const to = offsetInSegments(r.to, newBlock)
    if (from < to) {
      decos.push(
        Decoration.inline(from, to, { class: 'velo-diff-format-changed', title: '格式变更' }),
      )
    }
  }
  return decos
}

/**
 * 多文本容器 block(列表 / 引用 / 脚注 …):按容器序列跑 Myers,
 * 逐容器做字符级 diff;删除的容器序列化成独立的红色块级单元
 * (列表项 → `<li>`,引用内段落 → `<p>`),插在下一个留存容器之前。
 */
function buildGroupedPairDecorations(
  oldBlock: BlockEntry,
  newBlock: BlockEntry,
  resolveSrc?: ImageSrcResolver,
): Decoration[] {
  const ops = alignSequence(
    oldBlock.groups.map(g => g.text),
    newBlock.groups.map(g => g.text),
  )
  const decos: Decoration[] = []
  const blockEnd = newBlock.pos + 1 + newBlock.node.content.size
  let outGroup = 0

  for (const op of ops) {
    if (op.kind === 'delete') {
      const oldGroup = oldBlock.groups[op.oldIndex]
      const atPos = newBlock.groups[outGroup]?.blockPos ?? blockEnd
      decos.push(deletedGroupWidget(atPos, newBlock.pos, op.oldIndex, oldGroup.blockNode, resolveSrc))
      continue
    }

    const group = newBlock.groups[op.newIndex]
    if (!group) { outGroup++; continue }
    if (op.kind === 'insert') {
      decos.push(
        Decoration.node(group.blockPos, group.blockPos + group.blockSize, {
          class: 'velo-diff-added',
        }),
      )
    }
    else if (op.kind === 'pair') {
      decos.push(...charDiffDecorations(oldBlock.groups[op.oldIndex].text, group))
    }
    outGroup++
  }

  return decos
}

// ============================================================
//  按视口分批构建 DecorationSet(#diff-incremental)
// ============================================================

/**
 * entry 是否落在视口内。
 *
 * 与 `isInViewport` 的唯一差别:delete 的 widget entry 是**零长区间**
 * (`from === to`,widget 不占 doc pos)。`isInViewport` 的判定是
 * `pos + nodeSize > viewport.from && pos < viewport.to`,nodeSize=0 时退化为
 * `pos > viewport.from` —— 而 viewport.from 最小就是 0,于是
 * 「删除文档首块」(widget 落在 pos 0)的 entry 永远判定为不可见,
 * 且滚动也救不回来(from 恒 >= 0),删除提示彻底不渲染。
 * 零长 entry 改用「点是否落在闭区间」判定。
 */
function entryInViewport(
  entry: DiffPlanEntry,
  viewport: ReturnType<typeof getViewport>,
): boolean {
  if (!viewport) return true
  if (entry.from === entry.to) {
    return entry.from >= viewport.from && entry.from <= viewport.to
  }
  return isInViewport(entry.from, entry.to - entry.from, viewport)
}

/**
 * 找出视口内尚未构建的 entry，返回它们的装饰 + 更新 built 集合。
 * - viewport 为 null(无滚动容器 / 未就绪)→ 全量,退化为旧行为
 * - built 就地累积:只读 doc,已建过的 entry 不必重复构造(widget DOM 开销),
 *   后续滚动只追加新进视口的 entry
 *
 * 关键:只返回 **尚未构建** 的 entry 的装饰 —— 调用方会把返回值追加到
 * 已有 DecorationSet(add),若把已建 entry 的装饰也返回会导致重复添加。
 */
function collectVisibleDecos(
  plan: DiffPlan,
  built: Set<number>,
  viewport: ReturnType<typeof getViewport>,
): Decoration[] {
  const decos: Decoration[] = []

  plan.entries.forEach((entry, i) => {
    // 已建 → 跳过;未建但不在视口 → 跳过
    if (built.has(i)) return
    if (!entryInViewport(entry, viewport)) return
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
        const plan = buildDiffPlan(newState.doc, meta.oldDoc, meta.resolveImageSrc)
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
export function setDiffOldDoc(
  view: EditorView,
  oldDoc: PMNode | null,
  resolveImageSrc?: ImageSrcResolver,
): void {
  view.dispatch(view.state.tr.setMeta(diffDecorationKey, { oldDoc, resolveImageSrc }))
}

/**
 * 读取当前 diff 的整框分组(供只读视图的 overlay 层使用)。
 * 组是全量 plan 的一部分,不受视口增量构建影响。
 */
export function getDiffGroups(state: EditorState): DiffGroup[] {
  return diffDecorationKey.getState(state)?.plan?.groups ?? []
}
