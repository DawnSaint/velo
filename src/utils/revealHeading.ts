// 标题 / 行号跳转共享工具(v0.6.2 @ 符号模式 + EditorOutline 复用; : 行号模式)。
//
// WYSIWYG 走 DOM:querySelectorAll('hN') + textContent 匹配 + scrollIntoView +
// outline-highlight 闪烁(与 EditorOutline 同款视觉)。
// 源码模式走 raw markdown 行定位:在 content 里扫出标题所在行,返回 raw char offset,
// CM6 文档即原始 markdown 串,offset == pos,交给 backend.setSelection/scrollIntoView。
// findLineOffset 是 : 行号模式用的同族工具:返回第 N 行起始的 char offset。

import { stripFormatting } from '@/utils/outline'

/**
 * WYSIWYG 下滚动到指定标题并短暂高亮。匹配不到(标题已被改 / 不在当前 DOM)返回 null;
 * 命中返回该标题 DOM 元素,供调用方在 focus 前把 PM 选区设到该位置,
 * 避免 focus 触发浏览器滚动到旧选区把高亮滚出视口。
 */
export function revealHeadingInDom(level: number, displayText: string): HTMLElement | null {
  const editor = document.querySelector('.ProseMirror') as HTMLElement | null
  if (!editor) return null
  const els = editor.querySelectorAll<HTMLElement>(`h${level}`)
  for (const el of els) {
    if (el.textContent?.trim() === displayText) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      el.classList.add('outline-highlight')
      setTimeout(() => el.classList.remove('outline-highlight'), 1500)
      return el
    }
  }
  return null
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

/**
 * 返回 raw markdown 里第 `line` 行(1-based)起始的 char offset。
 *
 * line <= 1 → 0;行号超过总行数 → content.length(夹到文末,不越界)。
 * 与 findHeadingRawOffset 同族:CM6 文档即原始 markdown 串,offset == pos。
 * 用 indexOf 逐个找换行,避免 split 出整份数组(大文档友好)。
 */
export function findLineOffset(content: string, line: number): number {
  if (!Number.isFinite(line) || line <= 1) return 0
  let pos = 0
  let n = 1
  while (n < line) {
    const i = content.indexOf('\n', pos)
    if (i === -1) return content.length
    pos = i + 1
    n++
  }
  return pos
}

/**
 * 取第 `line` 行(1-based)的文本与是否存在。
 *
 * exists:false 表示行号越界(超过总行数) —— 与空行(存在但文本为 '')区分开,
 * 供 : 行号模式判断"匹配行号是否存在"以决定渲染行还是空态。
 * 复用 findLineOffset 的同款 indexOf 扫法,不 split 整份数组。
 */
export function getLineText(content: string, line: number): { text: string, exists: boolean } {
  if (!Number.isFinite(line) || line < 1) return { text: '', exists: false }
  let pos = 0
  let n = 1
  while (n < line) {
    const i = content.indexOf('\n', pos)
    if (i === -1) return { text: '', exists: false }
    pos = i + 1
    n++
  }
  const end = content.indexOf('\n', pos)
  return { text: end === -1 ? content.slice(pos) : content.slice(pos, end), exists: true }
}

/**
 * 返回文档总行数(尾随 \n 也算一行,与 VSCode / CM6 行号一致;空串 → 1)。
 * 供 : 行号模式 hint 显示"从 1 到 N"。同样用 indexOf 扫,不 split。
 */
export function getLineCount(content: string): number {
  let count = 1
  let pos = 0
  let i: number
  while ((i = content.indexOf('\n', pos)) !== -1) {
    count++
    pos = i + 1
  }
  return count
}
