// `^text^` 上标 / `~text~` 下标 — remark 插件。
//
// GFM / CommonMark 不支持上下标语法(Obsidian / Logseq / Pandoc 扩展)。
// 在 mdast 阶段扫描每个 inline children 数组,把 `^xxx^` / `~xxx~` 配对
// 重写为 superscript / subscript 节点。
//
// 必须在 remarkGfm 之前运行,且 gfm 配 singleTilde:false —— gfm 删除线
// 只匹配双 `~~`,单 `~` 在 parse 阶段保持纯文本,由本插件转下标节点。
//
// word-boundary:
//   `^`: `(?<!\w)` 前非单词 + `([^\n^]+?)` inner 不含 `^`/换行 + `(?!\w)` 后非单词
//   `~`: `(?<![~:/])` 前非 `~`/:`/`/`(单 ~ 防与 `~~` 冲突;`/` 防 URL 误切)
//        + `([^\n~]+?)` inner 不含 `~`/换行
//        + `(?!~)` 后非 `~`(防 `~~`)
//   注意:允许 `H~2~O` 这类单词字符紧邻下标(化学式),故不拒 `\w`。
//
// 嵌套处理:每对处理完后递归进入新生成节点的 children,支持 `^x~y~z^`
// (sup 包 sub)、`~^x^~`(sub 包 sup)。

import { visit } from 'unist-util-visit'
import type { Root, Text, PhrasingContent } from 'mdast'

// `^` 只排除前后紧跟的 `^`(防 `^^` 空匹配),允许单词字符紧邻(支持 `x^2^` 化学式)。
// math 的 `^` 在 `$...$` 内,已被 math_inline 节点吃掉,不会进入文本。
const SUP_RE = /(?<!\^)\^([^\n^]+?)\^(?!\^)/g
const SUB_RE = /(?<![~:/])~([^\n~]+?)~(?!~)/g

type Marker = '^' | '~'

interface Pair {
  re: RegExp
  marker: Marker
  nodeType: 'superscript' | 'subscript'
}

const PAIRS: Pair[] = [
  { re: SUP_RE, marker: '^', nodeType: 'superscript' },
  { re: SUB_RE, marker: '~', nodeType: 'subscript' },
]

type Variant =
  | { kind: 'plain', value: string }
  | { kind: 'pure' }
  | { kind: 'both', content: string }
  | { kind: 'end', prefix: string }
  | { kind: 'start', rest: string }

function classify(v: string, marker: Marker): Variant {
  if (v === marker) return { kind: 'pure' }
  const endsM = v.endsWith(marker)
  const startsM = v.startsWith(marker)
  if (startsM && endsM && v.length >= 4) {
    const inner = v.slice(1, -1)
    return inner.includes(marker) ? { kind: 'plain', value: v } : { kind: 'both', content: inner }
  }
  if (endsM) return { kind: 'end', prefix: v.slice(0, -1) }
  if (startsM && v.length > 1) return { kind: 'start', rest: v.slice(1) }
  return { kind: 'plain', value: v }
}

function isReject(c: string) { return /[~:/]/.test(c) }

function tryInText(v: string, re: RegExp, nodeType: string): { matched: boolean, pieces: PhrasingContent[] } {
  re.lastIndex = 0
  let m: RegExpExecArray | null
  const pieces: PhrasingContent[] = []
  let last = 0
  let hit = false
  while ((m = re.exec(v)) !== null) {
    hit = true
    if (m.index > last) pieces.push({ type: 'text', value: v.slice(last, m.index) })
    pieces.push({ type: nodeType, children: [{ type: 'text', value: m[1] }] } as unknown as PhrasingContent)
    last = m.index + m[0].length
    if (m[0].length === 0) re.lastIndex++
  }
  if (hit && last < v.length) pieces.push({ type: 'text', value: v.slice(last) })
  return { matched: hit, pieces }
}

function rewrite(children: PhrasingContent[]): PhrasingContent[] {
  let out: PhrasingContent[] = children
  for (const { re, marker, nodeType } of PAIRS) {
    const next: PhrasingContent[] = []
    let buf: PhrasingContent[] = []
    let inReg = false
    const flush = () => {
      if (buf.length) next.push({ type: nodeType, children: buf } as unknown as PhrasingContent)
      buf = []; inReg = false
    }
    const unflush = () => { next.push(...buf); buf = []; inReg = false }

    for (const child of out) {
      if (child.type !== 'text') {
        (inReg ? buf : next).push(child)
        continue
      }
      const v = (child as Text).value
      if (!inReg) {
        const t = tryInText(v, re, nodeType)
        if (t.matched) { next.push(...t.pieces); continue }
        const c = classify(v, marker)
        switch (c.kind) {
          case 'plain': next.push(child); break
          case 'pure': inReg = true; buf = []; break
          case 'both':
            if (c.content) next.push({ type: nodeType, children: [{ type: 'text', value: c.content }] } as unknown as PhrasingContent)
            else next.push(child)
            break
          case 'end': {
            if (marker === '~') {
              const lc = c.prefix.length ? c.prefix.charAt(c.prefix.length - 1) : ''
              if (c.prefix && isReject(lc)) { next.push(child); break }
            }
            if (c.prefix) next.push({ type: 'text', value: c.prefix })
            inReg = true; buf = []; break
          }
          case 'start': inReg = true; buf = c.rest ? [{ type: 'text', value: c.rest }] : []; break
        }
      } else {
        const c = classify(v, marker)
        switch (c.kind) {
          case 'plain': buf.push(child); break
          case 'pure': flush(); break
          case 'both': if (c.content) buf.push({ type: 'text', value: c.content }); flush(); break
          case 'end': if (c.prefix) buf.push({ type: 'text', value: c.prefix }); flush(); break
          case 'start': flush(); if (c.rest) next.push({ type: 'text', value: c.rest }); break
        }
      }
    }
    if (inReg) unflush()
    // 递归处理新生成节点的 children,支持嵌套( sup 包 sub / sub 包 sup )
    out = next.map((n: any) => {
      if (n.type === 'superscript' || n.type === 'subscript') {
        return { ...n, children: rewrite(n.children) }
      }
      return n
    })
  }
  return out
}

export function remarkSupSub() {
  return (tree: Root) => {
    visit(tree, (node: any) => {
      if (Array.isArray(node.children)) {
        node.children = rewrite(node.children)
      }
    })
  }
}
