// `$x$` → math_inline 节点
//
// 迁自 EditorInner.vue 的 inlineMathInputRule:
//   原 `\$([^$\n]+)\$$` —— 末尾紧贴触发
//   去 `$` + 加 `g`,语义不变(段落内任意位置 `$x$` 都转)
//
// 注意:remark-math / markdownIO 走的是**外部 markdown 解析**;EditorView
// 实时键入不经过 unified,必须靠 syntax framework 显式转换。
//
// B1 范式(2026-06-30):math_inline 节点的 text content **含 `$` 分隔符** ——
// match[0](`$x^2$` 整体)作为 content,而非 match[1](inner `x^2`)。
// 这样 `$` 由 PM 通过 contentDOM 直接管理,用户可编辑分隔符;删掉一个 `$` 后
// content 不再匹配 `$...$`,由 mathInlineUnwrapPlugin 降级为普通文本。
// `$$x^2$$` 同理(content = `$$x^2$$`),仍是行内公式 —— 块级只认两行独立 `$$`。
//
// **重要:正则必须用捕获组捕获 `+` 而非字面 `$+`** —— 否则对 `$$x$$` 会
// 退化成 index 1 处的 `$x$` 匹配,把首尾两个 `$` 留在段落里成普通文本。
// 之前用 `\$([^$\n]+)\$` 已经"幸运地"在 $$x$$ 上能匹配,但前提是 capture 长度
// 1 = match[0] 长度的"中间非空部分",对 `$$` 退化见下:
//   re.exec("$$x$$") 在 index 0 处 `$` + `$x`? `[^$\n]+` 不允许 $,直接 fail;
//   index 1 处 `$` + `x` + `$` 命中,match[0] = "$x$" (只 3 字符) →
//   前后各一个 $ 留下,变成 "$ + math + $" 的视觉 bug。
// 新正则 `(\$\$?)([^$\n]+)\1`(对称反向引用)保证首尾 $ 数量一致(1 或 2),
// `$$x$$` 整段 5 字符完整被吞下,不留尾巴。
//
// **负向后行断言 `(?<!\$)`(2026-07-01)**:逐字符输入 `$$x$$` 时存在中间态
// `$$x$`,此时正则会从 index 1 处匹配 `$x$`(反向引用 1 个 $),把 `$x$` 转成
// math_inline,留下前导 `$` 成普通文本 → 用户看到「$ + katex」,序列化后变
// `\$$x$`。加 `(?<!\$)` 确保匹配起点前一个字符不是 `$`,中间态 `$$x$` 从
// index 1 起的 `$x$` 前面是 `$` → 断言失败不匹配;等用户输完 `$$x$$`,从
// index 0 起的 `$$x$$` 前面无 `$`(或非 `$`)→ 断言通过,正确转换。

import { TextSelection } from 'prosemirror-state'
import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const inlineMathSyntax: InlineSyntax = {
  name: 'inlineMath',
  // 捕获组 1 = `\$` 或 `\$\$`;捕获组 2 = 中间非空非 $ 内容;反向引用 `\1` 配对
  // `(?<!\$)` 负向后行断言:匹配起点前不能是 $,防 `$$x$` 中间态从 index 1 误匹配
  pattern: /(?<!\$)(\$\$?)([^$\n]+)\1/g,
  apply(tr, { schema, from, to, match }) {
    const inner = match[2]
    if (!inner) return false
    const type = schema.nodes.math_inline
    if (!type) return false
    // content 含完整 `$...$`(含分隔符),由 NodeView 在渲染时剥离 $ 给 katex
    const text = match[0]
    tr.replaceRangeWith(from, to, type.create(null, schema.text(text)))
    // 用户实时键入最后一个 $ 形成 `$x$` 时,PM 默认把 selection map 到节点之外
    // (原光标在匹配末尾,replaceRangeWith 后落到插入节点之后)→ isCursorInNode
    // 返回 false → 立即切 display 态隐藏 `$x$`,用户看不到刚输入的内容。
    // 主动把 selection 设到节点内末尾(末尾 $ 之后,content 末尾,close tag 之前),
    // 保持 edit 态显示 `$x$` + 渲染层;用户继续输入别的字符,光标移出节点,
    // selectionchange 触发 syncMode 切回 display 隐藏 `$x$`。
    tr.setSelection(TextSelection.create(tr.doc, from + 1 + text.length))
    return true
  },
}
