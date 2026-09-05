// 自写的严格 math 扩展(替换 remark-math)。
//
// ## 为什么不用 remark-math
//
// remark-math v6 只有一个配置项 `singleDollarTextMath`,**没有任何"必须闭合 /
// 非贪婪"的开关**。它的 micromark 层在撞到 EOF 时判定围栏已闭合,且内容里的空行
// 合法,于是未闭合的 `$$` 会一路贪婪匹配到文档里下一个 `$$` 行,把中间所有内容
// 吞进 math_block —— 真实数据损坏。详见 `./mathFlow.ts` 的注释。
//
// ## 本扩展做的事
//
// 1. **解析**:用严格版 tokenizer(见 `./mathFlow.ts`),块级围栏必须同时匹配到
//    独占一行的闭合 `$$` 才算公式;未闭合 / 遇空行 → 开围栏当普通文本。
// 2. **AST**:token 类型与上游完全一致,直接复用 mdast-util-math 的
//    `mathFromMarkdown()`。
// 3. **序列化**:复用 `mathToMarkdown()` 的 handlers,但**剔除 `$` 的 unsafe 规则**。
//
// ## 为什么可以去掉 `$` 转义
//
// mdast-util-math 会注册两条 unsafe:
//
//   ```js
//   {character: '$', after: single ? undefined : '\\$', inConstruct: 'phrasing'}
//   {atBreak: true, character: '$', after: '\\$'}
//   ```
//
// 第二条让段落里"行首的 `$`"一律转义成 `\$` —— 这正是残缺公式块降级成段落后
// 在源码里看到的 `\$\$`。
//
// 上游必须转义,是因为**未转义的 `$$` 行会被贪婪解析成开围栏并吞掉后文**。
// 本扩展的严格 tokenizer 已经杜绝了吞并:单个段落内的 `$$` 找不到闭合行就只是
// 普通文本,所以 `$` 转义不再是必需的安全措施,可以安全移除。
//
// 注意:`\` 的转义**不能**去掉。`xxx \\` 是 LaTeX 换行,落到段落文本里按
// CommonMark 必须写成 `xxx \\\\`,否则重读时 `\\` 会被解成单个 `\`,内容真的会变。

import { codes } from 'micromark-util-symbol'
import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math'
import { strictMathFlow } from './mathFlow'
import { strictMathText } from './mathText'

/** micromark 层:flow 用严格版,text 用与上游一致的行内实现。 */
function strictMathSyntax(options?: { singleDollarTextMath?: boolean | null }): any {
  return {
    flow: { [codes.dollarSign]: strictMathFlow },
    text: { [codes.dollarSign]: strictMathText(options) },
  }
}

/**
 * mdast-util-to-markdown 扩展:保留上游 handlers,剔除 `$` 转义规则。
 *
 * 只过滤 `character === '$'` 的条目,`\r` / `\n` 在 mathFlowMeta 里的规则保留。
 */
function strictMathToMarkdown(options?: { singleDollarTextMath?: boolean | null }): any {
  const base: any = mathToMarkdown(options || {})
  const unsafe: any[] = Array.isArray(base.unsafe) ? base.unsafe : []
  return {
    ...base,
    unsafe: unsafe.filter((pattern: any) => pattern.character !== '$'),
  }
}

/**
 * unified / remark 插件。用法与 `remarkMath` 完全一致:
 *
 *   ```ts
 *   unified().use(remarkParse).use(remarkStrictMath).use(remarkStringify)
 *   ```
 */
export const remarkStrictMath = function (this: any, options?: any) {
  const data = this.data()

  add('micromarkExtensions', strictMathSyntax(options))
  add('fromMarkdownExtensions', mathFromMarkdown())
  add('toMarkdownExtensions', strictMathToMarkdown(options))

  function add(field: string, value: any) {
    const list = data[field] ? data[field] : (data[field] = [])
    list.push(value)
  }
}
