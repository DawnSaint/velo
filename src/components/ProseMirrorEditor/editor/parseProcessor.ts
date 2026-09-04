// 共享的 parse-only unified processor 配置。
//
// 被 markdownIO.ts（主线程，追加 remarkStringify）和 markdownWorker.ts（Worker，
// 只做 parse + runSync）共同引用，确保两边的 parse 管线配置完全一致。
//
// 不包含 remarkStringify —— stringify 配置（handlers / options）只在主线程需要，
// Worker 只负责 parse + runSync 产出 mdast JSON。

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { remarkStrictMath } from '../plugins/strictMath'
import { remarkPreserveEmptyLine, preprocessBlankLines } from '../plugins/preserveEmptyLine'
import { remarkAlert } from '../plugins/remarkAlert'
import { remarkEncodeLinkUrls, encodeLinkUrlSpaces } from '../plugins/remarkEncodeLinkUrls'
import { remarkHighlight } from '../plugins/remarkHighlight'
import { remarkUnderline } from '../plugins/remarkUnderline'
import { remarkCjkEmphasis } from '../plugins/remarkCjkEmphasis'
import { remarkSupSub } from '../plugins/remarkSupSub'
import { remarkEmoji } from '../plugins/remarkEmoji'
import remarkFrontmatter from 'remark-frontmatter'

/**
 * md → remark-parse 实际看到的字符串。
 *
 * 链上有两个 parser wrapper 会在调 remark-parse 前改写源文本：
 * remarkEncodeLinkUrls(URL 空格 → %20)和 remarkPreserveEmptyLine(多空行 →
 * `<br />` 块)。mdast 的 position.offset 是相对**改写后**字符串的，
 * markdownIO 的 annotateEmphasisMarker / annotateMathDelimiterCount 要用
 * offset 回查源文本，必须喂这份字符串 —— 否则 offset 与源文本错位，
 * emphasis/strong 的 `*`/`_` marker 与数学分隔符数量会识别错。
 *
 * 顺序按 wrapper 的嵌套：encodeLinkUrlSpaces 挂在外层，先跑。
 * 两个改写都不动换行，彼此顺序不影响结果。
 *
 * 新增 / 修改任何改写源文本的 parser wrapper，必须同步此函数。
 */
export function preprocessSource(md: string): string {
  return preprocessBlankLines(encodeLinkUrlSpaces(md))
}

/**
 * 创建 parse-only unified processor（不含 remarkStringify）。
 *
 * 插件顺序与 markdownIO.ts 原有 processor 的 parse 部分完全一致。
 * 修改插件链时必须同步此处，否则 Worker parse 结果与主线程不一致 → round-trip 断裂。
 */
export function createParseProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkPreserveEmptyLine)
    .use(remarkEncodeLinkUrls)
    // remarkGfm 配 singleTilde:false —— gfm 删除线只匹配双 `~~`,单 `~` 留作下标。
    .use(remarkSupSub)
    .use(remarkGfm, { singleTilde: false })
    // 严格版要求块级围栏必须有独占一行的闭合 `$$`,否则开围栏当普通文本。
    // 同时它不再注册 `$` 的 unsafe 规则,段落里的 `$` 不会被转义成 `\$`
    // (因为严格解析下裸 `$` 已经不会造成吞并,转义不再是必需的安全措施)。
    .use(remarkStrictMath)
    .use(remarkAlert)
    .use(remarkHighlight)
    .use(remarkUnderline)
    .use(remarkCjkEmphasis)
    .use(remarkEmoji)
    .use(remarkFrontmatter, ['yaml', 'toml'])
}
