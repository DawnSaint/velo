// 打字机模式 ProseMirror 插件。
//
// 开启时,光标所在行始终锁定在滚动容器的**垂直中线**:用户键入 / 移动光标时,
// 文档在光标下方滚动,光标视觉位置不动(打字机感)。
//
// ## 为什么居中走 requestAnimationFrame,而非在 view.update() 里同步 scrollBy
//
// ProseMirror 的 EditorView.update 执行序(查 prosemirror-view/dist):
//   updatePluginViews() (行 5527,plugin view.update() 在此跑)
//   → scroll 分支(行 5530-5538):
//       scroll == "reset"        → this.dom.scrollTop = 0
//       scroll == "to selection" → scrollToSelection()(仅 scrollIntoView 标记的 tr)
//       oldScrollPos              → resetScrollPos()(scroll-anchoring polyfill)
//
// 若在 view.update() 里**同步** scrollBy,它落在所有这些分支**之前**;PM 自身的
// scrollToSelection(带 scrollIntoView 标记的 tr:Enter / paste / find 命中 / TOC·
// 大纲跳转 / crossModeSync placeCursor)会在其后跑"最小滚入视口"把光标推到边缘,
// 覆盖居中;浏览器原生 overflow-anchor 在布局期也可能回拉。两者都会把光标顶出
// 视口 → 表现为"光标消失"。
//
// 解法:把居中 defer 到 requestAnimationFrame。rAF 回调在 PM 整个 updateState
// 返回之后、浏览器 paint 之前跑 —— PM 的所有 scroll 处理已落地、布局已就绪,
// 我们的 scrollBy 是最终结果,无抖动、无被覆盖。同帧多次 update 只排一个 rAF,
// 回调里读最新 state 一次性居中。
//
// ## 为什么还要 handleScrollToSelection 返回 true
//
// 仅靠 rAF 居中不足以覆盖 scrollIntoView tr:PM 的 scrollToSelection 不只滚
// 编辑器滚动容器,可能滚 window / 外层祖先(scrollRectIntoView 沿链向上),
// 而 rAF 只居中编辑器滚动容器,撤不掉 window 的滚动。故开启时 handleScrollToSelection
// 返 true 抑制 PM 自身滚动(行 5546 someProp 命中即跳过),rAF 再干净居中。
// 关闭返 false,PM 行为不变(零回归)。
//
// **初始化与文件切换**:与 focusModePlugin 同范式 —— enabled 不持久化(运行时态),
// 模块级 currentEnabled 由 EditorInner.vue watch 同步,state.init 读它,切文件
// view.updateState(EditorState.create(...)) 重跑 init 不丢开关态。
//
// **边界(有意接受)**:切文件后 EditorInner 的 resetScrollToTop() 会覆盖本插件
// 的居中(光标落回顶部),切标签恢复的 restoreScrollTop() 同理 —— 打字机在下一次
// 交互时才居中,与"打开文件不抢视口"的现有取舍一致。

import { Plugin, PluginKey, NodeSelection } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { findScrollAncestor } from '../composables/scrollUtils'

interface TypewriterModeState {
  enabled: boolean
}

export const typewriterModeKey = new PluginKey<TypewriterModeState>('veloTypewriterMode')

/** 模块级镜像:EditorInner.vue watch(props.typewriterMode) 同步到此,
 *  state.init 读它,保证切文件重建 state 时 enabled 不丢(与 focusModePlugin 同理)。 */
let currentEnabled = false

/** EditorInner.vue 调用:props.typewriterMode 变化时同步模块级镜像 + dispatch setMeta。 */
export function setTypewriterModeEnabled(enabled: boolean) {
  currentEnabled = enabled
}

/** 选区的垂直中点(视口坐标)。
 *  - collapse 文本选区:取 head 那一行的中线。
 *  - NodeSelection(点图片等 atom):**必须用 nodeDOM 拿节点本体的真实矩形**,
 *    不能用 coordsAtPos(from/to)。Velo 的图片是 inline-atom,但 NodeView 的
 *    wrapper 是 display:block 撑满行(模型 inline、渲染 block),coordsAtPos(from)
 *    落在图片**上方**文本行、coordsAtPos(to) 落在图片**下方**文本行,中点偏向
 *    上下文本行而非图片本体 → 居中会把图片往上顶约 1/4 视口。
 *  - 范围文本选区:取 from.top 到 to.bottom 的中点。 */
function selectionVerticalCenter(view: EditorView): number | null {
  const sel = view.state.selection
  if (sel instanceof NodeSelection) {
    const dom = view.nodeDOM(sel.from)
    if (dom instanceof HTMLElement) {
      const r = dom.getBoundingClientRect()
      if (r.bottom > r.top) return (r.top + r.bottom) / 2
    }
  }
  const { from, to } = sel
  const a = view.coordsAtPos(from)
  if (!a) return null
  if (from === to) return (a.top + a.bottom) / 2
  const b = view.coordsAtPos(to)
  return b ? (a.top + b.bottom) / 2 : (a.top + a.bottom) / 2
}

/** 把选区垂直中点滚到滚动容器垂直中线。复用 crossModeSync.centerScrollPm 同款数学:
 *  findScrollAncestor 找 overflow:auto 祖先,scrollBy(center - containerCenter)。
 *  阈值 4px 避免亚像素抖动。无可滚祖先 → no-op。 */
function centerCursor(view: EditorView): void {
  const scroller = findScrollAncestor(view.dom)
  if (!scroller) return
  const center = selectionVerticalCenter(view)
  if (center === null) return
  const scrollerRect = scroller.getBoundingClientRect()
  const containerCenter = scrollerRect.top + scroller.clientHeight / 2
  const delta = center - containerCenter
  if (Math.abs(delta) > 4) scroller.scrollBy({ top: delta })
}

export const typewriterModePlugin = new Plugin<TypewriterModeState>({
  key: typewriterModeKey,
  state: {
    init: () => ({ enabled: currentEnabled }),
    apply(tr, prev) {
      const meta = tr.getMeta(typewriterModeKey) as { enabled?: boolean } | undefined
      if (!meta) return prev
      return { enabled: meta.enabled ?? prev.enabled }
    },
  },
  props: {
    // 抑制 PM 自带的"最小滚入视口":带 scrollIntoView 标记的 tr 会触发
    // scrollToSelection,它不只滚编辑器容器,可能沿链向上滚 window / 外层祖先
    // (scrollRectIntoView),而下方 rAF 只居中编辑器容器,撤不掉 window 滚动。
    // 故开启时返 true = 已接管,PM 跳过自身滚动(行 5546 someProp 命中即跳过),
    // rAF 再干净居中;关闭返 false,PM 行为不变(零回归)。
    handleScrollToSelection(view) {
      const s = typewriterModeKey.getState(view.state)
      return s?.enabled === true
    },
  },
  view: () => {
    // 闭包持 prevEnabled:toggle-on(enabled false→true)的 setMeta-only tr
    // 选区 / 文档都不变,靠 justEnabled 触发立即居中。跨文件不重置(plugin view
    // 随 EditorView 生命周期,不随 state 重建)。
    let prevEnabled = currentEnabled
    // 同帧多次 update 只排一个 rAF;回调里读最新 state 居中。null = 无 pending。
    let rafId: number | null = null
    const scheduleCenter = (view: EditorView) => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        // 视图可能在本帧被销毁(view.destroy 触发 plugin view.destroy 已 cancel,
        // 但 rAF 已入队时仍可能晚到);enabled 也可能本帧被关掉,二次确认。
        if (view.isDestroyed) return
        const s = typewriterModeKey.getState(view.state)
        if (s?.enabled) centerCursor(view)
      })
    }
    return {
      update(view: EditorView, prevState: EditorState) {
        const s = typewriterModeKey.getState(view.state)
        if (!s?.enabled) {
          prevEnabled = false
          return
        }
        const selChanged = !prevState.selection.eq(view.state.selection)
        const docChanged = !prevState.doc.eq(view.state.doc)
        const justEnabled = !prevEnabled
        prevEnabled = true
        if (!selChanged && !docChanged && !justEnabled) return
        scheduleCenter(view)
      },
      destroy() {
        if (rafId !== null) cancelAnimationFrame(rafId)
        rafId = null
      },
    }
  },
})
