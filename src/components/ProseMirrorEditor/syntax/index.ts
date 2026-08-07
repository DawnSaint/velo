// 语法注册入口 —— EditorInner.vue 一次性 import 这个文件,触发 register 副作用。
//
// 顺序约定:
//  1. block syntaxes 优先级高于 inline(block 命中时整段换 type,inline 不再尝试)
//  2. block 内部按"特异性"排序:更具体的写在前面
//     - heading / codeBlock / hr 互不冲突,顺序无关
//     - bulletList(`- ` / `- [ ] `)/ orderedList(`\d+. `)同上
//     - blockquote(`> `)同上
//  3. inline 按"互不冲突"排序;命中后 break 当前 syntax 循环,其他 syntax
//     仍会在下一轮扫到(框架内 for of inlineSyntaxes 仍会继续)

import { registerBlockSyntax, registerInlineSyntax } from '../editor/syntaxRegistry'

import { headingSyntax } from './block/heading'
import { codeBlockSyntax } from './block/codeBlock'
import { blockquoteSyntax } from './block/blockquote'
import { bulletListSyntax } from './block/bulletList'
import { orderedListSyntax } from './block/orderedList'
import { hrSyntax } from './block/hr'
import { frontmatterSyntax } from './block/frontmatter'
import { tocSyntax } from './block/toc'
import { alertSyntax } from './block/alert'

import { emphasisUnderscoreSyntax } from './inline/emphasis'
import { emphasisStarSyntax } from './inline/emphasisStar'
import { strikeSyntax } from './inline/strike'
import { strongSyntax } from './inline/strong'
import { inlineMathSyntax } from './inline/inlineMath'
import { footnoteRefSyntax } from './inline/footnoteRef'
import { linkSyntax } from './inline/link'
import { highlightSyntax } from './inline/highlight'
import { underlineSyntax } from './inline/underline'
import { supSyntax } from './inline/sup'
import { subSyntax } from './inline/sub'
import { inlineCodeSyntax } from './inline/code'
import { htmlTagSyntax } from './inline/htmlTag'
import { emojiSyntax } from './inline/emoji'

registerBlockSyntax(headingSyntax)
registerBlockSyntax(codeBlockSyntax)
registerBlockSyntax(blockquoteSyntax)
registerBlockSyntax(bulletListSyntax)
registerBlockSyntax(orderedListSyntax)
// frontmatter 必须在 hr 之前:两者 pattern 重叠(---),frontmatter 仅在文档首段
// 触发,hr 在任意位置触发;注册顺序决定优先级
registerBlockSyntax(frontmatterSyntax)
registerBlockSyntax(hrSyntax)
registerBlockSyntax(tocSyntax)
// alert 必须在 blockquote 之后:它依赖 blockquote 已成形,不抢同级触发
registerBlockSyntax(alertSyntax)

registerInlineSyntax(linkSyntax)         // 优先 link,避免 [^id] 误抓 link 模式中的 ]
registerInlineSyntax(footnoteRefSyntax)
registerInlineSyntax(inlineMathSyntax)
// 顺序关键:emphasisStar 在 strong 之前 —— 各自 regex 自带边界,但先跑挑剔的
// (inner 不含 `*`)可避免 strong 已被新 doc 改掉后,emphasisStar 在 stale blockText
// 上又重扫一次(框架注释说外层 for 会继续走下一条 syntax,这是天然行为,顺序
// 只是优化早返回)。strike 之后,emphasisUnderscore 放它后面。highlight 放最末,
// 不抢前面的 link / footnote / math / strike 匹配。
// sub 必须在 strike 之前:`~text~` 优先命中下标(单 ~),`~~text~~` 留给 strike
// (双 ~~)。sub 的正则闭口边界 `(?![\w/~])` 保证 `~~text~~` 不会被 sub 误切。
registerInlineSyntax(emphasisStarSyntax)
registerInlineSyntax(strongSyntax)
registerInlineSyntax(subSyntax)
registerInlineSyntax(strikeSyntax)
registerInlineSyntax(emphasisUnderscoreSyntax)
registerInlineSyntax(highlightSyntax)
// underline 必须在 htmlTag 之前:<u>text</u> 完整闭合时优先转 underline mark,
// 而非 html_inline atom。空 <u></u> 不匹配(快捷键通过 skipSyntaxAutoFormat 防御)
registerInlineSyntax(underlineSyntax)
// sup 必须在 htmlTag 之前,原因同 underline:防被抢转成 html_inline atom
registerInlineSyntax(supSyntax)
// inline code(`` `code` ``):backtick 围栏。独占 mark(excludes:'_'),不与上面 mark
// 抢匹配;放 htmlTag 之前 —— backtick 与 `<...>` 无交集,顺序非关键但保持靠后
registerInlineSyntax(inlineCodeSyntax)
// emoji 短码(`:smile:`):放在 htmlTag 之前,优先转换为 emoji node。
// `:` 不是 HTML 标签字符,不与 htmlTag 冲突。
registerInlineSyntax(emojiSyntax)
// htmlTag 必须注册(否则整条语法静默失效) + 放最后 —— PAIRED / SELF_CLOSE
// 模式只匹配完整闭合的 `<tag>content</tag>` 或 `<tag/>`,不抢 mark 语法的
// 匹配。敲到一半的 `<kbd>` 保留 plain text,源码模式看到的 `\<kbd>` 是
// mdast-util-to-markdown safe() 的合法转义(CommonMark 规范要求),不在
// 编辑器层去对抗 round-trip 完整性
registerInlineSyntax(htmlTagSyntax)
