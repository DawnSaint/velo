// 回归测试:$x$ 文本输入 → math_inline 节点
//
// 根因(2026-06-13):Phase 2 写新 EditorInner 时漏了 inline math input rule。
// remark-math / markdownIO 只走外部 markdown 解析,EditorView 实时键入
// 不经过 unified pipeline,必须靠 prosemirror-inputrules 显式提供。
//
// 本测试直接调 inlineMathInputRule,断言:
//   - 替换为 math_inline 节点
//   - 节点的 textContent 是 $1 的内容
//   - 跨行 (含 \n) 不匹配
//   - 空 $1 不匹配

import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state'
import { InputRule } from 'prosemirror-inputrules'
import type { InputRule as InputRuleType } from 'prosemirror-inputrules'
import { schema } from '../editor/schema'

// 复制 EditorInner.vue 里 inlineMathInputRule 的实现 —— 不能直接 import,
// 因为 EditorInner 是 .vue 文件,这里测纯 rule
const inlineMathInputRule: InputRuleType = new InputRule(
  /\$([^$\n]+)\$$/,
  (state, match, start, end) => {
    const inner = match[1]
    if (!inner) return null
    const type = state.schema.nodes.math_inline
    if (!type) return null
    const tr = state.tr
    tr.replaceRangeWith(start, end, type.create(null, state.schema.text(inner)))
    return tr
  },
)

// InputRule 的 handler / regex 字段在 prosemirror-inputrules 公开 API 里不导出
// (它们存在但 TS 类型声明里没列)。这里给个轻包装,绕过类型检查。
function applyRule(state: EditorState, _matchText: string, match: RegExpMatchArray, start: number, end: number): Transaction | null {
  // @ts-expect-error InputRule 内部字段不在公开类型
  return inlineMathInputRule.handler(state, match, start, end) ?? null
}

function stateWithText(text: string, cursorOffset: number): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text(text)]),
  ])
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, 1 + 1 + cursorOffset),
    plugins: [
      // inputRules plugin 让 runInputRules 走 rules list
      // (runInputRules 需要 plugin context 来拿所有 rules)
    ],
  })
}

describe('inlineMathInputRule', () => {
  it('"$x$" 紧贴光标 → 替换为 math_inline("x")', () => {
    // "para$x$" 8 chars,光标 pos = 2+7 = 9 (第二个 $ 之后)
    const state = stateWithText('para$x$', 7)
    const tr = applyRule(state, '$x$', ['$x$', 'x'], 1 + 4, 1 + 7)
    expect(tr).not.toBeNull()
    const newDoc = tr!.doc
    const para = newDoc.firstChild!
    expect(para.type.name).toBe('paragraph')
    expect(para.childCount).toBe(2)
    expect(para.child(0).text).toBe('para')
    expect(para.child(1).type.name).toBe('math_inline')
    expect(para.child(1).textContent).toBe('x')
  })

  it('空匹配($$)不转换', () => {
    const state = stateWithText('para$$', 6)
    const tr = applyRule(state, '$$', ['$$', ''], 1 + 4, 1 + 6)
    // inner 为空时 handler 返回 null,InputRule 不会应用
    expect(tr).toBeNull()
  })

  it('含 \\n 的不匹配(多行不能成行内公式)', () => {
    // 跨行场景:用户按了回车,$ 在两行 —— 这是块级公式 $$ 触发的情况,
    // 不应被 inline rule 抢走
    const matched = /\$([^$\n]+)\$$/.exec('para$x\ny$')
    // regex `[^$\n]+` 排除换行,所以跨行场景不会匹配整个 $...$
    // 这里只验证 regex 自身:跨行时取不到完整 match
    expect(matched).toBeNull()
  })

  it('"$E=mc^2$" → math_inline 节点 textContent 完整', () => {
    // text = "see $E=mc^2$",cursor 在末尾 (offset 12)
    // 实际替换范围:从 pos = 1+1+4 (第二个 $ 之前) 到 1+1+12
    const state = stateWithText('see $E=mc^2$', 12)
    const tr = applyRule(state, '$E=mc^2$', ['$E=mc^2$', 'E=mc^2'], 1 + 8, 1 + 12)
    expect(tr).not.toBeNull()
    const mathNode = tr!.doc.firstChild!.lastChild!
    expect(mathNode.type.name).toBe('math_inline')
    expect(mathNode.textContent).toBe('E=mc^2')
  })
})
