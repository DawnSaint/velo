// 标题跳转共享工具(v0.6.2 @ 符号模式 + EditorOutline 复用)。
//
// WYSIWYG 走 DOM:querySelectorAll('hN') + textContent 匹配 + scrollIntoView +
// outline-highlight 闪烁(与 EditorOutline 同款视觉)。
// 源码模式走 raw markdown 行定位:在 content 里扫出标题所在行,返回 raw char offset,
// CM6 文档即原始 markdown 串,offset == pos,交给 backend.setSelection/scrollIntoView。

import { stripFormatting } from '@/utils/outline'

/**
 * WYSIWYG 下滚动到指定标题并短暂高亮。匹配不到(标题已被改 / 不在当前 DOM)返回 false。
 */
export function revealHeadingInDom(level: number, displayText: string): boolean {
  const editor = document.querySelector('.ProseMirror') as HTMLElement | null
  if (!editor) return false
  const els = editor.querySelectorAll<HTMLElement>(`h${level}`)
  for (const el of els) {
    if (el.textContent?.trim() === displayText) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      el.classList.add('outline-highlight')
      setTimeout(() => el.classList.remove('outline-highlight'), 1500)
      return true
    }
  }
  return false
}

/**
 * 在 raw markdown 里找出指定标题的 char offset(从 content 起始算)。
 *
 * 跳过围栏代码块(``` / ~~~)内的 # —— 与 parseHeadings 的 stripFencedCodeBlocks
 * 同款语义,避免代码块里的 `# 注释` 被误判为标题导致定位错位。匹配不到返回 -1。
 */
export function findHeadingRawOffset(content: string, level: number, displayText: string): number {
  const lines = content.split('\n')
  let offset = 0
  let inFence = false
  let fenceChar = ''
  for (const line of lines) {
    const trimmed = line.trim()
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/)
    if (fenceMatch) {
      const ch = fenceMatch[1][0]
      if (!inFence) { inFence = true; fenceChar = ch }
      else if (ch === fenceChar) { inFence = false; fenceChar = '' }
    }
    else if (!inFence) {
      const m = line.match(/^(#{1,6})\s+(.+)$/)
      if (m && m[1].length === level && stripFormatting(m[2].trim()) === displayText) {
        return offset
      }
    }
    offset += line.length + 1 // +1 for \n
  }
  return -1
}
