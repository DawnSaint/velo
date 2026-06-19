// `[TOC]` 独占段落 → toc 节点
//
// 触发时机:用户敲完 `[TOC]`(闭合 ] 后立即匹配,pattern 末尾 `$` 锚定)。
// 用户在段落里敲 `[TOC]` 几个字符的过程,只有最后 `]` 落下那一下整个段落
// 内容刚好等于 `[TOC]`(或首尾带空白),命中此规则。
//
// 不触发的情况:
//  - 段落内容不是纯 `[TOC]` → 正文含 [TOC] 不转换
//  - 父节点已是 toc → 不重复转
//  - 文件加载路径:markdownIO 的 fromMarkdown 直接识别 paragraph(text=[TOC]),
//    不走这条实时规则

import type { BlockSyntax } from '../../editor/syntaxRegistry'

const TOC_PATTERN = /^\[TOC\]\s*$/

export const tocSyntax: BlockSyntax = {
  name: 'toc',
  pattern: TOC_PATTERN,
  apply(tr, { schema, blockStart }) {
    const tocType = schema.nodes.toc
    if (!tocType) return false

    // 当前段落必须是 paragraph(任何层级都可以,toc 节点本身无 content 限制)
    const $start = tr.doc.resolve(blockStart)
    if ($start.parent.type.name !== 'paragraph') return false

    // toc 节点 content: ''(无内容),不是 textblock,setBlockType 会拒绝。
    // 用 replaceRangeWith 直接替换整段(同 alertSyntax 的做法)。
    const paraStart = $start.start()
    const paraEnd = $start.end()
    const tocNode = tocType.create(null)
    tr.replaceRangeWith(paraStart, paraEnd, tocNode)
    return true
  },
}
