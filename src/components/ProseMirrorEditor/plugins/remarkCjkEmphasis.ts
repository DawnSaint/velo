// CJK 标点（：。（）等）导致的 `**...**` 解析修复。
//
// CommonMark 把 CJK 标点归类为 Unicode punctuation，导致 `**text：**more` 中的
// 闭合 `**` 不满足 right-flanking 条件（前面是 punctuation，后面不是
// whitespace/punctuation），无法识别为 strong。同理 `more**（text）**` 中的
// 开启 `**` 不满足 left-flanking 条件。详见 CommonMark spec emphasis & strong。
//
// 修复方式：在 mdast 阶段扫描文本节点，把未被解析器识别的 `**...**` 模式
// 转为 strong 节点。与 remarkHighlight / remarkUnderline 同款范式：parser
// 漏掉的自定义语法在 mdast 层补齐。
//
// 为什么只在文本节点上做：remark-parse 把未能识别为 strong 的 `**` 作为
// 字面量留在 text 节点里。code / inlineCode / inlineMath 等节点不受影响。
//
// 边界：内容首尾是空白的 `**...**` 不补 strong。CommonMark 本来就不认
// `** foo**` / `**foo **`，本插件只是补 CJK 标点的漏判，不应扩大语法。

import { visit } from 'unist-util-visit'
import type { Root, PhrasingContent, Text } from 'mdast'

// 匹配 **content**，content 至少 1 字符且不含 **（允许单个 *）。
// (?<!\*)  开启 ** 前面不能是 *（避免匹配 *** 残留）
// (?!\*)   闭合 ** 后面不能紧跟 *（避免 *** 误匹配）
const STRONG_RE = /(?<!\*)\*\*([^*]+(?:\*[^*]+)*)\*\*(?!\*)/g

interface StrongMatch {
  index: number
  end: number
  content: string
}

function rewriteInlineChildren(children: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = []
  for (const child of children) {
    if (child.type !== 'text') {
      out.push(child)
      continue
    }
    const value = (child as Text).value
    if (!value.includes('**')) {
      out.push(child)
      continue
    }
    // 先收集"该补成 strong"的匹配,再统一切分。跳过的匹配必须留在 text 里,
    // 不能简单 continue 掉 —— 否则它后面的有效匹配会被尾部 slice 一并吞掉。
    STRONG_RE.lastIndex = 0
    const matches: StrongMatch[] = []
    let match: RegExpExecArray | null
    while ((match = STRONG_RE.exec(value)) !== null) {
      // CommonMark:开启 `**` 后紧跟空白 / 闭合 `**` 前紧贴空白都不构成 strong
      // (不满足 left/right-flanking)。本插件只补 CJK 标点导致的漏判,不能顺手
      // 把标准里非法的 `** foo**` 也补成 strong —— 那样 wrapAttention 会把空格
      // 移出界定符,把用户源码静默改写成 `**foo**`,且多一轮 round-trip 才稳定。
      // 跳过的片段保持原 text,由 remark-stringify 转义成字面 `\*\* foo\*\*`。
      if (/^\s|\s$/.test(match[1])) continue
      matches.push({
        index: match.index,
        end: match.index + match[0].length,
        content: match[1],
      })
    }
    if (matches.length === 0) {
      out.push(child)
      continue
    }
    let lastIndex = 0
    for (const m of matches) {
      if (m.index > lastIndex) {
        out.push({ type: 'text', value: value.slice(lastIndex, m.index) })
      }
      out.push({
        type: 'strong',
        children: [{ type: 'text', value: m.content }],
      } as unknown as PhrasingContent)
      lastIndex = m.end
    }
    if (lastIndex < value.length) {
      out.push({ type: 'text', value: value.slice(lastIndex) })
    }
  }
  return out
}

export function remarkCjkEmphasis() {
  return (tree: Root) => {
    visit(tree, (node: any) => {
      if (Array.isArray(node.children)) {
        node.children = rewriteInlineChildren(node.children)
      }
    })
  }
}
