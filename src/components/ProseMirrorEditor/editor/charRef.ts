// Markdown 字符实体引用(&#x20; / &#8203; / &nbsp; ...)的保真与源码态支持。
//
// remark-parse 会把字符实体解码进 mdast text.value(实体字面量本身不进 PM doc),
// WYSIWYG 里只剩一个普通空格 / 字符 —— 搜得到源码却定位不到、点开也看不到实体。
// 这里在 parse 阶段用 mdast position 回查原文,把「哪几个解码字符来自哪个实体」
// 记进 PM text 节点的 char_ref mark(attrs.segments),让:
//   - toMarkdown 原样写回实体字面量(不再静默改写成普通空格)
//   - 查找后端能在解码字符上搜到实体字面量(全局搜索点击跳转)
//   - 源码态插件能把解码字符临时换回字面量(Typora 风格,失焦还原)
//
// 对齐失败(改写过的 mdast 节点 / 未知解码差异)一律返回 null 不标注:宁可退化为
// 普通文本,也不能把实体位置标错。

import type { Node as PMNode } from 'prosemirror-model'

export const CHAR_REF_MARK = 'char_ref'

export interface CharRefSegment {
  /** markdown 原文里的实体字面量,如 '&#x20;' */
  raw: string
  /** 解码后的字符,如 ' ' */
  text: string
}

export interface CharRefAt extends CharRefSegment {
  /** 在 mdast text.value(解码串)里的起始下标 */
  at: number
}

/** 实体字面量:数字(十进制 / 十六进制)或命名,必须带分号。与 document.ts 的 CHAR_REF_RE 同口径。 */
const CHAR_REF_TOKEN = /&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);/
export const CHAR_REF_RE = new RegExp(CHAR_REF_TOKEN.source, 'g')

/** CommonMark 可反斜杠转义的 ASCII 标点。 */
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/

function decodeNumeric(raw: string): string | null {
  const m = /^&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));$/.exec(raw)
  if (!m) return null
  const cp = m[1] ? Number.parseInt(m[1], 16) : Number.parseInt(m[2], 10)
  if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return '\uFFFD'
  }
  return String.fromCodePoint(cp)
}

/** 命名实体交给浏览器解码(HTML5 表覆盖 micromark 的 character-entities;
 *  个别不一致由 scanCharRefs 的严格对齐挡掉)。只在主线程 annotate 阶段调用 ——
 *  Worker 只做 parse + runSync,不读实体。无 DOM 环境(纯 Node 脚本)返回原文,
 *  解码串对不上 → scanCharRefs 不标注,不会误标。 */
function decodeNamed(raw: string): string {
  if (typeof document === 'undefined') return raw
  const span = document.createElement('span')
  span.innerHTML = raw
  return span.textContent ?? raw
}

function decodeCharReference(raw: string): string {
  return decodeNumeric(raw) ?? decodeNamed(raw)
}

/**
 * 模拟 remark-parse 对一段 text 原文切片(实体 / 反斜杠转义 / 换行归一化 / NUL)的解码,
 * 返回实体片段及其在解码串中的位置。
 *
 * 解码结果与 mdast 的 node.value 不完全相等时返回 null —— 说明该节点被 remark 插件
 * 重写过或解码规则有差异,此时不标注,避免错位的实体源码态。
 */
export function scanCharRefs(raw: string, decoded: string): CharRefAt[] | null {
  if (!raw.includes('&')) return []
  let out = ''
  const refs: CharRefAt[] = []
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '&') {
      const m = CHAR_REF_TOKEN.exec(raw.slice(i))
      if (m) {
        const text = decodeCharReference(m[0])
        if (text !== m[0]) {
          out += text
          // 解码成换行的实体(&#10; / &#13;)不该塞进 PM text 节点(PM 用 hardbreak)。
          if (!/[\r\n]/.test(text)) refs.push({ at: out.length - text.length, raw: m[0], text })
          i += m[0].length
          continue
        }
      }
    }
    if (ch === '\\' && i + 1 < raw.length && ESCAPABLE.test(raw[i + 1])) {
      out += raw[i + 1]
      i += 2
      continue
    }
    if (ch === '\r') {
      out += '\n'
      i += raw[i + 1] === '\n' ? 2 : 1
      continue
    }
    if (ch === '\u0000') {
      out += '\uFFFD'
      i++
      continue
    }
    out += ch
    i++
  }
  return out === decoded ? refs : null
}

/** 读 PM text 节点上的 char_ref mark。编辑后 segments 与 text 对不上时视为过期,返回 null。 */
export function getCharRefSegments(node: PMNode): CharRefSegment[] | null {
  if (!node.isText || !node.text) return null
  const mark = node.marks.find(m => m.type.name === CHAR_REF_MARK)
  if (!mark) return null
  const segments = mark.attrs.segments as CharRefSegment[] | undefined
  if (!Array.isArray(segments) || segments.length === 0) return null
  if (node.text !== segments.map(s => s.text).join('')) return null
  return segments
}

/** 把 char_ref text 节点展开成 markdown 源码文本(相邻的多个实体拼成一个串)。 */
export function expandCharRefText(segments: CharRefSegment[]): string {
  return segments.map(s => s.raw).join('')
}

/**
 * 展开串下标 → text 节点内(doc 相对)下标。
 * 一个实体字面量的所有字符都落在同一个解码字符上,段末跳到该解码字符之后;
 * 匹配只覆盖字面量一部分时 from/to 会相等,调用方需夹到整个实体区间。
 */
export function buildCharRefIndexMap(segments: CharRefSegment[]): number[] {
  const map: number[] = [0]
  let decoded = 0
  for (const seg of segments) {
    for (let k = 0; k < seg.raw.length; k++) map.push(decoded)
    decoded += seg.text.length
    map[map.length - 1] = decoded
  }
  return map
}
