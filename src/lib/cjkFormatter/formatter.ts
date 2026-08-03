/**
 * CJK 文本格式化器主入口
 *
 * 编排格式化流水线：保护区扫描 → 分段提取 → 规则应用 → 重建 → 完整性校验。
 * 表格逐单元格格式化以保持对齐。格式化后若完整性校验失败则回滚原文。
 *
 * 移植自 vmark，适配 velo 的导入路径。
 */

import type { CJKFormattingSettings } from './types'
import { findProtectedRegions, type ProtectedRegion } from './markdownParser'
import {
  extractFormattableSegments,
  reconstructText,
  type TextSegment,
} from './segments'
import { applyRules } from './rules'
import { splitTableCells } from './tableParser'
import { verifyIntegrity } from './integrity'

interface TableBlock {
  start: number
  end: number
}

interface LineInfo {
  start: number
  text: string
  lineBreak: string
}

function isInsideRegion(pos: number, regions: Array<{ start: number; end: number }>): boolean {
  return regions.some((r) => pos >= r.start && pos < r.end)
}

function splitLines(text: string): LineInfo[] {
  const chunks = text.split(/(\r?\n)/)
  const lines: LineInfo[] = []
  let offset = 0

  for (let i = 0; i < chunks.length; i += 2) {
    const lineText = chunks[i] ?? ''
    const lineBreak = chunks[i + 1] ?? ''
    lines.push({ start: offset, text: lineText, lineBreak })
    offset += lineText.length + lineBreak.length
  }

  return lines
}

function splitBlockquotePrefix(line: string): { prefix: string; content: string } {
  const match = line.match(/^(\s*(?:>\s*)*)/)
  const prefix = match?.[1] ?? ''
  return { prefix, content: line.slice(prefix.length) }
}

function isTableDelimiterRow(content: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(content)
}

function hasPipeOutsideCode(content: string): boolean {
  return splitTableCells(content).length > 1
}

function detectTableBlocks(
  text: string,
  protectedRegions: Array<{ start: number; end: number }>,
): TableBlock[] {
  const lines = splitLines(text)
  const blocks: TableBlock[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const { prefix, content } = splitBlockquotePrefix(line.text)

    if (isInsideRegion(line.start, protectedRegions)) {
      i += 1
      continue
    }

    if (!isTableDelimiterRow(content)) {
      i += 1
      continue
    }

    if (i === 0) {
      i += 1
      continue
    }

    const header = lines[i - 1]
    const headerSplit = splitBlockquotePrefix(header.text)
    if (headerSplit.prefix !== prefix) {
      i += 1
      continue
    }

    if (isInsideRegion(header.start, protectedRegions)) {
      i += 1
      continue
    }

    if (!hasPipeOutsideCode(headerSplit.content)) {
      i += 1
      continue
    }

    let endLine = i
    let j = i + 1
    while (j < lines.length) {
      const bodyLine = lines[j]
      const bodySplit = splitBlockquotePrefix(bodyLine.text)
      if (bodySplit.prefix !== prefix) break
      if (bodySplit.content.trim().length === 0) break
      if (isInsideRegion(bodyLine.start, protectedRegions)) break
      if (!hasPipeOutsideCode(bodySplit.content)) break
      if (isTableDelimiterRow(bodySplit.content)) break
      endLine = j
      j += 1
    }

    const start = header.start
    const endLineInfo = lines[endLine]
    const end = endLineInfo.start + endLineInfo.text.length + endLineInfo.lineBreak.length

    blocks.push({ start, end })
    i = endLine + 1
  }

  return blocks
}

function formatMarkdownWithoutTables(
  text: string,
  config: CJKFormattingSettings,
  options: { preserveTwoSpaceHardBreaks?: boolean } = {},
  existingRegions?: ProtectedRegion[],
): string {
  const protectedRegions = existingRegions ?? findProtectedRegions(text, {
    skipReferenceSections: config.skipReferenceSections,
  })
  const segments = extractFormattableSegments(text, protectedRegions)
  const formattedSegments: TextSegment[] = segments.map((segment) => ({
    ...segment,
    text: applyRules(segment.text, config, options),
  }))
  return reconstructText(text, formattedSegments, protectedRegions)
}

function formatTableBlock(
  tableText: string,
  config: CJKFormattingSettings,
  options: { preserveTwoSpaceHardBreaks?: boolean } = {},
): string {
  const lines = splitLines(tableText)

  let delimiterIndex = -1
  for (let i = 0; i < lines.length; i += 1) {
    const split = splitBlockquotePrefix(lines[i].text)
    if (isTableDelimiterRow(split.content)) {
      delimiterIndex = i
      break
    }
  }

  return lines
    .map((line, idx) => {
      if (idx === delimiterIndex) return line.text + line.lineBreak

      const { prefix, content } = splitBlockquotePrefix(line.text)
      const cells = splitTableCells(content)
      if (cells.length <= 1) return line.text + line.lineBreak

      const nextCells = cells.map((cell) => {
        const match = cell.match(/^(\s*)([\s\S]*?)(\s*)$/)
        const leading = match?.[1] ?? ''
        const core = match?.[2] ?? cell
        const trailing = match?.[3] ?? ''

        const formatted = formatMarkdownWithoutTables(core, config, options)
        const safe = formatted.replace(/\r?\n/g, '')
        return `${leading}${safe}${trailing}`
      })

      return `${prefix}${nextCells.join('|')}${line.lineBreak}`
    })
    .join('')
}

/**
 * 用 CJK 排版规则格式化 markdown 文本。
 * 保护代码块、URL、frontmatter 等保护区不被破坏。
 */
export function formatMarkdown(
  text: string,
  config: CJKFormattingSettings,
  options: { preserveTwoSpaceHardBreaks?: boolean } = {},
): string {
  const protectedRegions = findProtectedRegions(text, {
    skipReferenceSections: config.skipReferenceSections,
  })
  const tableBlocks = detectTableBlocks(text, protectedRegions)

  let out: string

  if (tableBlocks.length === 0) {
    out = formatMarkdownWithoutTables(text, config, options, protectedRegions)
  } else {
    out = ''
    let cursor = 0

    for (const block of tableBlocks) {
      if (block.start > cursor) {
        out += formatMarkdownWithoutTables(text.slice(cursor, block.start), config, options)
      }

      out += formatTableBlock(text.slice(block.start, block.end), config, options)
      cursor = block.end
    }

    if (cursor < text.length) {
      out += formatMarkdownWithoutTables(text.slice(cursor), config, options)
    }
  }

  out = out.trimEnd()

  const integrity = verifyIntegrity(text, out)
  if (!integrity.ok) {
    console.warn('[cjkFormatter] Integrity check failed, returning original text:', integrity.details)
    return text
  }

  return out
}

/**
 * 格式化选区文本（假设无 markdown 结构需要保护）。
 */
export function formatSelection(
  text: string,
  config: CJKFormattingSettings,
  options: { preserveTwoSpaceHardBreaks?: boolean } = {},
): string {
  return applyRules(text, config, options)
}
