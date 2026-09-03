/**
 * 拦截 unified parser,把多空行转换成 `<br />` 块,让 remark-parse 看到空段落占位。
 *
 * ## 背景
 *
 * CommonMark 规范本身把连续空行折叠成单个 block 分隔符 —— 源里 2 个空行经
 * remark-parse 解析后,AST 里中间没有 `paragraph("")`,只有紧邻的两个 block。
 * 给编辑器里的 p 加 `min-height` 救不了,因为 AST 里就没那个节点。
 *
 * ## 思路
 *
 * parser 拦截 → 把"超出 1 个 block 分隔符"的部分替换成"`<br />\n\n`"重复出现,
 * 每多 1 个空行多 1 个 `<br />` 块。remark-parse 看到这些块会包成 inline html
 * 段落(因为 `<br />` 是 Type 7 HTML 不能打断段落),由 visit 阶段把 `<br />`
 * 从段落里抽掉,留下真正的空 paragraph。
 *
 * ## 在新架构里怎么用
 *
 * 这是一个 unified 插件 —— `markdownIO.ts` 里 `.use(remarkPreserveEmptyLine)`。
 * 必须挂在 `remarkParse` **之后**,这样它拦得到 `this.parser`。
 *
 * 改写源文本会改变 mdast position.offset 的基准 —— 新增 / 修改本 wrapper 时
 * 必须同步 `parseProcessor.preprocessSource`,否则 offset 回查原文时错位。
 */
export const remarkPreserveEmptyLine = function(this: any) {
  const self = this as any
  const originalParser = self?.parser
  if (!originalParser) return
  self.parser = function(this: any, doc: string) {
    return originalParser.call(this, preprocessBlankLines(doc))
  }
}

/**
 * 把多空行转成 `<br />\n\n` 重复,每个多出来的空行多 1 个 `<br />` 块。
 * 纯函数,方便单测。
 *
 * ## 行尾规范化
 *
 * 先把 CRLF(`\r\n`)和 单独 CR(`\r`,老 Mac 风格)统一成 LF,再处理多空行。
 * 原因:Windows / 网络盘 / 旧 git 配置可能让磁盘文件是 CRLF,`\r` 夹在两个
 * `\n` 中间会让下方 `\n\n\n+` 匹配不到。所有 md → doc 路径都过
 * remarkPreserveEmptyLine,所以这里加一行覆盖所有调用入口
 * (fromMarkdown 初始装载 / linkClick 提交时 inline 重解析 / 任何未来
 * `fromMarkdown` 的调用方)。
 *
 * ## 逐字区保护
 *
 * 注入只发生在"空行是 block 分隔符"的位置。代码块 / 数学块 / frontmatter /
 * 缩进代码 / 原始 HTML 块里的空行是**内容** —— 在那里注入会把 `<br />` 当成
 * 代码内容写回源码,再 round-trip 回磁盘即永久污染。见 findVerbatimRanges。
 */
export function preprocessBlankLines(doc: string): string {
  const text = doc.replace(/\r\n?/g, '\n')
  const ranges = findVerbatimRanges(text)
  if (ranges.length === 0) return replaceBlankRuns(text)

  let out = ''
  let cursor = 0
  for (const range of ranges) {
    out += replaceBlankRuns(text.slice(cursor, range.start))
    out += text.slice(range.start, range.end)
    cursor = range.end
  }
  return out + replaceBlankRuns(text.slice(cursor))
}

function replaceBlankRuns(text: string): string {
  return text.replace(/\n\n\n+/g, (run) => {
    const count = Math.ceil(run.length / 2 - 1)
    let result = '\n\n'
    for (let i = 0; i < count; i++) {
      result += '<br />\n\n'
    }
    return result
  })
}

// ============================================================
//  逐字区扫描
// ============================================================
// 预处理发生在 remark-parse 之前 —— 此时没有 AST 可用,只能自己按行扫一遍,
// 找出"空行是内容"的区间。区间一律以块最后一行的行尾(不含换行)收口:这样
// 块尾的换行留在区间外,后续的空行仍是 block 分隔符;而块内的空行整段落在
// 区间内。两侧都不会出现跨边界的 `\n` 连续段,slicing 才安全。

interface VerbatimRange {
  start: number
  end: number
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const MATH_FENCE_RE = /^ {0,3}\$\$[ \t]*$/
const FRONTMATTER_FENCE_RE = /^ {0,3}(-{3}|\+{3})[ \t]*$/
const INDENTED_RE = /^(?: {4}|\t)/
const RAW_HTML_RE = /^ {0,3}<(pre|script|style|textarea)(?=[\s>]|$)/i
const HTML_COMMENT_RE = /^ {0,3}<!--/
// ATX 标题 / 分割线同样终结段落,紧随其后的 4 空格行是缩进代码块而不是
// lazy continuation —— 与闭合的逐字块同属"块边界"。
const BLOCK_BOUNDARY_RE = /^ {0,3}(?:#{1,6}[ \t]|([-*_])(?:[ \t]*\1){2,}[ \t]*$)/

type BlockMode = 'none' | 'fence' | 'math' | 'html'

function findVerbatimRanges(text: string): VerbatimRange[] {
  const lines = text.split('\n')
  const starts = new Array<number>(lines.length)
  for (let k = 0, offset = 0; k < lines.length; k++) {
    starts[k] = offset
    offset += lines[k].length + 1
  }

  const ranges: VerbatimRange[] = []
  const push = (start: number, end: number) => {
    if (end > start) ranges.push({ start, end })
  }

  let i = 0
  // frontmatter 只在文档开头,闭合行与开启行同型(--- / +++)
  const fmOpen = lines[0] !== undefined ? FRONTMATTER_FENCE_RE.exec(lines[0]) : null
  if (fmOpen) {
    for (let j = 1; j < lines.length; j++) {
      const fmClose = FRONTMATTER_FENCE_RE.exec(lines[j])
      if (fmClose && fmClose[1][0] === fmOpen[1][0]) {
        push(0, starts[j] + lines[j].length)
        i = j + 1
        break
      }
    }
  }

  let mode: BlockMode = 'none'
  let blockStart = -1
  let fenceChar = ''
  let fenceLen = 0
  let rawHtmlEnd = ''
  let indentedStart = -1
  let indentedEnd = -1
  // 缩进代码块不能打断段落:只有前一个非空行是空行 / 块边界时,4 空格 / tab 行
  // 才算块开始,否则它是段落的 lazy continuation(空行照样是分隔符)。
  let afterBlank = true

  for (; i < lines.length; i++) {
    const line = lines[i]
    const lineEnd = starts[i] + line.length
    const blank = line.trim() === ''
    let closedBlock = false

    if (mode === 'fence') {
      const fence = FENCE_RE.exec(line)
      if (fence && fence[1][0] === fenceChar && fence[1].length >= fenceLen && !fence[2].trim()) {
        push(blockStart, lineEnd)
        blockStart = -1
        mode = 'none'
        closedBlock = true
      }
    } else if (mode === 'math') {
      if (MATH_FENCE_RE.test(line)) {
        push(blockStart, lineEnd)
        blockStart = -1
        mode = 'none'
        closedBlock = true
      }
    } else if (mode === 'html') {
      if (line.toLowerCase().includes(rawHtmlEnd)) {
        push(blockStart, lineEnd)
        blockStart = -1
        mode = 'none'
        closedBlock = true
      }
    } else if (blank) {
      // 空行:夹在缩进块中间时归块内(不 push),否则是分隔符,不保护
    } else if (INDENTED_RE.test(line) && (indentedStart >= 0 || afterBlank)) {
      if (indentedStart < 0) indentedStart = starts[i]
      indentedEnd = lineEnd
    } else {
      if (indentedStart >= 0) {
        push(indentedStart, indentedEnd)
        indentedStart = -1
      }
      const fence = FENCE_RE.exec(line)
      const rawHtml = RAW_HTML_RE.exec(line)
      if (fence && (fence[1][0] === '~' || !fence[2].includes('`'))) {
        mode = 'fence'
        fenceChar = fence[1][0]
        fenceLen = fence[1].length
        blockStart = starts[i]
      } else if (MATH_FENCE_RE.test(line)) {
        mode = 'math'
        blockStart = starts[i]
      } else if (rawHtml) {
        mode = 'html'
        rawHtmlEnd = `</${rawHtml[1].toLowerCase()}`
        blockStart = starts[i]
      } else if (HTML_COMMENT_RE.test(line)) {
        mode = 'html'
        rawHtmlEnd = '-->'
        blockStart = starts[i]
      }
    }

    afterBlank = blank || closedBlock || BLOCK_BOUNDARY_RE.test(line)
  }

  const lastLineEnd = starts[lines.length - 1] + lines[lines.length - 1].length
  if (blockStart >= 0) push(blockStart, lastLineEnd)
  if (indentedStart >= 0) push(indentedStart, indentedEnd)

  return ranges
}
