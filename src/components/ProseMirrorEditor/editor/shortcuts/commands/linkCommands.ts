// 触发 linkClick 编辑态 —— Mod-k 快捷键入口。
//
// 行为:
//   选区非空 → 把选中文本变成 `[text](url)`,光标停在 url 部分
//   选区空   → 插入 `[text](url)`,光标停在 text 部分
//   然后调 setMeta(linkClickPluginKey, { type: 'start', session }) 启动 linkClick
//   的源码编辑态 —— 用户可以编辑源码,光标移出 edit 范围自动 commit
//
// 关键防御:
// - tr 第一步就 setMeta(syntaxAutoFormatPlugin, false)—— 否则 syntaxAutoFormat
//   看到 `[text](url)` 会用 linkSyntax 抢着转 link mark,linkClick 的源码态就废了
// - session.editFrom/editTo 用最终 doc 位置(= 插入前的 from,因为 delete+insert
//   不偏移 from),不靠 mapping 推 —— linkClick.apply 走 'start' meta 分支不进
//   mapping 平移路径

import { TextSelection } from 'prosemirror-state'
import type { ShortcutCommand } from '../registry'
import { linkClickPluginKey } from '../../../plugins/linkClick'
import { syntaxAutoFormatPlugin } from '../../../plugins/syntaxAutoFormat'

export const triggerLinkEdit: ShortcutCommand = (state, dispatch) => {
  const linkMarkType = state.schema.marks.link
  if (!linkMarkType) return false

  const { from, to, empty } = state.selection
  const selText = empty ? '' : state.doc.textBetween(from, to, '\n', '\n')
  const source = selText ? `[${selText}](url)` : '[text](url)'

  if (!dispatch) return true

  let tr = state.tr

  // 关键 #1:屏蔽 syntaxAutoFormat 抢转 link mark(delete/insert 之前 setMeta)
  tr = tr.setMeta(syntaxAutoFormatPlugin, false)

  tr = tr.delete(from, to)
  tr = tr.insertText(source, from)
  // 光标停在 '(' 之后:`[text](` 长度 = selText.length + 3
  const cursorPos = from + 1 + selText.length + 2 // '[' + selText.length + ']('
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos))

  // 关键 #2:session.editFrom/editTo 用最终 doc 位置(linkClick.apply 走 'start'
  // meta 分支不进 mapping 平移,所以必须给绝对位置)
  tr = tr.setMeta(linkClickPluginKey, {
    type: 'start' as const,
    session: {
      editFrom: from,
      editTo: from + source.length,
      href: '',
      originalSource: source,
    },
  })

  dispatch(tr)
  return true
}