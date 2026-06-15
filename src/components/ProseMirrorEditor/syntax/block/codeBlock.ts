// ` ``` ` 或 ` ```lang ` (段首,触发条件:`)空格 → code_block
//
// 触发时机:段首 ``` 后跟一个空格(可选 language)。空格落下后立即转。
//
// 与 mermaid 分支:lang === 'mermaid' 时由 markdownIO 在外部解析阶段映射到
// mermaid 节点,实时键入触发统一进 code_block(用户后续手动改 lang attribute
// 不在本次范围)。

import { TextSelection } from 'prosemirror-state'
import type { BlockSyntax } from '../../editor/syntaxRegistry'

export const codeBlockSyntax: BlockSyntax = {
  name: 'codeBlock',
  // ``` 或 ```lang 后跟单空格;lang 不允许包含空白和反引号
  pattern: /^```([^\s`]*) /,
  apply(tr, { schema, blockStart, match }) {
    const codeBlockType = schema.nodes.code_block
    if (!codeBlockType) return false

    const $start = tr.doc.resolve(blockStart)
    const parent = $start.parent
    if (parent.type.name !== 'paragraph') return false

    const lang = match[1] || ''
    const prefixLen = match[0].length

    tr.delete(blockStart, blockStart + prefixLen)
    tr.setBlockType(blockStart, blockStart, codeBlockType, { language: lang })

    const newPos = tr.mapping.map(blockStart)
    const sel = tr.selection
    if (sel.from < newPos) {
      tr.setSelection(TextSelection.create(tr.doc, newPos))
    }
    return true
  },
}
