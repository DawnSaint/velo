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
import remarkMath from 'remark-math'
import { remarkPreserveEmptyLine } from '../plugins/preserveEmptyLine'
import { remarkAlert } from '../plugins/remarkAlert'
import { remarkEncodeLinkUrls } from '../plugins/remarkEncodeLinkUrls'
import { remarkHighlight } from '../plugins/remarkHighlight'
import { remarkUnderline } from '../plugins/remarkUnderline'
import { remarkCjkEmphasis } from '../plugins/remarkCjkEmphasis'
import { remarkSupSub } from '../plugins/remarkSupSub'
import { remarkMathFenceGuard } from '../plugins/remarkMathFenceGuard'
import remarkFrontmatter from 'remark-frontmatter'

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
    .use(remarkMathFenceGuard)
    .use(remarkMath)
    .use(remarkAlert)
    .use(remarkHighlight)
    .use(remarkUnderline)
    .use(remarkCjkEmphasis)
    .use(remarkFrontmatter, ['yaml', 'toml'])
}
