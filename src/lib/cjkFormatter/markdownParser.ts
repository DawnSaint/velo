/**
 * Markdown 保护区扫描器
 *
 * 识别 markdown 文本中不应被 CJK 格式化破坏的区域（代码块、URL、数学公式、
 * frontmatter、HTML、wiki link、脚注等），返回排序且合并后的非重叠区域列表。
 *
 * 移植自 vmark，零外部依赖。
 */

export interface ProtectedRegion {
  start: number
  end: number
  type:
    | 'fenced_code'
    | 'inline_code'
    | 'indented_code'
    | 'link_url'
    | 'image'
    | 'frontmatter'
    | 'html_tag'
    | 'wiki_link'
    | 'footnote_ref'
    | 'footnote_def'
    | 'math_block'
    | 'math_inline'
    | 'thematic_break'
    | 'reference_section'
}

export interface ProtectedRegionOptions {
  /** 跳过 ## References 和 ## Further Reading 段落（默认 off）。 */
  skipReferenceSections?: boolean
}

/**
 * 查找 markdown 文本中所有保护区。
 * 检测顺序有讲究：围栏代码块先于行内代码，图片先于链接（避免图片 URL 被单独保护）。
 */
export function findProtectedRegions(
  text: string,
  options: ProtectedRegionOptions = {},
): ProtectedRegion[] {
  const regions: ProtectedRegion[] = []

  // 1. Frontmatter（必须在文档开头）
  const frontmatterMatch = text.match(/^---\r?\n[\s\S]*?\r?\n---/)
  if (frontmatterMatch) {
    regions.push({
      start: 0,
      end: frontmatterMatch[0].length,
      type: 'frontmatter',
    })
  }

  // 1b. 分割线（---, ***, ___ 独占一行）
  const thematicBreakRegex = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm
  let thematicMatch
  while ((thematicMatch = thematicBreakRegex.exec(text)) !== null) {
    if (!isInsideRegion(thematicMatch.index, regions)) {
      regions.push({
        start: thematicMatch.index,
        end: thematicMatch.index + thematicMatch[0].length,
        type: 'thematic_break',
      })
    }
  }

  // 2. 围栏代码块（``` 或 ~~~）
  const fencedCodeRegex = /^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm
  let match
  while ((match = fencedCodeRegex.exec(text)) !== null) {
    regions.push({
      start: match.index,
      end: match.index + match[0].length,
      type: 'fenced_code',
    })
  }

  // 3. 行内代码（反引号）
  const inlineCodeRegex = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g
  while ((match = inlineCodeRegex.exec(text)) !== null) {
    if (!isInsideRegion(match.index, regions)) {
      regions.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'inline_code',
      })
    }
  }

  // 4. 图片：![alt](url)
  const imageRegex = /!\[[^\]]*\]\([^)]+\)/g
  while ((match = imageRegex.exec(text)) !== null) {
    if (!isInsideRegion(match.index, regions)) {
      regions.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'image',
      })
    }
  }

  // 5. 链接 URL：[text](url) — 只保护 URL 部分，不保护显示文本
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g
  while ((match = linkRegex.exec(text)) !== null) {
    if (!isInsideRegion(match.index, regions)) {
      const urlStart = match.index + match[1].length + 3
      const urlEnd = match.index + match[0].length - 1
      regions.push({
        start: urlStart,
        end: urlEnd,
        type: 'link_url',
      })
    }
  }

  // 6. HTML 标签
  const htmlTagRegex = /<[a-zA-Z][^>]*>|<\/[a-zA-Z][^>]*>/g
  while ((match = htmlTagRegex.exec(text)) !== null) {
    if (!isInsideRegion(match.index, regions)) {
      regions.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'html_tag',
      })
    }
  }

  // 7. Wiki links：[[target]] 或 [[target|display]]
  const wikiLinkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
  while ((match = wikiLinkRegex.exec(text)) !== null) {
    if (!isInsideRegion(match.index, regions)) {
      regions.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'wiki_link',
      })
    }
  }

  // 8. 脚注定义：[^1]: content（保护标记，不保护内容）
  const footnoteDefRegex = /^\[\^[^\]]+\]:/gm
  while ((match = footnoteDefRegex.exec(text)) !== null) {
    if (!isInsideRegion(match.index, regions)) {
      regions.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'footnote_def',
      })
    }
  }

  // 9. 脚注引用：[^1]
  const footnoteRefRegex = /\[\^[^\]]+\]/g
  while ((match = footnoteRefRegex.exec(text)) !== null) {
    if (!isInsideRegion(match.index, regions)) {
      regions.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'footnote_ref',
      })
    }
  }

  // 10. 数学块：$$...$$
  const mathBlockRegex = /\$\$[\s\S]*?\$\$/g
  while ((match = mathBlockRegex.exec(text)) !== null) {
    if (!isInsideRegion(match.index, regions)) {
      regions.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'math_block',
      })
    }
  }

  // 11. 行内数学：$...$（排除 $$ 和转义 \$）
  const mathInlineRegex = /(?<!\$)\$(?!\$)([^$\n]+)\$(?!\$)/g
  while ((match = mathInlineRegex.exec(text)) !== null) {
    if (!isInsideRegion(match.index, regions)) {
      regions.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'math_inline',
      })
    }
  }

  // 12. 缩进代码块（4+ 空格行首，但不在列表中）
  const lines = text.split('\n')
  let pos = 0
  let inIndentedBlock = false
  let blockStart = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const isIndented = /^( {4}|\t)/.test(line) && line.trim().length > 0
    const isBlankLine = line.trim().length === 0

    if (isIndented && !isInsideRegion(pos, regions)) {
      if (!inIndentedBlock) {
        let prevNonBlank = i - 1
        while (prevNonBlank >= 0 && lines[prevNonBlank].trim() === '') {
          prevNonBlank--
        }
        const isListContinuation =
          prevNonBlank >= 0 &&
          /^[\s]*(?:[-*+]|\d+\.)/.test(lines[prevNonBlank])

        if (!isListContinuation) {
          inIndentedBlock = true
          blockStart = pos
        }
      }
    } else if (!isBlankLine && inIndentedBlock) {
      regions.push({
        start: blockStart,
        end: pos,
        type: 'indented_code',
      })
      inIndentedBlock = false
    }

    pos += line.length + 1
  }

  if (inIndentedBlock) {
    regions.push({
      start: blockStart,
      end: text.length,
      type: 'indented_code',
    })
  }

  // 13. 参考文献段落（可选）
  if (options.skipReferenceSections) {
    const refHeadingRegex = /^## (?:References|Further Reading)[ \t]*$/gm
    const nextH2Regex = /^## /gm
    let refMatch
    while ((refMatch = refHeadingRegex.exec(text)) !== null) {
      if (isInsideRegion(refMatch.index, regions)) continue
      nextH2Regex.lastIndex = refMatch.index + refMatch[0].length
      const nextHeading = nextH2Regex.exec(text)
      const sectionEnd = nextHeading ? nextHeading.index : text.length
      regions.push({
        start: refMatch.index,
        end: sectionEnd,
        type: 'reference_section',
      })
    }
  }

  // 排序
  regions.sort((a, b) => a.start - b.start)

  // 合并重叠或包含的区域
  const merged: ProtectedRegion[] = []
  for (const region of regions) {
    const last = merged[merged.length - 1]
    if (last && region.start < last.end) {
      if (region.end > last.end) last.end = region.end
    } else {
      merged.push({ ...region })
    }
  }

  return merged
}

/** 检查位置是否在某个保护区内。 */
function isInsideRegion(pos: number, regions: ProtectedRegion[]): boolean {
  return regions.some((r) => pos >= r.start && pos < r.end)
}
