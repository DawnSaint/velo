// `# ` ~ `###### ` → heading
//
// 触发时机:段首 1~6 个 `#` + 单空格(空格落下后立即转)。
//
// 实现思路:
//  1. 段首文本匹配 `/^(#{1,6}) /`,捕获 # 数量决定 level
//  2. tr.delete 删掉 `### ` 前缀
//  3. tr.setBlockType 把当前段从 paragraph 转为 heading
//
// 已知边界:
//  - 用户在 list_item 内段首敲 `### ` 也会触发(嵌套 heading 在列表里);
//    schema 允许,markdown round-trip 正常。
//  - paragraph 内若已有 inline 内容(如 `# foo`),level=1 + 内容 "foo" 一并保留。

import { TextSelection } from 'prosemirror-state'
import type { BlockSyntax } from '../../editor/syntaxRegistry'

export const headingSyntax: BlockSyntax = {
  name: 'heading',
  pattern: /^(#{1,6}) /,
  apply(tr, { schema, blockStart, match }) {
    const headingType = schema.nodes.heading
    if (!headingType) return false
    const level = match[1].length
    const prefixLen = match[0].length

    // 当前段落必须是 paragraph(避免在已是 heading 的段落里再触发)
    const $start = tr.doc.resolve(blockStart)
    const parent = $start.parent
    if (parent.type.name !== 'paragraph') return false

    tr.delete(blockStart, blockStart + prefixLen)
    tr.setBlockType(blockStart, blockStart, headingType, { level })

    // 光标本来就在 prefix 之后;delete 后 prefix 之后的内容左移到 blockStart,
    // selection 由 tr.mapping 自动平移,不用手动调
    // 但若用户当前 selection 落在被删除的 prefix 内,补一下:
    const sel = tr.selection
    if (sel.from < blockStart) {
      tr.setSelection(TextSelection.create(tr.doc, blockStart))
    }
    return true
  },
}
