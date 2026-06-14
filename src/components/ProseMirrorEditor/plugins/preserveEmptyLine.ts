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
 */
export function preprocessBlankLines(doc: string): string {
  return doc.replace(/\n\n\n+/g, (match) => {
    const blankLineCount = match.length / 2 - 1
    let result = '\n\n'
    for (let i = 0; i < blankLineCount; i++) {
      result += '<br />\n\n'
    }
    return result
  })
}
