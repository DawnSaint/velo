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

import { visit } from 'unist-util-visit'
import type { Root, PhrasingContent, Text } from 'mdast'

// 匹配 **content**，content 至少 1 字符且不含 **（允许单个 *）。
// (?<!\*)  开启 ** 前面不能是 *（避免匹配 *** 残留）
// (?!\*)   闭合 ** 后面不能紧跟 *（避免 *** 误匹配）
const STRONG_RE = /(?<!\*)\*\*([^*]+(?:\*[^*]+)*)\*\*(?!\*)/g

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
    STRONG_RE.lastIndex = 0
    let lastIndex = 0
    let match: RegExpExecArray | null
    let hasMatch = false
    while ((match = STRONG_RE.exec(value)) !== null) {
      hasMatch = true
      if (match.index > lastIndex) {
        out.push({ type: 'text', value: value.slice(lastIndex, match.index) })
      }
      out.push({
        type: 'strong',
        children: [{ type: 'text', value: match[1] }],
      } as unknown as PhrasingContent)
      lastIndex = match.index + match[0].length
    }
    if (!hasMatch) {
      out.push(child)
      continue
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
