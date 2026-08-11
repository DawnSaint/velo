// 拦截 unified parser,把“行首 $$ 后有正文但本行没有闭合 $$”降级为普通文本。
//
// remark-math 的 flow math 允许 `$$meta` 作为块级公式开头,且 EOF 也会闭合公式。
// 中文文档里常见误输入 `$$公式...` 少写结尾 `$$`,会把后续段落都吞进 math_block。
// Velo 约定:块级公式开头行必须只有 `$$`;同一行 `$$...$$` 仍按行内公式解析。

export const remarkMathFenceGuard = function(this: any) {
  const self = this as any
  const originalParser = self?.parser
  if (!originalParser) return
  self.parser = function(this: any, doc: string) {
    return originalParser.call(this, escapeUnclosedMathFenceOpeners(doc))
  }
}

function escapeUnclosedMathFenceOpeners(doc: string): string {
  return doc.replace(/^( {0,3})\$\$(?=\S|[ \t]+\S)([^\n\r]*)/gm, (line, indent: string, rest: string) => {
    if (rest.includes('$$')) return line
    return `${indent}\\$\\$${rest}`
  })
}
