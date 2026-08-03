/**
 * Markdown 表格单元格拆分工具
 *
 * 按管道符拆分表格行内容，正确处理转义管道符（\|）和行内代码中的管道符。
 * 移植自 vmark 的 utils/tableParser.ts，仅保留 cjkFormatter 需要的 splitTableCells。
 */

/**
 * 按管道符拆分表格行内容，尊重转义符和行内代码。
 * 不 trim 单元格——由调用方决定是否 trim。
 */
export function splitTableCells(content: string): string[] {
  const cells: string[] = []
  let cellStart = 0
  let escaped = false
  let inCode = false
  let codeFenceLen = 0

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (ch === '\\') {
      escaped = true
      continue
    }

    if (ch === '`') {
      let runLen = 1
      while (i + runLen < content.length && content[i + runLen] === '`') {
        runLen++
      }

      if (!inCode) {
        inCode = true
        codeFenceLen = runLen
      } else if (runLen === codeFenceLen) {
        inCode = false
        codeFenceLen = 0
      }

      i += runLen - 1
      continue
    }

    if (ch === '|' && !inCode) {
      cells.push(content.slice(cellStart, i))
      cellStart = i + 1
    }
  }

  cells.push(content.slice(cellStart))
  return cells
}
