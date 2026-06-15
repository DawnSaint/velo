// `---` / `***` / `___`(单独行)→ thematic break (hr)
//
// 触发时机:段落内容**完全等于** 3+ 个 - / * / _,且段后回车(段落必须为
// 空 paragraph 形态前置,但用户实际操作流程是:段首敲 --- 然后空格 / 回车)。
//
// 行为简化:
//  - 我们只接 `---`(3 个)/ `***` / `___`,不强制 3+ —— 与 GFM 一致允许 3+
//  - 触发前提:段内**仅**这串 + 末尾一个空格(否则看起来仍是用户在敲 ---xxx)
//  - 转换后 hr 占一段,光标落到下一段

import { TextSelection } from 'prosemirror-state'
import type { BlockSyntax } from '../../editor/syntaxRegistry'

export const hrSyntax: BlockSyntax = {
  name: 'hr',
  // 段内整段是 3+ 同字符 + 末尾空格,空格触发(对齐其他块级语法的"空格触发"约定)
  pattern: /^(?:-{3,}|_{3,}|\*{3,}) $/,
  apply(tr, { schema, blockStart, blockEnd }) {
    const hrType = schema.nodes.hr
    if (!hrType) return false

    const $start = tr.doc.resolve(blockStart)
    const parent = $start.parent
    if (parent.type.name !== 'paragraph') return false

    // pattern 确保整段就是 `---  ` 这种,直接把整段替换为 hr 节点
    // 段落 open/close tag 之外的位置:blockStart - 1 / blockEnd + 1
    const paraOuterStart = blockStart - 1
    const paraOuterEnd = blockEnd + 1

    tr.replaceRangeWith(paraOuterStart, paraOuterEnd, hrType.create())

    // hr 后面通常已经有下一段;若无,补一个 paragraph 让光标有处可去
    const after = tr.mapping.map(paraOuterEnd)
    if (after >= tr.doc.content.size) {
      const paragraphType = schema.nodes.paragraph
      tr.insert(after, paragraphType.create())
    }
    // 光标移到 hr 之后的段落起点
    const cursorPos = tr.mapping.map(paraOuterEnd) + 1
    const safe = Math.min(cursorPos, tr.doc.content.size)
    tr.setSelection(TextSelection.create(tr.doc, safe))
    return true
  },
}
