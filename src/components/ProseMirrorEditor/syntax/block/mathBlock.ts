// 段落中的 `$$\n...\n$$`（含 hard_break）→ math_block 节点
//
// 触发时机:用户在段落里逐字符输入 `$$`，Shift-Enter / 粘贴产生 hard_break，
// 输入内容，再输入尾部 `$$` —— 最后一个 `$` 落下时整段文本恰好匹配
// `$$\n...\n$$`，此时把整个 paragraph 替换成 math_block 节点。
//
// 与 dollarEnterCmd（Enter 键触发）的区别:
//   dollarEnterCmd 只认段首恰好 `$$` + Enter，创建空 math_block。
//   本 syntax 处理"段落里直接出现完整 `$$...$$` 围栏"的场景，
//   包括用户逐字符输入、粘贴含 `$$` 围栏的文本等。
//
// pattern 必须匹配完整段落（带 `$` 锚定末尾），否则 `$$\nxxx` 这种
// 未闭合的中间态会误触发。`[\s\S]*` 允许中间含空行（空 content）。

import { TextSelection } from 'prosemirror-state'
import type { BlockSyntax } from '../../editor/syntaxRegistry'

// 首行 2+ 个 `$`，末行 2+ 个 `$`，中间任意内容（含空）。
// 与 MathNodeViews 的 MATH_BLOCK_RE 一致，确保转换后不会被降级 appendTransaction 回退。
const MATH_BLOCK_SYNTAX_RE = /^\${2,}\n[\s\S]*\n\${2,}$/

export const mathBlockSyntax: BlockSyntax = {
  name: 'mathBlock',
  pattern: MATH_BLOCK_SYNTAX_RE,
  apply(tr, { schema, blockStart, blockEnd }) {
    const mathBlockType = schema.nodes.math_block
    if (!mathBlockType) return false

    const $start = tr.doc.resolve(blockStart)
    const parent = $start.parent
    if (parent.type.name !== 'paragraph') return false

    // 段落纯文本（hard_break 被 textBetween 转成 \n）
    const text = tr.doc.textBetween(blockStart, blockEnd, '\n', '\n')
    if (!MATH_BLOCK_SYNTAX_RE.test(text)) return false

    // 用原始文本（含 `$$` 分隔符）作为 math_block content
    const mathBlockNode = mathBlockType.create(null, schema.text(text))

    const paraOuterStart = blockStart - 1
    const paraOuterEnd = blockEnd + 1
    tr.replaceRangeWith(paraOuterStart, paraOuterEnd, mathBlockNode)

    // 光标放到 math_block 内末尾 $$ 之前（用户接着内容继续输入）。
    // NodeView 初始化时 syncMode 会检测光标在节点内 → 自动切 edit 态。
    const nodeStart = tr.mapping.map(paraOuterStart)
    const trailing = (text.match(/\$+$/) || [''])[0].length
    const cursor = Math.max(nodeStart + 1, nodeStart + 1 + text.length - trailing)
    tr.setSelection(TextSelection.create(tr.doc, cursor))
    return true
  },
}
