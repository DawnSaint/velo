// ProseMirror 插件:把 find/replace 的所有命中和当前命中渲染为高亮装饰。
//
// 为什么走 Decoration 而不是 ::selection:
//   - 浏览器的 ::selection 只在选区位于焦点元素里时绘制
//   - find 面板打开时焦点在 find 输入里,编辑器的选区不是"活动"的,::selection 不画
//   - 用户要"输入框有焦点、但能看见所有命中和当前命中",只能用 Decoration 模拟
//
// 工作机制:
//   - 插件 state = { matches: Match[], currentIndex: number }
//   - FindReplace 在 matches / currentIndex 变化时 dispatch tr.setMeta(pluginKey, {...})
//   - 插件 apply 读到 meta → 用新数据;否则只把旧 matches 位置 tr.mapping.map 一下
//     (用户在编辑器里输入导致 doc 变化时,旧位置仍能正确跟住)
//   - 插件 props.decorations 用 state 构造 DecorationSet,ProseMirror 自动渲染

import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'
import type { EditorState } from '@milkdown/prose/state'
import { $prose } from '@milkdown/utils'

export interface FindHighlight {
  matches: Array<{ from: number, to: number }>
  currentIndex: number
}

export const findHighlightKey = new PluginKey<FindHighlight>('veloFindHighlight')

function buildDecorations(state: EditorState, hl: FindHighlight): DecorationSet {
  if (!hl.matches.length) return DecorationSet.empty
  const decos: Decoration[] = []
  for (let i = 0; i < hl.matches.length; i++) {
    const m = hl.matches[i]
    if (m.from === m.to) continue
    decos.push(
      Decoration.inline(m.from, m.to, {
        class: i === hl.currentIndex ? 'velo-find-current' : 'velo-find-match',
      }),
    )
  }
  return DecorationSet.create(state.doc, decos)
}

const findHighlightPlugin = new Plugin<FindHighlight>({
  key: findHighlightKey,
  state: {
    init: (): FindHighlight => ({ matches: [], currentIndex: 0 }),
    apply(tr, prev) {
      const meta = tr.getMeta(findHighlightKey) as FindHighlight | undefined
      if (meta) {
        // 显式 setMeta → 用新数据(matches 已经反映新 doc,不要再 map)
        return { matches: meta.matches, currentIndex: meta.currentIndex }
      }
      // doc 变化但没 setMeta(用户在编辑器里输入、replace 自己的 tr)→
      // 旧位置 tr.mapping.map 跟住。空 matches 短路避免无谓分配。
      if (!prev.matches.length) return prev
      return {
        matches: prev.matches.map(m => ({
          from: tr.mapping.map(m.from),
          to: tr.mapping.map(m.to),
        })),
        currentIndex: prev.currentIndex,
      }
    },
  },
  props: {
    decorations(state) {
      const hl = findHighlightKey.getState(state)
      if (!hl || !hl.matches.length) return null
      return buildDecorations(state, hl)
    },
  },
})

/** Milkdown 包装:EditorInner 直接 .use(findHighlightPlugin) 即可 */
export const findHighlight = $prose(() => findHighlightPlugin)
