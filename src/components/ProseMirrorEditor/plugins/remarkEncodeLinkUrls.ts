// 拦截 unified parser,把链接 URL 里的内部空格 URL-encode 成 %20。
//
// ## 背景
//
// CommonMark / GFM 规范里 URL 不能含空格 —— 用户写 `[text](url with space)` 时
// remark-parse 直接拒绝解析为链接,整个 `[text](url...)` 留在 doc 里变成普通文本。
// 真实场景里中文 markdown 编辑者经常写 `[回到开头](# Markdown 语法)` 这种
// "看起来是空格但其实是标题文字"的链接,因为他们不知道 heading 实际 slug
// 是 `markdown-语法`(没空格)。本插件在解析前先把 URL 内部空格 encode,
// 让 remark-parse 顺利产 link 节点。跳转时由 linkClick.scrollToAnchor 的
// slug 化降级匹配兜底(见 plugins/linkClick.ts)。
//
// 思路沿用 remarkPreserveEmptyLine —— wrap parser,在调原 parser 前预处理
// 文本。这种"纯文本替换"比写一个完整的自定义 remark inline token 简单得多。
//
// 改写源文本会改变 mdast position.offset 的基准 —— 新增 / 修改本 wrapper 时
// 必须同步 `parseProcessor.preprocessSource`,否则 offset 回查原文时错位。

import type { Processor } from 'unified'

export function remarkEncodeLinkUrls(this: Processor) {
  const originalParser = this?.parser
  if (!originalParser) return
  this.parser = function (doc, file) {
    return originalParser.call(this, encodeLinkUrlSpaces(doc), file)
  }
}

/**
 * 找 `[text](url)` 模式,若 url 内部含空格则 URL-encode;否则原样返回。
 * 纯函数,方便单测。
 *
 * 注意 vs 标准:
 *  - 标准 CommonMark 要求空格必须写 `%20`;这里反过来"自动 encode"是为了 UX
 *    友好。`# Markdown 语法` 解析后 href 是 `#%20Markdown%20语法`,浏览器地址栏
 *    看到的是 `%20`,但 linkClick.scrollToAnchor 走 slug 化降级能跳到正确 heading。
 *  - 只 encode 内部空格;前导/尾部空格不处理(原样交给 remark-parse,
 *    通常意味着 URL 非法,降级为普通文本)。
 */
export function encodeLinkUrlSpaces(doc: string): string {
  return doc.replace(
    /\[([^\]\n]+)\]\(([^()]*)\)/g,
    (match, text: string, url: string) => {
      if (!url.includes(' ')) return match
      if (url.trim() === '') return match
      return `[${text}](${url.replace(/ /g, '%20')})`
    },
  )
}

/**
 * 与 encodeLinkUrlSpaces 输出严格一致，同时产出输出偏移 → 输入偏移映射表
 * （长度 = out.length + 1），供块级原文切片保真回查磁盘坐标。
 */
export function encodeLinkUrlSpacesWithMap(doc: string): { text: string; toRaw: Int32Array } {
  const re = /\[([^\]\n]+)\]\(([^()]*)\)/g
  let out = ''
  const map: number[] = []
  let cursor = 0
  let m: RegExpExecArray | null

  const copyRange = (from: number, to: number) => {
    for (let i = from; i < to; i++) map.push(i)
    out += doc.slice(from, to)
  }

  while ((m = re.exec(doc)) !== null) {
    const text = m[1]
    const url = m[2]
    if (!url.includes(' ') || url.trim() === '') continue
    copyRange(cursor, m.index)
    // `[${text}](` 原样拷贝
    const urlStart = m.index + 1 + text.length + 2
    copyRange(m.index, urlStart)
    for (let k = 0; k < url.length; k++) {
      const srcIdx = urlStart + k
      if (url[k] === ' ') {
        out += '%20'
        map.push(srcIdx, srcIdx, srcIdx)
      }
      else {
        out += url[k]
        map.push(srcIdx)
      }
    }
    // 闭合 `)`
    const closeIdx = urlStart + url.length
    out += ')'
    map.push(closeIdx)
    cursor = closeIdx + 1
  }

  copyRange(cursor, doc.length)
  map.push(doc.length)
  return { text: out, toRaw: Int32Array.from(map) }
}
