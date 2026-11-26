// Diff 变更锚点 —— 源码 / 预览双模式共享的 hunk 定位原语(#diff-autoscroll / #diff-ruler)
//
// 源码模式从 displayRows 经 extractHunks 提取，预览模式从 DiffPlan.entries 合并连续变更块。
// 同一份锚点同时服务「首次自动跳转 + 上/下一处导航」与后续的 overview ruler，
// 避免两套定位数据漂移。

import { extractHunks, isPureCharRemoval, type DiffLine } from './lineDiff'

export type DiffAnchorKind = 'added' | 'removed' | 'modified'

export interface DiffAnchor {
  /** 锚点在列表中的 0-based 序号 */
  index: number
  /** 变更语义类型(供 overview ruler 着色) */
  kind: DiffAnchorKind
  /** 在文档中的归一化起始位置 [0, 1] */
  startRatio: number
  /** 在文档中的归一化结束位置 [0, 1] */
  endRatio: number
  /** 源码模式：displayRows 起始行下标 */
  rowIndex?: number
  /** 源码模式：displayRows 结束行下标(不含) */
  rowEndIndex?: number
  /** 预览模式：PM doc 起始 pos(delete widget 时 from === to) */
  from?: number
  /** 预览模式：PM doc 结束 pos */
  to?: number
}

/** 预览模式 DiffPlanEntry 的最小结构契约 */
export interface WysiwygPlanEntryLike {
  changed: boolean
  from: number
  to: number
  kind?: DiffAnchorKind
}

function classifySourceHunk(rows: ReadonlyArray<DiffLine>, start: number, end: number): DiffAnchorKind {
  let hasAdded = false
  let hasRemoved = false
  let hasModified = false

  for (let i = start; i < end; i++) {
    const line = rows[i]
    if (line.type === 'removed' || isPureCharRemoval(line)) {
      hasRemoved = true
    }
    else if (line.type === 'added') {
      if (line.mergedInlineDiff) hasModified = true
      else hasAdded = true
    }
  }

  if (hasModified || (hasAdded && hasRemoved)) return 'modified'
  if (hasAdded) return 'added'
  return 'removed'
}

/**
 * 从源码模式的 displayRows 提取变更锚点。
 * 复用 lineDiff.extractHunks 合并连续变更行。
 */
export function extractSourceAnchors(displayRows: DiffLine[]): DiffAnchor[] {
  const total = displayRows.length
  if (total === 0) return []

  const hunks = extractHunks(displayRows)
  return hunks.map((hunk, index) => ({
    index,
    kind: classifySourceHunk(displayRows, hunk.startIndex, hunk.endIndex),
    startRatio: hunk.startIndex / total,
    endRatio: hunk.endIndex / total,
    rowIndex: hunk.startIndex,
    rowEndIndex: hunk.endIndex,
  }))
}

function mergeAnchorKind(a: DiffAnchorKind, b: DiffAnchorKind): DiffAnchorKind {
  return a === b ? a : 'modified'
}

/**
 * 从预览模式的 DiffPlan.entries 提取变更锚点。
 * 连续的 changed entry 合并为一个导航 hunk(与源码模式 extractHunks 保持一致体验)。
 */
export function extractWysiwygAnchors(
  entries: ReadonlyArray<WysiwygPlanEntryLike>,
  docSize: number,
): DiffAnchor[] {
  const anchors: DiffAnchor[] = []
  const safeSize = Math.max(docSize, 1)

  let i = 0
  while (i < entries.length) {
    if (!entries[i].changed) {
      i++
      continue
    }

    let from = entries[i].from
    let to = entries[i].to
    let kind: DiffAnchorKind = entries[i].kind ?? 'modified'
    i++

    while (i < entries.length && entries[i].changed) {
      if (entries[i].from < from) from = entries[i].from
      if (entries[i].to > to) to = entries[i].to
      kind = mergeAnchorKind(kind, entries[i].kind ?? 'modified')
      i++
    }

    const startRatio = Math.min(1, Math.max(0, from / safeSize))
    const endRatio = Math.min(1, Math.max(startRatio, to / safeSize))

    anchors.push({
      index: anchors.length,
      kind,
      startRatio,
      endRatio,
      from,
      to,
    })
  }

  return anchors
}
