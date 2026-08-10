// 行级 diff 工具 —— 基于 LCS(最长公共子序列)算法。
//
// 用于版本历史对比视图:把旧版本(快照)与新版本(当前内容)按行对齐,
// 标记新增 / 删除 / 不变行。不依赖第三方库,纯函数实现。

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged'
  text: string
  /** 行号(added/unchanged 用新版本行号;removed 用旧版本行号) */
  oldLineNumber: number
  newLineNumber: number
}

/**
 * 计算两段文本的行级 diff。
 * oldText = 快照内容(旧),newText = 当前内容(新)。
 * 返回 DiffLine 数组,保持文档顺序:不变行和删除行来自旧版本,
 * 不变行和新增行来自新版本。
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText ? oldText.split('\n') : []
  const newLines = newText ? newText.split('\n') : []
  const m = oldLines.length
  const n = newLines.length

  // LCS DP 表 —— 对大文档会占 O(m*n) 内存,但版本快照对比场景
  // (单篇 markdown)尺寸可控;如果未来需要支持超大文件 diff,
  // 可改用 Myers 算法(线性空间)。典型 markdown < 2000 行,
  // 2000*2000*4 bytes = ~16MB,可接受。
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1
      }
      else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  // 回溯生成 diff 行
  const result: DiffLine[] = []
  let i = 0
  let j = 0
  let oldLineNum = 1
  let newLineNum = 1

  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: 'unchanged', text: oldLines[i], oldLineNumber: oldLineNum, newLineNumber: newLineNum })
      i++
      j++
      oldLineNum++
      newLineNum++
    }
    else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // 旧版本有这行,新版本没有 → 删除
      result.push({ type: 'removed', text: oldLines[i], oldLineNumber: oldLineNum, newLineNumber: newLineNum })
      i++
      oldLineNum++
    }
    else {
      // 新版本有这行,旧版本没有 → 新增
      result.push({ type: 'added', text: newLines[j], oldLineNumber: oldLineNum, newLineNumber: newLineNum })
      j++
      newLineNum++
    }
  }
  // 尾部剩余
  while (i < m) {
    result.push({ type: 'removed', text: oldLines[i], oldLineNumber: oldLineNum, newLineNumber: newLineNum })
    i++
    oldLineNum++
  }
  while (j < n) {
    result.push({ type: 'added', text: newLines[j], oldLineNumber: oldLineNum, newLineNumber: newLineNum })
    j++
    newLineNum++
  }

  return result
}
