// WYSIWYG diff 装饰的共享原语(diffDecoration / tableDiff 共用)
//
// 抽出来的原因:表格结构化 diff(tableDiff.ts)需要与段落 diff 完全一致的
// 「块内 offset → doc pos 映射」和「字符级增删装饰」语义,但两者作用域不同
// (段落 = 整个顶层 block,单元格 = 单个 table_cell)。放进同一模块避免
// 两份实现漂移,也避免 tableDiff 反向依赖 diffDecoration 造成循环引用。

import { Decoration } from 'prosemirror-view'
import { diffChars, myersDiff } from '@/utils/lineDiff'

/** 一段文本及其在 doc 中的绝对位置,是字符级 diff 的最小作用域 */
export interface TextSegment {
  /** 文本节点起始的 doc 绝对 pos */
  pos: number
  text: string
}

/** 字符级 diff 的目标容器(顶层 block / 文本容器 group / 表格单元格) */
export interface TextTarget {
  /** 容器节点起始 pos(无文本段时的 fallback) */
  pos: number
  /** 容器内全部文本(按 segments 顺序拼接) */
  text: string
  segments: TextSegment[]
}

/**
 * 把容器内文本偏移量映射回 doc 绝对 pos。
 * 超出全部 segments(空容器 / 偏移落在末尾)时返回最后一段末尾。
 *
 * 注意:offset 的对应位置**必须**与 segments 同属一个容器。跨容器使用
 * (例如把整张表的文本偏移量拿去映射)正是「删除内容混进留存单元格」的根因。
 */
export function offsetInSegments(offset: number, target: TextTarget): number {
  if (target.segments.length === 0) return target.pos + 1
  let cum = 0
  for (const seg of target.segments) {
    if (offset < cum + seg.text.length) return seg.pos + (offset - cum)
    cum += seg.text.length
  }
  const last = target.segments[target.segments.length - 1]
  return last.pos + last.text.length
}

/** 红色删除 widget Decoration(字符级删除,原位显示,不占 doc pos) */
function removedWidget(pos: number, text: string, key?: string): Decoration {
  // ignoreSelection: 不让 PM 把 widget 内的 DOM 选区同步回 PM state
  // (widget 不占 doc pos,同步会得到无效选区并清除浏览器原生选区)
  return Decoration.widget(pos, () => {
    const span = document.createElement('span')
    span.className = 'velo-diff-removed'
    span.textContent = text
    return span
  }, { side: -1, ignoreSelection: true, key })
}

/**
 * 两个版本文本的字符级 diff → 增删 Decoration,作用域严格限定在 target 内。
 * 整 block 的字符级 diff、文本容器 group 的 diff、单元格内的 diff 都走这里。
 */
export function charDiffDecorations(oldText: string, target: TextTarget): Decoration[] {
  // block 可能跨 500 字符的表格 / 列表,上限放宽到 4000
  const segs = diffChars(oldText, target.text, 4000)
  const decos: Decoration[] = []
  let off = 0
  for (const seg of segs) {
    if (seg.type === 'added') {
      const from = offsetInSegments(off, target)
      const to = offsetInSegments(off + seg.text.length, target)
      if (from < to) decos.push(Decoration.inline(from, to, { class: 'velo-diff-added-inline' }))
      off += seg.text.length
    }
    else if (seg.type === 'removed') {
      // removed 片段不占新文本 offset,widget 原位插入(被删字符的原位置)
      decos.push(removedWidget(offsetInSegments(off, target), seg.text))
    }
    else {
      off += seg.text.length
    }
  }
  return decos
}

// ========== 序列对齐 ==========

export type AlignOp =
  | { kind: 'equal'; oldIndex: number; newIndex: number }
  | { kind: 'pair'; oldIndex: number; newIndex: number }
  | { kind: 'delete'; oldIndex: number; newIndex?: never }
  | { kind: 'insert'; oldIndex?: never; newIndex: number }

type AlignBlockItem =
  | { kind: 'delete'; oldIndex: number }
  | { kind: 'insert'; newIndex: number }

/**
 * 用 Myers 对齐两个 key 序列,把「连续非 equal 块」内的 delete/insert
 * 按**原始顺序**就近配对为 pair(「修改」语义)。
 *
 * 与 diffBlocks 的配对规则一致,但保留「幽灵项」语义:
 * 未配对的 delete 不丢弃(表格要靠它渲染幽灵列 / 幽灵行),统一追加到
 * 非 equal 块的末尾 —— Myers 的 ops 里 delete 总排在 insert 之前,若让
 * 多余 delete 留在原位,整块替换时幽灵项会被插到整张表 / 整个列表最前面。
 * 纯 delete 块(无 insert)全部是幽灵项,追加到块尾仍保持原有相对顺序。
 *
 * 配对一律「位置优先」(第 i 个 delete ↔ 第 i 个 insert)。按「就近」配对
 * 会让 N 个 delete 紧跟 N 个 insert 的整块替换得到逆序(old[0]↔new[N-1]),
 * 表格的行列会整体镜像 —— 删一列时每行显示的会是另一行的旧内容。
 */
export function alignSequence(oldKeys: string[], newKeys: string[]): AlignOp[] {
  const ops = myersDiff(oldKeys, newKeys)
  const result: AlignOp[] = []
  let oi = 0
  let ni = 0
  let k = 0

  while (k < ops.length) {
    if (ops[k] === 'equal') {
      result.push({ kind: 'equal', oldIndex: oi++, newIndex: ni++ })
      k++
      continue
    }

    // 收集连续的非 equal 块,保留 ops 原始顺序
    const block: AlignBlockItem[] = []
    while (k < ops.length && ops[k] !== 'equal') {
      if (ops[k] === 'delete') block.push({ kind: 'delete', oldIndex: oi++ })
      else block.push({ kind: 'insert', newIndex: ni++ })
      k++
    }

    // 按顺序配对:第 i 个 delete ↔ 第 i 个 insert(位置优先)
    const deleteSlots: number[] = []
    const insertSlots: number[] = []
    for (let i = 0; i < block.length; i++) {
      if (block[i].kind === 'delete') deleteSlots.push(i)
      else insertSlots.push(i)
    }
    const pairCount = Math.min(deleteSlots.length, insertSlots.length)
    const pairedOld = new Map<number, number>()
    const usedDelete = new Set<number>()
    for (let i = 0; i < pairCount; i++) {
      const d = deleteSlots[i]
      const item = block[d]
      if (item.kind !== 'delete') continue // 按构造不会发生,仅作类型收窄
      pairedOld.set(insertSlots[i], item.oldIndex)
      usedDelete.add(d)
    }

    // 按块内顺序输出 pair / insert。已配对的 delete 只作为 pair 的旧值来源,
    // 不单独占位;未配对的 delete(幽灵列 / 幽灵行)统一追加到块尾。
    const trailingDeletes: AlignOp[] = []
    for (let i = 0; i < block.length; i++) {
      const item = block[i]
      if (item.kind === 'delete') {
        if (!usedDelete.has(i)) trailingDeletes.push({ kind: 'delete', oldIndex: item.oldIndex })
      }
      else {
        const oldIndex = pairedOld.get(i)
        if (oldIndex !== undefined) {
          result.push({ kind: 'pair', oldIndex, newIndex: item.newIndex })
        }
        else {
          result.push({ kind: 'insert', newIndex: item.newIndex })
        }
      }
    }
    result.push(...trailingDeletes)
  }

  return result
}
