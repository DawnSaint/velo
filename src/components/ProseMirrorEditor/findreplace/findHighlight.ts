// ProseMirror 插件:把 find/replace 的所有命中和当前命中渲染为高亮装饰。
//
// 为什么走 Decoration 而不是 ::selection:
//   - 浏览器的 ::selection 只在选区位于焦点元素里时绘制
//   - find 面板打开时焦点在 find 输入里,编辑器的选区不是"活动"的,::selection 不画
//   - 用户要"输入框有焦点、但能看见所有命中和当前命中",只能用 Decoration 模拟
//
// 工作机制:
//   - 插件 state = { matches, currentIndex, active }
//   - FindReplace 在 matches / currentIndex 变化时 dispatch tr.setMeta(pluginKey, {...})
//   - 插件 apply 读到 meta → 用新数据;否则把旧 matches 位置过一遍 tr.mapping
//   - 插件 props.decorations 用 state 构造 DecorationSet,ProseMirror 自动渲染
//
// 与 source edit 插件的契约(2026-11 修「搜索定位错位」时建立):
//   - active 表示查找面板打开。markSourceEdit / emojiSourceEdit / charRefSourceEdit
//     这类插件会把 *视图状态* 写进 doc(行内 code mark → 字面量 "`code`",净 +2;
//     char_ref → "&#x20;",净 +5),doc 坐标系跟渲染态不通用;面板打开时它们靠
//     isFindReplaceActive() 退避,不再改 doc(charRef 改用纯 decoration 显示命中)。
//   - 兜底:doc 真的变了(键入 / 别的插件 / 外部替换)时 view.update 通过
//     subscribeFindDocChange 异步通知 FindReplace 重算 matches,而不是只靠 map。

import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

export interface FindHighlight {
  matches: Array<{ from: number, to: number }>
  currentIndex: number
  /** 查找面板是否打开。source edit 类插件据此退避,避免 doc 在渲染态/源码态间跳变。 */
  active: boolean
}

/** setMeta 载荷:'set' 推全量命中;'active' 切面板开合(关闭时顺带清命中)。 */
type FindHighlightMeta =
  | { type: 'set', matches: FindHighlight['matches'], currentIndex: number }
  | { type: 'active', active: boolean }

export const findHighlightKey = new PluginKey<FindHighlight>('veloFindHighlight')

/** 给 source edit 类插件用的守卫:面板打开时不要让 doc 在「渲染态 / 源码态」间跳变。 */
export function isFindReplaceActive(state: EditorState): boolean {
  return findHighlightKey.getState(state)?.active === true
}

// ------------------------------------------------------------
//  docChanged 订阅
// ------------------------------------------------------------

type DocChangeListener = () => void
const docChangeListeners = new WeakMap<EditorView, Set<DocChangeListener>>()

/** 订阅 PM 文档变化(面板打开期间重算 matches)。返回取消订阅函数。 */
export function subscribeFindDocChange(view: EditorView, cb: DocChangeListener): () => void {
  let set = docChangeListeners.get(view)
  if (!set) {
    set = new Set()
    docChangeListeners.set(view, set)
  }
  set.add(cb)
  return () => { set?.delete(cb) }
}

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
    init: (): FindHighlight => ({ matches: [], currentIndex: 0, active: false }),
    apply(tr, prev) {
      const meta = tr.getMeta(findHighlightKey) as FindHighlightMeta | undefined
      if (meta?.type === 'active') {
        return meta.active
          ? { ...prev, active: true }
          : { matches: [], currentIndex: 0, active: false }
      }
      if (meta?.type === 'set') {
        // 显式 setMeta → 用新数据(matches 已经反映新 doc,不要再 map)。
        // active 只由 'active' meta 管:否则面板关闭后残留的一次 setHighlight 会把
        // source edit 类插件重新冻住。
        return { matches: meta.matches, currentIndex: meta.currentIndex, active: prev.active }
      }
      // doc 变化但没 setMeta(用户在编辑器里输入、replace 自己的 tr)→
      // 旧位置过 tr.mapping 跟住。空 matches 短路避免无谓分配。
      if (!prev.matches.length) return prev
      // 关键:区间两端必须用**相反** assoc。默认两端都 map(pos) (=assoc 1) 时,
      // 若命中区间被整体替换(mark 源码态切换 / 粘贴覆盖),两端会一起被推到插入
      // 内容之后 → 区间塌缩成尾部 1 个字符甚至消失(截图里「只剩后面的空格高亮」)。
      // from 用 -1 贴住替换起点、to 用 1 贴住替换终点,至少覆盖整段新内容;
      // 精确坐标由 docChanged 订阅触发的重算补上。
      return {
        ...prev,
        matches: prev.matches.map(m => ({
          from: tr.mapping.map(m.from, -1),
          to: tr.mapping.map(m.to, 1),
        })),
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

  // 任何 doc 变化都通知订阅者重算 matches。比较 doc 引用即可 —— PM 的事务只要
  // 没改内容就复用同一个 Node 实例,选区 / setMeta 事务不会误触发。
  view(initialView) {
    let prevDoc = initialView.state.doc
    let scheduled = false
    return {
      update(view) {
        const doc = view.state.doc
        if (doc === prevDoc) return
        prevDoc = doc
        if (scheduled) return
        scheduled = true
        // 不能在 view.update 里同步 dispatch(PM 更新期间重入)。微任务同时把
        // 同一 tick 的多次 docChanged(连续键入 / replaceAll 循环)合并成一次通知。
        void Promise.resolve().then(() => {
          scheduled = false
          const listeners = docChangeListeners.get(view)
          if (!listeners?.size) return
          for (const cb of [...listeners]) cb()
        })
      },
    }
  },
})

/** raw ProseMirror Plugin —— EditorInner 直接装入 plugins 数组 */
export const findHighlight = findHighlightPlugin
