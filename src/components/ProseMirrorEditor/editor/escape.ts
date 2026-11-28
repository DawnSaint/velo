// Markdown 反斜杠转义（CommonMark §2.4 `\<ASCII punct>`）的纯工具函数。
//
// parse 阶段由 plugins/remarkTrackEscapes.ts 把 micromark 识别出的转义字符
// 下标记到 mdast text._escapes；markdownIO 转成 PM text + escape mark（存解码后
// 的字符，如 `*` / `[`），toMarkdown 还原为 `\<char>`；escapeSourceEditPlugin
// 在光标进入时临时展开为 `\*`（浅灰 `\`），移开还原。

import type { Node as PMNode } from 'prosemirror-model'

export const ESCAPE_MARK = 'escape'

/** CommonMark §2.4 允许反斜杠转义的 32 个 ASCII 标点。 */
const ESCAPABLE_CHAR_RE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/

/** 匹配成对的 `\<ASCII punct>` 转义序列（全局扫描用）。 */
export const ESCAPE_PAIR_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g

export function isEscapableChar(ch: string): boolean {
  return ch.length === 1 && ESCAPABLE_CHAR_RE.test(ch)
}

export function hasEscapeMark(node: PMNode): boolean {
  return node.isText && node.marks.some(m => m.type.name === ESCAPE_MARK)
}

/** 把带 escape mark 的解码文本展开成 markdown 源码（每个可转义字符前补 `\`）。 */
export function expandEscapedText(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    out += isEscapableChar(ch) ? `\\${ch}` : ch
  }
  return out
}

/**
 * 解码文本下标 → 展开源码文本下标。
 * 例：`decoded = "**"`, `expanded = "\\*\\*"`：0→0, 1→2, 2→4。
 */
export function expandedOffsetFor(decoded: string, decodedOffset: number): number {
  const clamped = Math.max(0, Math.min(decodedOffset, decoded.length))
  let out = 0
  for (let i = 0; i < clamped; i++) {
    out += isEscapableChar(decoded[i]) ? 2 : 1
  }
  return out
}

/**
 * 展开源码下标 → 解码文本（doc 相对）下标，供查找后端把 `\*` 命中映射到 PM 坐标。
 * 与 buildCharRefIndexMap 同口径：每个 `\<ch>` 的 `\` 与 `<ch>` 都落在该解码字符上，
 * 段末跳到解码字符之后。
 */
export function buildEscapeIndexMap(decoded: string): number[] {
  const map: number[] = [0]
  for (let i = 0; i < decoded.length; i++) {
    if (isEscapableChar(decoded[i])) {
      map.push(i)
      map.push(i + 1)
    } else {
      map.push(i + 1)
    }
  }
  return map
}

export interface EscapableMdastText {
  type: 'text'
  value: string
  _escapes?: number[]
  position?: unknown
}

/** 判断 mdast text 节点指定下标是否来自反斜杠转义。 */
export function isIndexEscaped(node: EscapableMdastText, idx: number): boolean {
  return !!node._escapes?.includes(idx)
}

/**
 * 从带 `_escapes` 的 mdast text 节点切片，保留落入 [start, end) 内的转义下标
 * （平移到切片相对偏移），避免 remark 插件切分文本节点后丢失转义标记。
 */
export function sliceEscapedText(
  node: EscapableMdastText,
  start: number,
  end = node.value.length,
): EscapableMdastText {
  const value = node.value.slice(start, end)
  const out: EscapableMdastText = { type: 'text', value }
  if (node._escapes?.length) {
    const shifted: number[] = []
    for (const idx of node._escapes) {
      if (idx >= start && idx < end) shifted.push(idx - start)
    }
    if (shifted.length) out._escapes = shifted
  }
  return out
}

/**
 * 读取 doc 区间 [from, to) 的纯文本，同时把带 escape mark 的字符还原为 `\<char>`
 * （hardbreak 转为 `\n`）。供 inlineCode / inlineMath / mathBlock 等字面量语法在
 * 转换时还原用户键入的原始反斜杠。
 */
export function getRawTextExpandingEscapes(doc: PMNode, from: number, to: number): string {
  let out = ''
  doc.nodesBetween(from, to, (node, pos) => {
    const nodeEnd = pos + node.nodeSize
    if (pos >= to || nodeEnd <= from) return true
    if (node.isText) {
      const sliceStart = Math.max(0, from - pos)
      const sliceEnd = Math.min(node.nodeSize, to - pos)
      const slice = (node.text ?? '').slice(sliceStart, sliceEnd)
      out += hasEscapeMark(node) ? expandEscapedText(slice) : slice
      return false
    }
    if (node.type.name === 'hardbreak') {
      out += '\n'
      return false
    }
    return true
  })
  return out
}
