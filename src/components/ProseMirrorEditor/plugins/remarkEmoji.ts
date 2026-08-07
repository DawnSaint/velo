// `:smile:` → emoji — remark 插件。
//
// GitHub Flavored Markdown 风格的 emoji 短码。在 mdast 阶段扫描每个 inline
// children 数组中的 text 节点,把 `:shortcode:` 模式切分为 text + emoji 节点
// + text。
//
// 与 remarkHighlight / remarkSupSub 同范式,但更简单 —— emoji 短码只含
// `[\w+-]` 字符,不会被 remark-parse 拆分到多个节点,无需跨节点状态机,
// 纯 in-text 正则切段即可。
//
// 短码验证:shortcode 在 node-emoji 表中存在才转换为 emoji 节点,
// 不存在则保留为纯文本(避免 `:word:` 被误吞)。
//
// 正则:`/:([\w+-]+):/g`
//   - shortcode 只允许字母/数字/下划线/连字符/加号
//   - 两侧 `:` 紧邻,`12:30`(只有一个 `:`)不匹配
//   - `key: value`(`:` 后有空格)不匹配

import { visit } from 'unist-util-visit'
import type { Root, Text, PhrasingContent } from 'mdast'
import { has as emojiHas } from 'node-emoji'

const EMOJI_RE = /:([\w+-]+):/g

/**
 * 单文本节点内含 `:shortcode:` 子串 → 跑正则切段。
 * 短码必须在 node-emoji 表中存在才转换为 emoji 节点。
 * 无匹配返回 { matched: false }。
 */
function tryInTextRegex(v: string): { matched: boolean, pieces: PhrasingContent[] } {
  EMOJI_RE.lastIndex = 0
  let m: RegExpExecArray | null
  const pieces: PhrasingContent[] = []
  let lastIdx = 0
  let hasMatch = false
  while ((m = EMOJI_RE.exec(v)) !== null) {
    const shortcode = m[1]
    if (!emojiHas(shortcode)) continue
    hasMatch = true
    if (m.index > lastIdx) {
      pieces.push({ type: 'text', value: v.slice(lastIdx, m.index) })
    }
    pieces.push({
      type: 'emoji',
      shortcode,
    } as unknown as PhrasingContent)
    lastIdx = m.index + m[0].length
  }
  if (hasMatch && lastIdx < v.length) {
    pieces.push({ type: 'text', value: v.slice(lastIdx) })
  }
  return { matched: hasMatch, pieces }
}

function rewriteInlineChildren(children: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = []
  for (const child of children) {
    if (child.type !== 'text') {
      out.push(child)
      continue
    }
    const v = (child as Text).value
    const result = tryInTextRegex(v)
    if (result.matched) {
      out.push(...result.pieces)
    } else {
      out.push(child)
    }
  }
  return out
}

export function remarkEmoji() {
  return (tree: Root) => {
    visit(tree, (node: any) => {
      if (!Array.isArray(node.children)) return
      node.children = rewriteInlineChildren(node.children)
    })
  }
}
