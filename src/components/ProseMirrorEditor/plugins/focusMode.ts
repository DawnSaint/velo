// 专注模式 ProseMirror 插件。
//
// 开启时,光标所在的**顶层块**(paragraph / heading / blockquote / list /
// code_block / math_block ...)保持全不透明,其余顶层块由 CSS 降透明度
// (`.velo-editor.focus-mode .ProseMirror > *` → opacity,`.velo-focus-active`
// 覆盖回 1)。插件只负责给当前块挂 `Decoration.node` class,CSS 层接管
// 视觉 —— 与 codeLineNumberPlugin 同范式(setMeta 翻 enabled,decorations
// 读 state 决定是否产出)。
//
// "顶层块"取 depth-1 祖先:光标在 blockquote 内段落时,整个 blockquote
// 高亮(而非仅内层段落),与 Typora 专注模式行为一致。
//
// **初始化与文件切换**: focusMode 是 App.vue 的运行时 ref(不持久化),
// 不进 store。模块级 `currentEnabled` 由 EditorInner.vue watch 同步,
// `state.init` 读它 —— 切文件时 `view.updateState(EditorState.create(...))`
// 会重跑 init,正确恢复当前开关态(与 codeLineNumberPlugin 读 store 同理)。

import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

interface FocusModeState {
  enabled: boolean
}

export const focusModeKey = new PluginKey<FocusModeState>('veloFocusMode')

/** 模块级镜像:EditorInner.vue watch(props.focusMode) 同步到此,
 *  state.init 读它,保证切文件重建 state 时 enabled 不丢。 */
let currentEnabled = false

/** EditorInner.vue 调用:props.focusMode 变化时同步模块级镜像 + dispatch setMeta。 */
export function setFocusModeEnabled(enabled: boolean) {
  currentEnabled = enabled
}

/** 找光标所在顶层块(depth-1)的范围;空选 / 顶层 NodeSelection 也兜底。 */
function activeBlockRange(state: EditorState): { from: number, to: number } | null {
  const { $from } = state.selection
  if ($from.depth === 0) return null // 空文档 / 顶层原子 NodeSelection 边界
  const start = $from.before(1)
  const node = $from.node(1)
  return { from: start, to: start + node.nodeSize }
}

export const focusModePlugin = new Plugin<FocusModeState>({
  key: focusModeKey,
  state: {
    init: () => ({ enabled: currentEnabled }),
    apply(tr, prev) {
      const meta = tr.getMeta(focusModeKey) as { enabled?: boolean } | undefined
      if (!meta) return prev
      return { enabled: meta.enabled ?? prev.enabled }
    },
  },
  props: {
    decorations(state) {
      const s = focusModeKey.getState(state)
      if (!s?.enabled) return null
      const range = activeBlockRange(state)
      if (!range) return DecorationSet.empty
      return DecorationSet.create(state.doc, [
        Decoration.node(range.from, range.to, { class: 'velo-focus-active' }),
      ])
    },
  },
})
