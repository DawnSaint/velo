// B2 增量 DecorationSet 工具:
// PM 的 `decorations(state)` 每次交易都跑,无法拿到 `tr` 做增量。
// 标准做法是把 DecorationSet 存进 plugin state,在 `apply(tr, prev)` 里做增量更新:
//   1. tr.docChanged → map 旧 set(tr.mapping 平移 pos) → 只对 dirty range 重建
//   2. 非 docChanged → 返回 prev(同引用) → decorations() 返回同 set → PM 跳过
//
// dirty range 提取:遍历 tr.steps,每步的 from/to 给出变化区间。
// 对于"打一个字"这种单步 transaction,dirty range 只有 1 个,只需重建 1 个 code_block
// 的 decoration,而非全文档 N 个。

import type { Transaction } from 'prosemirror-state'
import { DecorationSet, type Decoration } from 'prosemirror-view'

export interface DirtyRange {
  from: number
  to: number
}

/**
 * 从 tr.steps 提取 dirty ranges(文档坐标,已映射到新 doc)。
 * 对于 ReplaceStep / ReplaceAroundStep,取 step.from ~ step.to 映射后的范围。
 */
export function extractDirtyRanges(tr: Transaction): DirtyRange[] {
  const ranges: DirtyRange[] = []
  for (const step of tr.steps) {
    // step.getMap() 给出 [oldFrom, oldTo, newFrom, newTo]
    const map = step.getMap()
    ranges.push({ from: map.slice(2, 3)[0], to: map.slice(3, 4)[0] })
  }
  return ranges
}

/**
 * 对一组 dirty ranges,收集受影响的节点(只处理 code_block / frontmatter / heading 等)。
 * 返回 { pos, node } 列表——只含与 dirty ranges 有交集的节点。
 */
export function findAffectedNodes(
  doc: import('prosemirror-model').Node,
  ranges: DirtyRange[],
  nodeType: string,
): Array<{ pos: number; node: import('prosemirror-model').Node }> {
  const result: Array<{ pos: number; node: import('prosemirror-model').Node }> = []
  for (const range of ranges) {
    // 展开范围:可能 dirty range 在一个 code_block 内部,
    // nodesBetween 会遍历到包含该范围的节点
    doc.nodesBetween(range.from, range.to, (node, pos) => {
      if (node.type.name === nodeType) {
        result.push({ pos, node })
      }
    })
    // 还要检查:dirty range 可能刚好在一个 code_block 之前(插入新行),
    // nodesBetween 不会报告它。扩展搜索范围向前向后各 1。
    if (range.from > 0) {
      doc.nodesBetween(range.from - 1, range.from, (node, pos) => {
        if (node.type.name === nodeType) {
          // 避免重复
          if (!result.some(r => r.pos === pos)) {
            result.push({ pos, node })
          }
        }
      })
    }
  }
  return result
}

/**
 * 从 DecorationSet 中移除指定 pos 范围内的 decoration。
 * 用于清理 dirty range 内的旧 decoration,再添加重建的。
 */
export function removeDecosInRange(
  set: DecorationSet,
  from: number,
  to: number,
): DecorationSet {
  // find: 找到 [from, to] 范围内的 decoration
  // remove: 移除它们
  return set.remove(set.find(from, to))
}

/**
 * 判断是否需要全量重建(plugin state 变化、首次加载等)。
 * 如果 plugin state 引用变了(如 highlighter 切换),必须全量重建。
 */
export function needsFullRebuild<T>(prev: T, next: T): boolean {
  return prev !== next
}
