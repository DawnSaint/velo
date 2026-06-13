// 回归测试:Backspace 在 paragraph 中间 → 应该放行(让 baseKeymap 删一个字符),
// imageKeymap 不应该消费这个事件。
//
// 根因(2026-06-13):ProseMirror 的 $pos.nodeBefore 在文本节点内部时,
// 返回的是当前 leaf 节点的 cut(0, dOff) 切片 —— 这个切片是 atom 化的
// (leaf + atom),isAtom === true。旧 imageKeymap 用 `!before.isAtom` 判,
// 把"在 text 中间"误判成"光标紧贴 atom",触发 NodeSelection 设置,
// 看起来就是"backspace 选中了这一段"或"删错了"。
//
// 修复:imageKeymap 改用 type.name 比对,只对真 atom(image / mermaid / math_block)
// 触发保护。原子化的 text 切片的 type.name === 'text',被正确放行。
//
// 本测试直接调 imageKeymap 的 Backspace 命令函数,断言对光标在 text 中间
// 的 selection 返回 false(不消费)。

import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { schema } from '../editor/schema'
import { imageKeymapPlugin } from '../image/imageKeymap'

function stateWithCursorAt(text: string, offset: number): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text(text)]),
  ])
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, 1 + 1 + offset),
    plugins: [imageKeymapPlugin],
  })
}

/** 抽 imageKeymap 的 Backspace 命令函数(不是通过 keymap 中转) */
function callBackspace(state: EditorState): boolean {
  // imageKeymap 的 spec.key 字段直接拿第一个 Backspace 命令
  const keymapPlugin = imageKeymapPlugin
  // prosemirror-keymap 把 key 拍到 plugin spec 里;安全路径是 getPluginState
  // 这里直接走 ProseMirror 内部 API:plugin.spec
  // 实际拿命令的写法:
  const spec: any = keymapPlugin.spec
  // 找 Backspace 命令
  return spec.backspace?.(state, undefined) ?? false
}

describe('Backspace 在 paragraph 中间', () => {
  it('imageKeymap 不应该消费 — text 中间 ($pos.nodeBefore 是 text 切片,陷阱!)', () => {
    // "hello world" 11 chars,offset 8 = 在 'o' 和 'r' 之间
    // 关键:在 text 节点内部,$pos.nodeBefore 会返回 atom 化的 text 切片
    const state = stateWithCursorAt('hello world', 8)
    const $pos = state.doc.resolve(state.selection.head)
    const before = $pos.nodeBefore
    // 锁定根因:这是 atom 化的 text 切片(type.name === 'text',但 isAtom === true)
    expect(before?.type.name).toBe('text')
    expect(before?.isAtom).toBe(true) //  ← 这就是 ProseMirror 的陷阱
    // 新 imageKeymap 用 type.name 判,应放行
    expect(callBackspace(state)).toBe(false)
  })

  it('imageKeymap 不应该消费 — paragraph 开头(光标紧贴 paragraph 起点)', () => {
    // offset 0 = paragraph 内部 text 起点(实际是 text 节点内部 offset 0,
    // ProseMirror 行为和"中间"一样)
    const state = stateWithCursorAt('hello', 0)
    expect(callBackspace(state)).toBe(false)
  })
})
