import { $remark } from '@milkdown/kit/utils'
import type { MilkdownPlugin } from '@milkdown/ctx'

/**
 * 拦截 unified parser,把多空行转换成 `<br />` 块,让 remark-parse 看到空段落占位。
 *
 * ## 背景
 *
 * CommonMark 规范本身把连续空行折叠成单个 block 分隔符 —— 源里 2 个空行经
 * remark-parse 解析后,AST 里中间没有 `paragraph("")`,只有紧邻的两个 block。
 * 给 `.milkdown-editor p` 加 `min-height` 救不了,因为 AST 里就没那个节点。
 *
 * ## 思路
 *
 * parser 拦截 → 把"超出 1 个 block 分隔符"的部分替换成"`<br />\n\n`"重复出现,
 * 每多 1 个空行多 1 个 `<br />` 块。remark-parse 看到这些块会包成 inline html
 * 段落(因为 `<br />` 是 Type 7 HTML 不能打断段落),再由上游
 * `remarkPreserveEmptyLinePlugin` 的 `visitEmptyLine` 把 `<br />` 从段落里抽掉,
 * 留下真正的空 paragraph。整个链路是闭环的:
 *
 * ```
 *   源:      para1\n\n\npara2                     (1 个空行)
 *   pre:     para1\n\n<br />\n\npara2            (1 个 <br /> 块)
 *   parse:   [p("para1"), p([html(<br />)]), p("para2")]
 *   visit:   [p("para1"), p(""),           p("para2")]   ← 中间多出空段落
 *   序列化:   para1\n\n<br />\n\npara2         (toMarkdown 同款)
 *   再 pre:  无变化
 *   再 parse: 又是空段落 ...
 * ```
 *
 * ## 加在哪
 *
 * 必须在 `safeCommonmark` **之后** `.use()`,因为:
 * - safeCommonmark 里的 remark-parse 是把 `this.parser` 设成自己的 parser
 * - 我们要在这个基础上做拦截,得等 remark-parse 先把 parser 装好
 * - 加在前面会被 remark-parse 直接覆盖掉
 */
function remarkPreserveEmptyLinePreprocess() {
  return function plugin(this: any) {
    const originalParser = this.parser
    if (!originalParser) return
    this.parser = function(this: any, doc: string) {
      return originalParser.call(this, preprocessBlankLines(doc))
    }
  }
}

/**
 * 把多空行转成 `<br />\n\n` 重复,每个多出来的空行多 1 个 `<br />` 块。
 * 纯函数,方便单测。
 */
export function preprocessBlankLines(doc: string): string {
  return doc.replace(/\n\n\n+/g, (match) => {
    const blankLineCount = match.length - 2
    let result = '\n\n'
    for (let i = 0; i < blankLineCount; i++) {
      result += '<br />\n\n'
    }
    return result
  })
}

export const preserveEmptyLinePlugin: MilkdownPlugin[] = [
  $remark('remark-preserve-empty-line-preprocess', () => remarkPreserveEmptyLinePreprocess()),
].flat()
