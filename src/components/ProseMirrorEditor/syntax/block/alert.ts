// blockquote 内段首 `[!TYPE]` + Enter → 转 alert 节点
//
// 触发时机:用户敲完 `> [!NOTE]` 然后按 Enter。Enter 之后 blockquote 里有
// 至少 2 个段落(marker 段 + Enter 后的新段),框架的 dirty-range 扫到 marker
// 段(它仍是 paragraph,内容刚好等于 `[!NOTE]`),命中此规则。
//
// 为什么要等 Enter 之后才转:
//  - 用户可能继续在 marker 段里改内容(`> [!NOT` ...还在敲),提前转 alert
//    会打断键入 + 把光标抢到不存在的位置
//  - Enter 是用户"敲完了 marker、要写正文"的明确信号
//
// 不触发的情况:
//  - 父节点不是 blockquote → 这是普通段落,不该当 alert 头
//  - blockquote 只有 1 段(marker 段)→ 用户还没按 Enter,等等
//  - 父节点已经是 alert → 不重复转
//
// 文件加载路径:
//  - markdownIO 走 remarkAlert,加载阶段就把 `> [!NOTE]\n> body` 直接转 alert
//  - 这条规则只覆盖"用户在编辑器里手敲"的实时路径
//
// variant 与 schema.alert.attrs.variant / remarkAlert / markdownIO 对齐:
//  - 5 种:note / tip / important / warning / caution(GFM 标准全大写,我们落小写)

import { Fragment } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'
import type { BlockSyntax } from '../../editor/syntaxRegistry'

const ALERT_VARIANTS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']
// 段内整段刚好是 `[!NOTE]` —— 末尾 $ 锚定,不接其他字符
// i flag:大小写不敏感,与 markdownIO 的 remarkAlert 对齐(用户敲小写也转)
const ALERT_PATTERN = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i

export const alertSyntax: BlockSyntax = {
  name: 'alert',
  pattern: ALERT_PATTERN,
  apply(tr, { schema, blockStart, match }) {
    void ALERT_VARIANTS // 类型 hint,运行时不需要
    const alertType = schema.nodes.alert
    const paragraphType = schema.nodes.paragraph
    const blockquoteType = schema.nodes.blockquote
    if (!alertType || !paragraphType || !blockquoteType) return false

    const variant = match[1].toLowerCase()
    // 防御:变体必须在白名单内(防 i flag 引入意外匹配)
    if (!ALERT_VARIANTS.includes(variant.toUpperCase())) return false

    // 段落必须是 paragraph,且其父是 blockquote(不能是顶层段或 alert / list_item 等)
    const $start = tr.doc.resolve(blockStart)
    if ($start.parent.type.name !== 'paragraph') return false
    if ($start.depth < 2) return false
    const grandparent = $start.node($start.depth - 1)
    if (grandparent.type !== blockquoteType) return false

    // blockquote 必须有 ≥ 2 段(用户已按过 Enter)
    if (grandparent.childCount < 2) return false

    // 取整个 blockquote 的位置范围,准备替换
    const blockquoteStart = $start.before($start.depth - 1)
    const blockquoteEnd = $start.after($start.depth - 1)

    // 新 alert content = 原 blockquote 的 children 去掉首段(marker 段)
    const restChildren: import('prosemirror-model').Node[] = []
    grandparent.forEach((child, _offset, i) => {
      if (i === 0) return
      restChildren.push(child)
    })
    // alert schema 要求 'block+',至少 1 个 block;若用户 Enter 后没写内容,
    // 第二段就是空 paragraph,刚好够数,不需要兜底
    if (restChildren.length === 0) return false

    const newAlert = alertType.create({ variant }, Fragment.from(restChildren))

    tr.replaceRangeWith(blockquoteStart, blockquoteEnd, newAlert)

    // 光标落到 alert 内第一段起点(alert.open + paragraph.open = +2)
    const cursorPos = blockquoteStart + 2
    const safe = Math.min(cursorPos, tr.doc.content.size)
    tr.setSelection(TextSelection.create(tr.doc, safe))
    return true
  },
}
