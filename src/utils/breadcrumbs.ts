import type { Node as PMNode } from 'prosemirror-model'
import { stripFormatting } from '@/utils/outline'

export interface HeadingBreadcrumb {
  level: number
  text: string
}

/**
 * WYSIWYG: 遍历 PM doc 从起点到光标位置,构建标题祖先链。
 *
 * 用栈维护祖先链:遇到 level >= 栈顶的标题就弹出,直到找到更高级的父标题。
 * 光标在标题内部时,该标题也计入链中(pos < cursorPos)。
 */
export function headingChainFromDoc(doc: PMNode, cursorPos: number): HeadingBreadcrumb[] {
  const chain: HeadingBreadcrumb[] = []
  doc.nodesBetween(0, cursorPos, (node, pos) => {
    if (node.type.name === 'heading' && pos < cursorPos) {
      const level = node.attrs.level as number
      while (chain.length > 0 && chain[chain.length - 1].level >= level) {
        chain.pop()
      }
      chain.push({ level, text: node.textContent.trim() })
    }
    return true
  })
  return chain
}

/**
 * 源码模式:扫描 raw markdown 行(到光标所在行),构建标题祖先链。
 *
 * 与 parseHeadings 同款围栏代码块守卫(跳过 ``` / ~~~ 内的 #),
 * heading text 经 stripFormatting 去掉 markdown 标记字符。
 * cursorLine 为 1-based。
 */
export function headingChainFromMarkdown(content: string, cursorLine: number): HeadingBreadcrumb[] {
  const lines = content.split('\n')
  const chain: HeadingBreadcrumb[] = []
  let inFence = false
  let fenceChar = ''

  const endLine = Math.min(cursorLine, lines.length)
  for (let i = 0; i < endLine; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/)
    if (fenceMatch) {
      const ch = fenceMatch[1][0]
      if (!inFence) { inFence = true; fenceChar = ch }
      else if (ch === fenceChar) { inFence = false; fenceChar = '' }
      continue
    }
    if (inFence) continue
    const m = line.match(/^(#{1,6})\s+(.+)$/)
    if (m) {
      const level = m[1].length
      const text = stripFormatting(m[2].trim())
      while (chain.length > 0 && chain[chain.length - 1].level >= level) {
        chain.pop()
      }
      chain.push({ level, text })
    }
  }
  return chain
}
