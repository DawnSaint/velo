// CJK 标点与跨节点（如 `中文**_xxx_**中文`、`中文__*xxx*__中文`）导致的强调解析修复。
//
// CommonMark 把 CJK 标点及 `*`/`_` 均归类为 Unicode/ASCII punctuation，导致：
//   1. `**text：**more` 的闭合 `**` 不满足 right-flanking；
//   2. `more**（text）**` 的开启 `**` 不满足 left-flanking；
//   3. `中文**_xxx_**中文` / `中文__*xxx*__中文` / `中文*__xxx__*中文` / `中文_**xxx**_中文`
//      中，外层界定符紧贴内层标点且另一侧是字词，remark-parse 只解析内层，外层
//      `**`/`__`/`*`/`_` 残留在相邻的 text 节点里，WYSIWYG 渲染成裸界定符 + 单层样式。
//
// 修复方式：在 mdast 阶段按顺序对 `**`、`__` 做跨节点重配，再补跨 `strong` 节点的
// 单字符 `*`/`_` 包裹。
//
// 边界：
// - 被反斜杠转义的 `\*`/`\_`（由 remarkTrackEscapes 记入 `text._escapes`）绝不作为界定符；
// - 连续 `***`/`___` 不拆；
// - `__` 严格排除 ASCII 词内形态（`foo__bar__baz` 保持字面文本，不误转加粗）；
// - 内容首尾紧贴空白的 `** foo**` / `**foo **` 不补 strong（与 CommonMark 对齐）；
// - 没有任何命中时原样返回 children，保留原 text 节点的 position 供 annotateCharRefs 回查。

import { visit } from 'unist-util-visit'
import type { Root, PhrasingContent, Text } from 'mdast'
import {
  sliceEscapedText,
  type EscapableMdastText,
} from '../editor/escape'

type Marker = '*' | '_'

type Token =
  | { kind: 'text'; node: EscapableMdastText }
  | { kind: 'node'; node: PhrasingContent }
  | { kind: 'delim' }

function isAsciiWord(ch: string | undefined): boolean {
  return !!ch && /[a-zA-Z0-9]/.test(ch)
}

function isNonAscii(ch: string | undefined): boolean {
  return !!ch && ch.charCodeAt(0) > 0x7f
}

function isUnescapedChar(value: string, idx: number, ch: Marker, escaped: Set<number>): boolean {
  return idx >= 0 && idx < value.length && value[idx] === ch && !escaped.has(idx)
}

function splitTextForDoubleMarker(
  child: EscapableMdastText,
  marker: Marker,
): { tokens: Token[]; delimCount: number } {
  const value = child.value
  const escaped = new Set(child._escapes ?? [])
  const tokens: Token[] = []
  let delimCount = 0
  let lastIdx = 0
  let i = 0
  while (i < value.length) {
    if (
      isUnescapedChar(value, i, marker, escaped)
      && isUnescapedChar(value, i + 1, marker, escaped)
      && !isUnescapedChar(value, i - 1, marker, escaped)
      && !isUnescapedChar(value, i + 2, marker, escaped)
      // `__` 排除 ASCII 词内（如 foo__bar__baz）；跨节点边界处 i-1 或 i+2 越界，不受影响
      && !(marker === '_' && isAsciiWord(value[i - 1]) && isAsciiWord(value[i + 2]))
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

function emitToken(out: PhrasingContent[], token: Token, delimStr: string): void {
  if (token.kind === 'delim') {
    pushNodeMergingText(out, { type: 'text', value: delimStr })
  } else {
    pushNodeMergingText(out, token.node as PhrasingContent)
  }
}

function rewriteStrongMarker(children: PhrasingContent[], marker: Marker): PhrasingContent[] {
  const delimStr = marker + marker
  let hasDouble = false
  for (const c of children) {
    if (c.type === 'text' && (c as Text).value.includes(delimStr)) {
      hasDouble = true
      break
    }
  }
  if (!hasDouble) return children

  const tokens: Token[] = []
  let textDelims = 0
  let totalDelims = 0
  for (const child of children) {
    if (child.type === 'text') {
      const { tokens: split, delimCount } = splitTextForDoubleMarker(child as EscapableMdastText, marker)
      textDelims += delimCount
      totalDelims += delimCount
      tokens.push(...split)
      continue
    }
    // 同行存在残留 `**`/`__` 时，仅展平同 marker 的 strong 节点（如 `前__*a*__中__*b*__后`
    // 中 remark-parse 会把中间 `中` 错配成 strong('_')），另一 marker 的 strong 保持不动。
    const maybeStrong = child as PhrasingContent & { _marker?: string; children?: PhrasingContent[] }
    const sameMarker = (maybeStrong._marker ?? '*') === marker
    if (child.type === 'strong' && sameMarker && Array.isArray(maybeStrong.children)) {
      tokens.push({ kind: 'delim' })
      totalDelims++
      for (const grand of maybeStrong.children) {
        if (grand.type === 'text') {
          const { tokens: split, delimCount } = splitTextForDoubleMarker(grand as EscapableMdastText, marker)
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
          emitToken(out, tok, delimStr)
        }
      } else {
        emitToken(out, tok, delimStr)
      }
    } else if (tok.kind === 'delim') {
      if (i > openIdx + 1 && canCloseBefore(tokens, i)) {
        const inner: PhrasingContent[] = []
        for (let k = openIdx + 1; k < i; k++) emitToken(inner, tokens[k], delimStr)
        out.push({
          type: 'strong',
          children: inner,
          _marker: marker,
        } as unknown as PhrasingContent)
        matched = true
        openIdx = -1
      } else {
        for (let k = openIdx; k < i; k++) emitToken(out, tokens[k], delimStr)
        openIdx = -1
        if (canOpenAfter(tokens, i)) {
          openIdx = i
        } else {
          emitToken(out, tok, delimStr)
        }
      }
    }
  }

  if (openIdx !== -1) {
    for (let k = openIdx; k < tokens.length; k++) emitToken(out, tokens[k], delimStr)
  }

  return matched ? out : children
}

/**
 * 补齐单字符 `*` / `_` 包裹相邻 strong 节点的场景（如 `中文*__xxx__*中文`、`中文_**xxx**_中文`）：
 * remark-parse 已解析内层 strong，仅外层 `*`/`_` 残留在前后相邻 text 节点的末尾与开头。
 */
function rewriteOuterEmphasisAroundStrong(children: PhrasingContent[]): PhrasingContent[] {
  if (children.length < 3) return children
  let changed = false
  const out: PhrasingContent[] = []
  let i = 0
  while (i < children.length) {
    const prev = children[i]
    const mid = children[i + 1]
    const next = children[i + 2]
    if (prev?.type === 'text' && mid?.type === 'strong' && next?.type === 'text') {
      const pNode = prev as EscapableMdastText
      const nNode = next as EscapableMdastText
      const pVal = pNode.value
      const nVal = nNode.value
      const lastIdx = pVal.length - 1
      const marker = pVal[lastIdx]
      if (
        (marker === '*' || marker === '_')
        && nVal[0] === marker
        && pVal[lastIdx - 1] !== marker
        && nVal[1] !== marker
        && !pNode._escapes?.includes(lastIdx)
        && !nNode._escapes?.includes(0)
      ) {
        changed = true
        if (lastIdx > 0) {
          pushNodeMergingText(out, sliceEscapedText(pNode, 0, lastIdx) as PhrasingContent)
        }
        out.push({
          type: 'emphasis',
          children: [mid],
          _marker: marker,
        } as unknown as PhrasingContent)
        // 消耗 next 开头的 marker，剩余文本留待后续迭代继续参与匹配（支持连续多处）
        if (nVal.length > 1) {
          children = children.slice()
          children[i + 2] = sliceEscapedText(nNode, 1) as PhrasingContent
          i += 2
        } else {
          i += 3
        }
        continue
      }
    }
    pushNodeMergingText(out, children[i])
    i++
  }
  return changed ? out : children
}

function splitTextForSingleStar(
  child: EscapableMdastText,
): { tokens: Token[]; delimCount: number } {
  const value = child.value
  const escaped = new Set(child._escapes ?? [])
  const tokens: Token[] = []
  let delimCount = 0
  let lastIdx = 0
  for (let i = 0; i < value.length; i++) {
    if (
      isUnescapedChar(value, i, '*', escaped)
      && !isUnescapedChar(value, i - 1, '*', escaped)
      && !isUnescapedChar(value, i + 1, '*', escaped)
    ) {
      if (i > lastIdx) {
        tokens.push({ kind: 'text', node: sliceEscapedText(child, lastIdx, i) })
      }
      tokens.push({ kind: 'delim' })
      delimCount++
      lastIdx = i + 1
    }
  }
  if (delimCount === 0) {
    return { tokens: [{ kind: 'text', node: child }], delimCount: 0 }
  }
  if (lastIdx < value.length) {
    tokens.push({ kind: 'text', node: sliceEscapedText(child, lastIdx) })
  }
  return { tokens, delimCount }
}

function delimTouchesNonAscii(tokens: Token[], delimIdx: number): boolean {
  const prev = tokens[delimIdx - 1]
  const next = tokens[delimIdx + 1]
  const prevChar = prev?.kind === 'text' ? prev.node.value[prev.node.value.length - 1] : undefined
  const nextChar = next?.kind === 'text' ? next.node.value[0] : undefined
  return isNonAscii(prevChar) || isNonAscii(nextChar)
}

/**
 * 补齐 CJK / 全角标点 / 弯引号上下文导致的单字符 `*...*` 斜体漏配
 * （如 `看*“如果按晋江的门槛算...”*。`、`政*“支持...研发”*研发`）。
 * 至少一端界定符需紧邻非 ASCII 字符，避免误配纯 ASCII 算式 `(2*-1) + (3*-1)`。
 */
function rewriteSingleStarEmphasis(children: PhrasingContent[]): PhrasingContent[] {
  let hasStar = false
  for (const c of children) {
    if (c.type === 'text' && (c as Text).value.includes('*')) {
      hasStar = true
      break
    }
  }
  if (!hasStar) return children

  const tokens: Token[] = []
  let totalDelims = 0
  for (const child of children) {
    if (child.type === 'text') {
      const { tokens: split, delimCount } = splitTextForSingleStar(child as EscapableMdastText)
      totalDelims += delimCount
      tokens.push(...split)
    } else {
      tokens.push({ kind: 'node', node: child })
    }
  }
  if (totalDelims < 2) return children

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
          emitToken(out, tok, '*')
        }
      } else {
        emitToken(out, tok, '*')
      }
    } else if (tok.kind === 'delim') {
      const afterClose = tokens[i + 1]
      const followedByAsciiWord = afterClose?.kind === 'text' && isAsciiWord(afterClose.node.value[0])
      const hasCjkContext = delimTouchesNonAscii(tokens, openIdx) || delimTouchesNonAscii(tokens, i)
      if (i > openIdx + 1 && canCloseBefore(tokens, i) && !followedByAsciiWord && hasCjkContext) {
        const inner: PhrasingContent[] = []
        for (let k = openIdx + 1; k < i; k++) emitToken(inner, tokens[k], '*')
        out.push({
          type: 'emphasis',
          children: inner,
          _marker: '*',
        } as unknown as PhrasingContent)
        matched = true
        openIdx = -1
      } else {
        for (let k = openIdx; k < i; k++) emitToken(out, tokens[k], '*')
        openIdx = -1
        if (canOpenAfter(tokens, i)) {
          openIdx = i
        } else {
          emitToken(out, tok, '*')
        }
      }
    }
  }

  if (openIdx !== -1) {
    for (let k = openIdx; k < tokens.length; k++) emitToken(out, tokens[k], '*')
  }

  return matched ? out : children
}

function rewriteInlineChildren(children: PhrasingContent[]): PhrasingContent[] {
  let next = rewriteStrongMarker(children, '*')
  next = rewriteStrongMarker(next, '_')
  next = rewriteOuterEmphasisAroundStrong(next)
  next = rewriteSingleStarEmphasis(next)
  return next
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
