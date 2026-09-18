// 行级 diff 工具 —— 基于 Myers 算法 + 字符级 inline diff。
//
// 用于版本历史对比视图:把旧版本(快照)与新版本(当前内容)按行对齐,
// 标记新增 / 删除 / 不变行。不依赖第三方库,纯函数实现。
//
// 算法演进:
// - v0.7.10:朴素 LCS(O(m*n) DP 表),大文档内存占用高
// - v0.7.14:Myers diff 算法(线性空间 + 更优 hunk 边界) + 字符级 inline diff

// ========== 类型定义 ==========

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged'
  text: string
  /** 行号(added/unchanged 用新版本行号;removed 用旧版本行号) */
  oldLineNumber: number
  newLineNumber: number
  /**
   * 字符级 inline diff 片段(仅当行为 added/removed 且与对应行有部分相似时填充)。
   * unchanged 行始终为 null。
   * - removed 行的 inlineDiff 只含 'removed' + 'unchanged' 片段
   * - added 行的 inlineDiff 只含 'added' + 'unchanged' 片段
   * 消费方按需使用:有则渲染字符级高亮,无则整行着色。
   */
  inlineDiff?: InlineDiffSegment[] | null
  /**
   * 「修改」配对标记:该 removed 行与紧随其后的 added 行是同一修改对。
   * 需要单行合并渲染的视图(如源码 diff,VSCode inline diff 风格)可跳过本行,
   * 改由 added 行的 mergedInlineDiff 渲染。仅存在于配对修改中的 removed 行。
   */
  mergedIntoNext?: boolean
  /**
   * 完整的字符级 diff 片段(unchanged/removed/added 按顺序混合),
   * 仅存在于「修改」配对中的 added 行。供单行合并渲染使用:
   * unchanged = 正常文本,added = 深绿底,removed = 深红底(同 VSCode inline diff)。
   */
  mergedInlineDiff?: InlineDiffSegment[] | null
}

/** 字符级 diff 片段 */
export interface InlineDiffSegment {
  type: 'added' | 'removed' | 'unchanged'
  text: string
}

/**
 * 判断 DiffLine 是否为「纯字符删除」的配对修改行
 * (mergedInlineDiff 中只有 removed 片段、没有 added 片段,如 `\$\$` → `$$`)。
 * 单行合并渲染的视图(源码 diff)据此把整行按删除语义渲染为浅红,而非浅绿。
 */
export function isPureCharRemoval(line: DiffLine): boolean {
  return (
    line.type === 'added'
    && !!line.mergedInlineDiff
    && !line.mergedInlineDiff.some(s => s.type === 'added')
  )
}

// ========== Myers diff 算法 ==========
//
// 基于 Eugene W. Myers 1986 年论文 "An O(ND) Difference Algorithm and Its Variations"。
// 核心思想:在 edit graph 上找最短路径,D = edit distance。
// 时间复杂度 O((m+n)D),空间复杂度 O(m+n)——远优于朴素 LCS 的 O(m*n)。
//
// edit graph:横轴 x ∈ [0, m](旧版本 a),纵轴 y ∈ [0, n](新版本 b)。
// - 对角线移动(equal):a[x] === b[y],不消耗 D
// - 向右(delete):x+1,消耗 1 D
// - 向下(insert):y+1,消耗 1 D
// k = x - y(对角线编号);向右 k+1,向下 k-1。
// V[k] = 对角线 k 上前向搜索能到达的最远 x 坐标。

type EditOp = 'equal' | 'delete' | 'insert'

/**
 * 用 Myers 算法计算两个字符串数组的编辑序列。
 * 返回 EditOp[],长度 = m + n - 2*LCS_length。
 * 除行级 diff 外,也供 Block Tree Diff(block key 序列比对)复用。
 */
export function myersDiff(a: string[], b: string[]): EditOp[] {
  const m = a.length
  const n = b.length

  if (m === 0) return b.map(() => 'insert' as EditOp)
  if (n === 0) return a.map(() => 'delete' as EditOp)

  const maxD = m + n
  const offset = maxD
  const size = 2 * maxD + 1
  const vSnapshots: Int32Array[] = []

  // D=0: 从 (0,0) 沿 k=0 对角线前进
  const v0 = new Int32Array(size)
  let x0 = 0
  let y0 = 0
  while (x0 < m && y0 < n && a[x0] === b[y0]) {
    x0++
    y0++
  }
  v0[offset] = x0 // V[0] = 沿 k=0 到达的最远 x
  vSnapshots.push(v0)

  // D=0 就到终点了(两段完全相同)
  if (x0 >= m && y0 >= n) {
    const ops: EditOp[] = []
    for (let i = 0; i < x0; i++) ops.push('equal')
    return ops
  }

  let v = v0
  let finalD = -1

  for (let d = 1; d <= maxD; d++) {
    const nextV = new Int32Array(size)
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        // 从 k+1 过来 = 向下走(insert):x 不变
        x = v[k + 1 + offset]
      }
      else {
        // 从 k-1 过来 = 向右走(delete):x+1
        x = v[k - 1 + offset] + 1
      }
      let y = x - k
      // 沿对角线前进(相等的行)
      while (x < m && y < n && a[x] === b[y]) {
        x++
        y++
      }
      nextV[k + offset] = x
      if (x >= m && y >= n) {
        vSnapshots.push(nextV)
        finalD = d
        break
      }
    }
    if (finalD !== -1) break
    vSnapshots.push(nextV)
    v = nextV
  }

  // 回溯:从终点 (m,n) 逐 D 步回到 (0,0)
  // 关键:每个 D 步先沿对角线回溯 equal,再回溯 delete/insert
  const ops: EditOp[] = []
  let x = m
  let y = n

  for (let d = finalD; d > 0; d--) {
    const prevV = vSnapshots[d - 1]
    const k = x - y

    let prevK: number
    let op: EditOp

    if (k === -d || (k !== d && prevV[k - 1 + offset] < prevV[k + 1 + offset])) {
      prevK = k + 1
      op = 'insert'
    }
    else {
      prevK = k - 1
      op = 'delete'
    }

    // D-1 步时对角线 prevK 上的最远点
    const targetX = prevV[prevK + offset]
    const targetY = targetX - prevK

    // 1. 先沿对角线回溯 equal(从当前点到 D 步操作之后的点)
    //    delete 之后的点 = (targetX+1, targetY)
    //    insert 之后的点 = (targetX, targetY+1)
    if (op === 'delete') {
      while (x > targetX + 1 && y > targetY && x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
        ops.push('equal')
        x--
        y--
      }
      // 2. 回溯 delete
      ops.push('delete')
      x--
    }
    else {
      while (x > targetX && y > targetY + 1 && x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
        ops.push('equal')
        x--
        y--
      }
      // 2. 回溯 insert
      ops.push('insert')
      y--
    }
  }

  // D=0 剩余的对角线(equal)
  while (x > 0 && y > 0) {
    ops.push('equal')
    x--
    y--
  }

  ops.reverse()
  return ops
}

// ========== 字符级 inline diff ==========

/**
 * 计算两个文本的字符级 diff。
 * 用于行级 diff 中「修改」场景的细化:把一行删旧+加新细化为字符级增删。
 * maxLength:超过该长度降级为整段标记(防极端性能问题)。
 * 行级调用走默认 500;Block Tree Diff 对整 block(如表格)可调高。
 */
export function diffChars(oldText: string, newText: string, maxLength = 500): InlineDiffSegment[] {
  if (oldText === newText) {
    return [{ type: 'unchanged', text: oldText }]
  }
  if (!oldText) return [{ type: 'added', text: newText }]
  if (!newText) return [{ type: 'removed', text: oldText }]

  // 超长文本降级为整段标记,避免极端情况下的性能问题
  if (oldText.length > maxLength || newText.length > maxLength) {
    return [
      { type: 'removed', text: oldText },
      { type: 'added', text: newText },
    ]
  }

  const oldChars = Array.from(oldText)
  const newChars = Array.from(newText)
  const ops = myersDiff(oldChars, newChars)

  // EditOp[] → InlineDiffSegment[],合并相邻同类型
  const result: InlineDiffSegment[] = []
  let oi = 0 // oldChars 指针
  let ni = 0 // newChars 指针

  for (const op of ops) {
    if (op === 'equal') {
      const ch = oldChars[oi]
      const last = result[result.length - 1]
      if (last && last.type === 'unchanged') {
        last.text += ch
      }
      else {
        result.push({ type: 'unchanged', text: ch })
      }
      oi++
      ni++
    }
    else if (op === 'delete') {
      const ch = oldChars[oi]
      const last = result[result.length - 1]
      if (last && last.type === 'removed') {
        last.text += ch
      }
      else {
        result.push({ type: 'removed', text: ch })
      }
      oi++
    }
    else {
      const ch = newChars[ni]
      const last = result[result.length - 1]
      if (last && last.type === 'added') {
        last.text += ch
      }
      else {
        result.push({ type: 'added', text: ch })
      }
      ni++
    }
  }

  return result
}

// ========== Hunk 级语义 ==========

/**
 * Hunk:连续的 added/removed 行块,用于导航和统计。
 */
export interface DiffHunk {
  /** hunk 在 DiffLine[] 中的起始索引 */
  startIndex: number
  /** hunk 在 DiffLine[] 中的结束索引(不含) */
  endIndex: number
  /** hunk 内 added 行数 */
  addedCount: number
  /** hunk 内 removed 行数 */
  removedCount: number
}

/**
 * 从 DiffLine[] 提取 hunk 列表。
 * 连续的 added/removed 行(中间不含 unchanged 行)合并为一个 hunk。
 */
export function extractHunks(lines: DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].type === 'unchanged') {
      i++
      continue
    }
    const start = i
    let added = 0
    let removed = 0
    while (i < lines.length && lines[i].type !== 'unchanged') {
      if (lines[i].type === 'added') added++
      else removed++
      i++
    }
    hunks.push({
      startIndex: start,
      endIndex: i,
      addedCount: added,
      removedCount: removed,
    })
  }
  return hunks
}

// ========== 主函数 ==========

/**
 * 计算两段文本的行级 diff。
 * oldText = 快照内容(旧),newText = 当前内容(新)。
 * 返回 DiffLine 数组,保持文档顺序:不变行和删除行来自旧版本,
 * 不变行和新增行来自新版本。
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText ? oldText.split('\n') : []
  const newLines = newText ? newText.split('\n') : []

  const ops = myersDiff(oldLines, newLines)

  // EditOp[] → DiffLine[]
  const result: DiffLine[] = []
  let oldLineNum = 1
  let newLineNum = 1
  let opIdx = 0

  while (opIdx < ops.length) {
    const op = ops[opIdx]
    if (op === 'equal') {
      while (opIdx < ops.length && ops[opIdx] === 'equal') {
        result.push({
          type: 'unchanged',
          text: oldLines[oldLineNum - 1],
          oldLineNumber: oldLineNum,
          newLineNumber: newLineNum,
        })
        oldLineNum++
        newLineNum++
        opIdx++
      }
    }
    else if (op === 'delete') {
      // 收集连续 delete + 后续可能配对的 insert(=「修改」)
      const deletedTexts: string[] = []
      const deletedOldNums: number[] = []
      while (opIdx < ops.length && ops[opIdx] === 'delete') {
        deletedTexts.push(oldLines[oldLineNum - 1])
        deletedOldNums.push(oldLineNum)
        oldLineNum++
        opIdx++
      }
      const insertedTexts: string[] = []
      const insertedNewNums: number[] = []
      while (opIdx < ops.length && ops[opIdx] === 'insert') {
        insertedTexts.push(newLines[newLineNum - 1])
        insertedNewNums.push(newLineNum)
        newLineNum++
        opIdx++
      }

      // 有配对的 insert → 修改场景:逐行做字符级 inline diff
      if (insertedTexts.length > 0) {
        const pairCount = Math.min(deletedTexts.length, insertedTexts.length)
        const refNewNum = insertedNewNums[0]
        const refOldNum = deletedOldNums[0]

        // 预计算所有配对的字符级 diff,避免重复计算
        const inlineDiffs: InlineDiffSegment[][] = []
        for (let idx = 0; idx < pairCount; idx++) {
          inlineDiffs.push(diffChars(deletedTexts[idx], insertedTexts[idx]))
        }

        // 交替输出配对的 removed + added 行(同 VSCode inline diff 语义:
        // 先 removed 第 1 行,再 added 第 1 行,然后 removed 第 2 行...
        // 用户可逐行对比而非"整块删除 + 整块新增")
        // 同时附加合并渲染信息:removed 行标 mergedIntoNext,
        // added 行带完整 mergedInlineDiff,供单行合并视图使用
        for (let idx = 0; idx < pairCount; idx++) {
          result.push({
            type: 'removed',
            text: deletedTexts[idx],
            oldLineNumber: deletedOldNums[idx],
            newLineNumber: insertedNewNums[idx],
            inlineDiff: inlineDiffs[idx].filter(s => s.type !== 'added'),
            mergedIntoNext: true,
          })
          result.push({
            type: 'added',
            text: insertedTexts[idx],
            oldLineNumber: deletedOldNums[idx],
            newLineNumber: insertedNewNums[idx],
            inlineDiff: inlineDiffs[idx].filter(s => s.type !== 'removed'),
            mergedInlineDiff: inlineDiffs[idx],
          })
        }

        // 多余的 removed 行(删除多于新增)
        for (let idx = pairCount; idx < deletedTexts.length; idx++) {
          result.push({
            type: 'removed',
            text: deletedTexts[idx],
            oldLineNumber: deletedOldNums[idx],
            newLineNumber: refNewNum,
          })
        }
        // 多余的 added 行(新增多于删除)
        for (let idx = pairCount; idx < insertedTexts.length; idx++) {
          result.push({
            type: 'added',
            text: insertedTexts[idx],
            oldLineNumber: refOldNum,
            newLineNumber: insertedNewNums[idx],
          })
        }
      }
      else {
        // 纯删除(无配对 insert):整行着色
        const refNewNum = newLineNum
        for (let idx = 0; idx < deletedTexts.length; idx++) {
          result.push({
            type: 'removed',
            text: deletedTexts[idx],
            oldLineNumber: deletedOldNums[idx],
            newLineNumber: refNewNum,
          })
        }
      }
    }
    else if (op === 'insert') {
      // 纯 insert(前面没有配对的 delete)
      while (opIdx < ops.length && ops[opIdx] === 'insert') {
        result.push({
          type: 'added',
          text: newLines[newLineNum - 1],
          oldLineNumber: oldLineNum,
          newLineNumber: newLineNum,
        })
        newLineNum++
        opIdx++
      }
    }
  }

  return result
}
