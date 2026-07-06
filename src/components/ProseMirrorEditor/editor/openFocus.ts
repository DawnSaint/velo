import { Selection, TextSelection } from 'prosemirror-state'
import type { Node } from 'prosemirror-model'

/**
 * 文件刚被打开时的完整起点策略 —— 一次性给出 selection + 是否抢焦点,
 * watch 块直接消费。纯函数,无副作用。
 */
export interface OpenFocusPolicy {
  /** 是否调用 view.focus() 把焦点拉进编辑器 */
  readonly shouldFocus: boolean
  /** 文档起点选区 —— 传给 EditorState.create({selection}) 同步设置光标位置。
   *  使用 PM 的 Selection 基类(atStart/atEnd 实际返回 Selection)而非
   *  TextSelection,避免类型不匹配。 */
  readonly selection: Selection
}

/**
 * 规则:
 * - 整个文档只有一个空段落(典型:新建空白文档)→ focus + 选区 atEnd
 *   (用户期望直接开始打字,不需要先去点编辑器)
 * - 否则(任何非空文档,含"非空内容 + 尾空段")→ selection atStart + 不抢焦点:
 *   打开是为了读,不抢焦点避免屏幕顶部高亮选区 / TOC 抢占注意力;且 atEnd 会被
 *   打字机模式居中到视口底部、视口跳末行 —— 早期用"最后一节点是空段落"的宽条件
 *   会把"非空内容 + 尾空段"也判为应 focus,正是打字机开屏跳末行的根因
 *
 * atStart() 落在 PM 首个 leaf 的入口位置(对 `<doc><heading>Title</heading></doc>`
 * 来说是 position 1 = heading 内部、文本前的位置),"位置 0" 在 doc open token 和首
 * 节点之间,selection 不允许落在那里。对用户视觉而言,atStart = "光标在文档开头"。
 *
 * 完整复位视口还需要 caller 显式 `view.dom.scrollTop = 0` —— PM updateState
 * 会尽量保留旧滚动位置(尤其旧文档短、视口足以装下新文档时),即便 selection
 * 已经在首个 leaf,viewport 仍可能停在旧位置。光显式 selection 复位不够。
 */
export function decideOpenFocus(doc: Node): OpenFocusPolicy {
  const last = doc.lastChild
  const isEmptyDoc = doc.childCount === 1
    && last !== null && last.type.name === 'paragraph' && last.textContent === ''
  if (isEmptyDoc) {
    return { shouldFocus: true, selection: TextSelection.atEnd(doc) }
  }
  return { shouldFocus: false, selection: TextSelection.atStart(doc) }
}
