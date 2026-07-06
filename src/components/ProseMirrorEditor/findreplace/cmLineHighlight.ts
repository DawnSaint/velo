// CodeMirror 6 的 : 行号模式行高亮 —— 跳行预览时高亮目标行。
//
// 机制(镜像 cmFindHighlight,但值是"行号"而非 DecorationSet):
//   - StateField<number | null> 持当前高亮行号(null = 无高亮)
//   - App.vue 经 srcRef.value.view dispatch cmLineHighlightEffect.of(line | null)
//   - Decoration 用 EditorView.decorations.of 读 field,每次重建 —— 行的 char offset
//     随文档变化漂移,StateField 存行号、deco source 用 state.doc.line(n) 取实时 from,
//     自动跟住编辑(同 cmFocusModeTailDeco 的 of+读 field 模式)
//   - class velo-cm-line-jump(金色行底,与 velo-find-match 同族)
//
// 只服务 : 行号模式(该模式强制源码),PM 侧无对仗(行号是源码概念)。

import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView } from '@codemirror/view'

/** 设 / 清行高亮都走这个 effect(清 = 传 null)。 */
export const cmLineHighlightEffect = StateEffect.define<number | null>()

/** 持当前高亮行号;null = 无。 */
export const cmLineHighlightField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(cmLineHighlightEffect)) return e.value
    }
    return value
  },
})

/** 读 field 出 Decoration.line;行号越界(doc.line 抛)→ none,不崩。 */
export const cmLineHighlightDeco = EditorView.decorations.of((view) => {
  const line = view.state.field(cmLineHighlightField, false)
  if (line == null || line < 1) return Decoration.none as DecorationSet
  try {
    const l = view.state.doc.line(line)
    return Decoration.set([Decoration.line({ class: 'velo-cm-line-jump' }).range(l.from)], true)
  } catch {
    return Decoration.none as DecorationSet
  }
})
