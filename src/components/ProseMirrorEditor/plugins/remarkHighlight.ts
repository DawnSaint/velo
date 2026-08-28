// `==xxx==` 高亮 — remark 插件。
//
// GFM 不支持 `==` 高亮(只在 Obsidian / Logseq 用),所以要在 mdast 阶段自己识别。
//
// 两层处理:
// 1. 单文本节点内含 `==xxx==` 子串(`text ==hi== more` / `==hi==`):跑正则切段
// 2. 跨节点的 `==xxx==`(`==**bold**==` / `==a *b* c==`):state machine 配对
//    边界 + 中间内容,state 切换 flush 成 highlight 节点
//
// word boundary 规则(只挡前面不挡后面):
//   `(?<![/:])==` —— `==` 之前不能紧跟 `:`/`/`(避免 URL 中的 `==` 被误切)
//   `==([^=\n]+?)==` —— inner 不含 `=` / `\n`(至少 1 字符)
//   后面不挡 —— `==bold and **strong**==` 这种 word 字符紧跟 open 是合法的
//   (Obsidian / Logseq 接受),只在 state-machine 边界匹配时复用同样的"前缀检查"
//
// 允许 `a==bc==` 中 `==` 前面紧跟单词字符(word==hl==word 是合法语法);
// 旧版 `(?<![\w:/])` 挡了 `\w` 导致 `a==bc==` 无法识别,与实时转换端保持一致。

import { visit } from 'unist-util-visit'
import type { Root, Text, PhrasingContent } from 'mdast'

const HL_RE = /(?<![/:])==([^=\n]+?)==/g

/** boundary 拒绝字符:`:` + `/`(挡 URL 中的 `==` 被误切) */
const isBoundaryRejectChar = (c: string) => /[/:]/.test(c)

/**
 * 单段文本节点相对 `==` 的形态。
 * - plain   无 `==`
 * - pure    整个文本就是 `==`
 * - both    `==xxx==` 单节点全包
 * - endEq   末尾是 `==`(prefix 在前;`==` 在末尾)
 * - startEq 开头是 `==`(rest 在后;`==` 在开头)
 */
type TextVariant =
  | { kind: 'plain', value: string }
  | { kind: 'pure' }
  | { kind: 'both', content: string }
  | { kind: 'endEq', prefix: string }
  | { kind: 'startEq', rest: string }

function classifyText(v: string): TextVariant {
  if (v === '==') return { kind: 'pure' }
  const endsEq = v.endsWith('==')
  const startsEq = v.startsWith('==')
  if (startsEq && endsEq && v.length >= 4) {
    return { kind: 'both', content: v.slice(2, -2) }
  }
  if (endsEq) return { kind: 'endEq', prefix: v.slice(0, -2) }
  if (startsEq && v.length > 2) return { kind: 'startEq', rest: v.slice(2) }
  return { kind: 'plain', value: v }
}

/**
 * 单文本节点内含 `==xxx==` 子串(`text ==hi== more`)—— 跑 HL_RE 切段。
 * 无匹配返回 { matched: false }。
 */
function tryInTextRegex(v: string): { matched: boolean, pieces: PhrasingContent[] } {
  HL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  const pieces: PhrasingContent[] = []
  let lastIdx = 0
  let hasMatch = false
  while ((m = HL_RE.exec(v)) !== null) {
    hasMatch = true
    if (m.index > lastIdx) {
      pieces.push({ type: 'text', value: v.slice(lastIdx, m.index) })
    }
    pieces.push({
      type: 'highlight',
      children: [{ type: 'text', value: m[1] }],
    } as unknown as PhrasingContent)
    lastIdx = m.index + m[0].length
    if (m[0].length === 0) HL_RE.lastIndex++
  }
  if (hasMatch && lastIdx < v.length) {
    pieces.push({ type: 'text', value: v.slice(lastIdx) })
  }
  return { matched: hasMatch, pieces }
}

function rewriteInlineChildren(children: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = []
  let buffer: PhrasingContent[] = []
  let inHighlight = false

  const flush = () => {
    if (buffer.length > 0) {
      out.push({
        type: 'highlight',
        children: buffer,
      } as unknown as PhrasingContent)
    }
    buffer = []
    inHighlight = false
  }

  const unflush = () => {
    out.push(...buffer)
    buffer = []
    inHighlight = false
  }

  for (let i = 0; i < children.length; i++) {
    const child = children[i]

    if (child.type !== 'text') {
      if (inHighlight) buffer.push(child)
      else out.push(child)
      continue
    }

    const v = (child as Text).value

    if (!inHighlight) {
      // 优先尝试 in-text 正则(`text ==hi== more` / `==hi==` / `more ==hi==`)
      const inText = tryInTextRegex(v)
      if (inText.matched) {
        out.push(...inText.pieces)
        continue
      }

      const variant = classifyText(v)
      switch (variant.kind) {
        case 'plain':
          out.push(child)
          break
        case 'pure':
          // 纯 `==` —— 进 inHighlight 等待 close(后续若找不到 close 则 unflush)
          inHighlight = true
          buffer = []
          break
        case 'both': {
          // 单节点 `==xxx==` —— 直接产 highlight
          if (variant.content) {
            out.push({
              type: 'highlight',
              children: [{ type: 'text', value: variant.content }],
            } as unknown as PhrasingContent)
          }
          else {
            // 空 highlight `====` —— 保持字面量,不识别
            out.push(child)
          }
          break
        }
        case 'endEq': {
          // prefix + `==` —— 检查 prefix 末尾是否是 boundary 拒绝字符(`:` / `/`)
          // 拒绝字符 = 这是无效的 open(URL 中的 ==),整段当 plain 输出
          const lastChar = variant.prefix.length > 0
            ? variant.prefix.charAt(variant.prefix.length - 1)
            : '' // prefix 为空就是纯 `==`,已走 pure 分支,不会到这
          if (variant.prefix && isBoundaryRejectChar(lastChar)) {
            out.push(child)
            break
          }
          if (variant.prefix) out.push({ type: 'text', value: variant.prefix })
          inHighlight = true
          buffer = []
          break
        }
        case 'startEq': {
          // `==` + rest —— 这是 OPEN marker,rest 进 buffer 进 highlight
          // 不检查 rest 首字符:Obsidian/Logseq 风格 `==bold and **strong**==`
          // 允许 open `==` 后紧跟 word 字符(b / 等),只要前面不是 word 即可
          inHighlight = true
          buffer = variant.rest ? [{ type: 'text', value: variant.rest }] : []
          break
        }
      }
    }
    else {
      // inHighlight —— 期待 close
      const variant = classifyText(v)
      switch (variant.kind) {
        case 'plain':
          buffer.push(child)
          break
        case 'pure':
          // 纯 `==` —— close
          flush()
          break
        case 'both': {
          // `==xxx==` —— content 是 highlight 内,然后 close
          if (variant.content) buffer.push({ type: 'text', value: variant.content })
          flush()
          break
        }
        case 'endEq': {
          // prefix + `==` —— prefix 是 highlight 内容,`==` 是 close
          // 不检查 prefix.lastChar:那是 highlight 内容的字面字符,
          // 不是 close marker 的边界。close 边界在 `==` 之后,跨节点留到下个节点判定。
          if (variant.prefix) buffer.push({ type: 'text', value: variant.prefix })
          flush()
          break
        }
        case 'startEq': {
          // `==` + rest —— `==` 是 close,rest 是 close 之后的 plain
          flush()
          if (variant.rest) out.push({ type: 'text', value: variant.rest })
          break
        }
      }
    }
  }

  if (inHighlight) unflush()
  return out
}

export function remarkHighlight() {
  return (tree: Root) => {
    visit(tree, (node: any) => {
      if (!Array.isArray(node.children)) return
      node.children = rewriteInlineChildren(node.children)
    })
  }
}