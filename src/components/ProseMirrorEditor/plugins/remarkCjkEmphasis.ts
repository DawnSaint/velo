// CJK 标点与跨节点（如 `中文**_xxx_**中文`）导致的 `**...**` 解析修复。
//
// CommonMark 把 CJK 标点及 `_` 均归类为 Unicode/ASCII punctuation，导致：
//   1. `**text：**more` 的闭合 `**` 不满足 right-flanking；
//   2. `more**（text）**` 的开启 `**` 不满足 left-flanking；
//   3. `中文**_xxx_**中文` / `a**_xxx_**b` 中，外层 `**` 紧贴 `_`（标点）且另一侧是
//      字词，remark-parse 只把内层 `_xxx_` 解析成 emphasis，外层 `**` 残留在相邻的
//      两个 text 节点里，WYSIWYG 渲染为 `**` + 斜体 xxx + `**` 而未加粗。
//
// 修复方式：在 mdast 阶段扫描每个容器的 inline children，识别跨 text / 行内节点的
// 未转义 `**...**` 对并包裹为 strong 节点。
//
// 边界：
// - 被反斜杠转义的 `\*`（由 remarkTrackEscapes 记入 `text._escapes`）绝不作为界定符；
// - 连续 `***` 不拆（remark-parse 已原生处理 `***xxx***`）；
// - 内容首尾紧贴空白的 `** foo**` / `**foo **` 不补 strong（与 CommonMark 对齐）；
// - 没有任何命中时原样返回 children，保留原 text 节点的 position 供 annotateCharRefs 回查。

import { visit } from 'unist-util-visit'
import type { Root, PhrasingContent, Text } from 'mdast'
import {
  sliceEscapedText,
  type EscapableMdastText,
} from '../editor/escape'

type Token =
  | { kind: 'text'; node: EscapableMdastText }
  | { kind: 'node'; node: PhrasingContent }
  | { kind: 'delim' }

function isUnescapedStar(value: string, idx: number, escaped: Set<number>): boolean {
  return idx >= 0 && idx < value.length && value[idx] === '*' && !escaped.has(idx)
}

function splitTextForDoubleStar(child: EscapableMdastText): { tokens: Token[]; delimCount: number } {
  const value = child.value
  const escaped = new Set(child._escapes ?? [])
  const tokens: Token[] = []
  let delimCount = 0
  let lastIdx = 0
  let i = 0
  while (i < value.length) {
    if (
      isUnescapedStar(value, i, escaped)
      && isUnescapedStar(value, i + 1, escaped)
      && !isUnescapedStar(value, i - 1, escaped)
      && !isUnescapedStar(value, i + 2, escaped)
    ) {
      if (i > lastIdx) {
        tokens.push({ kind: 'text', node: sliceEscapedText(child, lastIdx, i) })
      }
      tokens.push({ kind: 'delim' })
      delimCount++
      i += 2
      lastIdx = i
      continue
    }
    i++
  }
  if (delimCount === 0) {
    return { tokens: [{ kind: 'text', node: child }], delimCount: 0 }
  }
  if (lastIdx < value.length) {
    tokens.push({ kind: 'text', node: sliceEscapedText(child, lastIdx) })
  }
  return { tokens, delimCount }
}

function canOpenAfter(tokens: Token[], delimIdx: number): boolean {
  const next = tokens[delimIdx + 1]
  if (!next || next.kind === 'delim') return false
  if (next.kind === 'text') return !/^\s/.test(next.node.value)
  return next.node.type !== 'break'
}

function canCloseBefore(tokens: Token[], delimIdx: number): boolean {
  const prev = tokens[delimIdx - 1]
  if (!prev || prev.kind === 'delim') return false
  if (prev.kind === 'text') return !/\s$/.test(prev.node.value)
  return prev.node.type !== 'break'
}

function pushNodeMergingText(out: PhrasingContent[], node: PhrasingContent): void {
  if (node.type === 'text' && out.length > 0 && out[out.length - 1].type === 'text') {
    const prev = out[out.length - 1] as EscapableMdastText
    const cur = node as EscapableMdastText
    const offset = prev.value.length
    prev.value += cur.value
    if (cur._escapes?.length) {
      if (!prev._escapes) prev._escapes = []
      for (const idx of cur._escapes) prev._escapes.push(offset + idx)
    }
    return
  }
  out.push(node)
}

function emitToken(out: PhrasingContent[], token: Token): void {
  if (token.kind === 'delim') {
    pushNodeMergingText(out, { type: 'text', value: '**' })
  } else {
    pushNodeMergingText(out, token.node as PhrasingContent)
  }
}

function rewriteInlineChildren(children: PhrasingContent[]): PhrasingContent[] {
  // 快路径：没有任何 text 节点含 `**`，直接原样返回。
  let hasDoubleStar = false
  for (const c of children) {
    if (c.type === 'text' && (c as Text).value.includes('**')) {
      hasDoubleStar = true
      break
    }
  }
  if (!hasDoubleStar) return children

  const tokens: Token[] = []
  let textDelims = 0
  let totalDelims = 0
  for (const child of children) {
    if (child.type === 'text') {
      const { tokens: split, delimCount } = splitTextForDoubleStar(child as EscapableMdastText)
      textDelims += delimCount
      totalDelims += delimCount
      tokens.push(...split)
      continue
    }
    // 同行存在残留 `**` 时，把 remark-parse 因错位配对产生的 `**` strong 节点展平重配
    // （如 `前**_a_**中**_b_**后` 中 remark-parse 会把 `**中**` 错配成 strong('*')，
    // 导致首尾残留 `**`）；`__` strong 不展平，保持原语义。
    const maybeStrong = child as PhrasingContent & { _marker?: string; children?: PhrasingContent[] }
    if (child.type === 'strong' && maybeStrong._marker !== '_' && Array.isArray(maybeStrong.children)) {
      tokens.push({ kind: 'delim' })
      totalDelims++
      for (const grand of maybeStrong.children) {
        if (grand.type === 'text') {
          const { tokens: split, delimCount } = splitTextForDoubleStar(grand as EscapableMdastText)
          totalDelims += delimCount
          tokens.push(...split)
        } else {
          tokens.push({ kind: 'node', node: grand })
        }
      }
      tokens.push({ kind: 'delim' })
      totalDelims++
      continue
    }
    tokens.push({ kind: 'node', node: child })
  }
  if (textDelims === 0 || totalDelims < 2) return children

  const out: PhrasingContent[] = []
  let openIdx = -1
  let matched = false

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (openIdx === -1) {
      if (tok.kind === 'delim') {
        if (canOpenAfter(tokens, i)) {
          openIdx = i
        } else {
          emitToken(out, tok)
        }
      } else {
        emitToken(out, tok)
      }
    } else {
      if (tok.kind === 'delim') {
        if (i > openIdx + 1 && canCloseBefore(tokens, i)) {
          const inner: PhrasingContent[] = []
          for (let k = openIdx + 1; k < i; k++) emitToken(inner, tokens[k])
          out.push({
            type: 'strong',
            children: inner,
            _marker: '*',
          } as unknown as PhrasingContent)
          matched = true
          openIdx = -1
        } else {
          // 当前 delim 不能闭合 openIdx：放弃 openIdx，再尝试把当前 delim 当新开界定符。
          for (let k = openIdx; k < i; k++) emitToken(out, tokens[k])
          openIdx = -1
          if (canOpenAfter(tokens, i)) {
            openIdx = i
          } else {
            emitToken(out, tok)
          }
        }
      }
    }
  }

  if (openIdx !== -1) {
    for (let k = openIdx; k < tokens.length; k++) emitToken(out, tokens[k])
  }

  return matched ? out : children
}

export function remarkCjkEmphasis() {
  return (tree: Root) => {
    visit(tree, (node) => {
      if ('children' in node && Array.isArray(node.children)) {
        const parent = node as { children: PhrasingContent[] }
        parent.children = rewriteInlineChildren(parent.children)
      }
    })
  }
}
