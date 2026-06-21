// CodeMirror 6 的查找高亮 —— 镜像 ProseMirror 侧 findHighlight.ts。
//
// 为什么不靠 ::selection:同 PM 侧,find 面板打开时焦点在 find 输入里,编辑器的
// 选区不是"活动"的,::selection 不画。必须用 Decoration 模拟"所有命中 + 当前命中"。
//
// 机制(与 findHighlight.ts 对仗):
//   - StateField<DecorationSet> 持 { matches, currentIndex } 驱动的装饰
//   - FindReplace 经 CM6 后端 dispatch cmFindHighlightEffect.of({matches, currentIndex})
//   - update 里先 deco.map(tr.changes) 跟住(用户在编辑器里输入导致文本变化),
//     再吃 effect 重算;无 effect 时保留映射后的旧装饰
//   - class 复用 velo-find-match / velo-find-current(与 PM 同一套 CSS)

import { StateEffect, StateField, type Range } from '@codemirror/state'
import { Decoration, DecorationSet, EditorView } from '@codemirror/view'

export interface CmFindHighlight {
  matches: Array<{ from: number, to: number }>
  currentIndex: number
}

/** 推高亮 / 清高亮都走这个 effect(清 = 传空 matches)。 */
export const cmFindHighlightEffect = StateEffect.define<CmFindHighlight>()

function buildDecorations(hl: CmFindHighlight): DecorationSet {
  if (!hl.matches.length) return Decoration.none
  const decos: Range<Decoration>[] = []
  for (let i = 0; i < hl.matches.length; i++) {
    const m = hl.matches[i]
    if (m.from === m.to) continue
    decos.push(
      Decoration.mark({
        class: i === hl.currentIndex ? 'velo-find-current' : 'velo-find-match',
      }).range(m.from, m.to),
    )
  }
  return Decoration.set(decos, true)
}

export const cmFindHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(cmFindHighlightEffect)) {
        return buildDecorations(e.value)
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})
