// B1 viewport 感知 decoration 构建：
// 跟踪当前视口内（及 buffer）的 doc pos 范围，滚动时 dispatch meta 通知
// decoration 插件只为可见区域构建 decoration。
//
// 设计要点：
// - PM 的 `decorations(state)` 在 `view.update` 时同步调用，无法直接知道
//   "当前视口"——通过 plugin state 传递 viewport 范围
// - 滚动不产生 transaction，需手动 dispatch `setMeta(viewportKey, range)`
// - 该 transaction `docChanged=false`，不触发 onChange / onSelectionChange
// - viewport=null 表示不做 viewport 过滤（初始状态 / 无滚动容器 fallback）
// - docChanged 时 map 旧 range 到新 doc 坐标
//
// 大文档初始渲染优化（C1）：
// - `view.updateState(newState)` 时 PM 同步创建全部 DOM + 跑全部 decorations()，
//   viewport=null 导致所有 decoration 插件为整个文档构建装饰（shiki tokenization、
//   header widget DOM 等），大文档下耗时数秒。
// - `setInitialViewportHint()` 在 EditorState.create 前预设一个覆盖首屏的窄范围，
//   让 decoration 插件只为首屏节点构建装饰。updateState 完成后用 rAF 调
//   `refreshViewport()` 计算真实 viewport 并 dispatch meta 触发重建。
//
// 不参与 viewport 过滤的插件：
// - foldDecoration：velo-folded Decoration.node 始终全量（不能因滚出视口而展开）
// - tocDecoration：TOC 节点通常很少，全量即可
// - findHighlight：搜索高亮必须覆盖全文档

import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { findScrollAncestor } from '../composables/useProseMirror'

export interface ViewportRange {
  /** doc pos（inclusive）——视口顶部减去 buffer */
  from: number
  /** doc pos（exclusive）——视口底部加上 buffer */
  to: number
}

export const viewportKey = new PluginKey<ViewportRange | null>('viewport')

/** 视口上下 buffer（像素）。快速滚动时避免 decoration 空白闪烁。 */
const BUFFER_PX = 1000
/** 滚动事件 debounce（毫秒）。 */
const SCROLL_DEBOUNCE_MS = 100
/** range 变化容忍度（doc pos）。from/to 都在容忍度内时不 dispatch。 */
const RANGE_TOLERANCE = 200

/**
 * 大文档初始渲染优化：在 EditorState.create 前预设一个覆盖首屏的窄 viewport。
 * init 读取此值；create 后立即 clear，避免泄漏到后续 state 创建。
 * null = 不预设（小文档 / 测试场景），init 返回 null = 不过滤。
 */
let initialViewportHint: ViewportRange | null = null

/** 预设初始 viewport range，供下一次 EditorState.create 的 plugin init 读取。 */
export function setInitialViewportHint(range: ViewportRange | null): void {
  initialViewportHint = range
}

/**
 * 计算当前 view 的真实 viewport 并 dispatch meta 通知 decoration 插件重建。
 * 用于 view.updateState 后（文件切换 / 大文档异步加载）——view factory 的 rAF
 * 只在首次 mount 时跑一次，后续 updateState 需手动调此函数刷新 viewport。
 */
export function refreshViewport(view: EditorView): void {
  if (view.isDestroyed) return
  const range = calculateViewportRange(view)
  if (!range) return
  const prev = viewportKey.getState(view.state)
  if (
    prev
    && Math.abs(prev.from - range.from) < RANGE_TOLERANCE
    && Math.abs(prev.to - range.to) < RANGE_TOLERANCE
  ) {
    return
  }
  view.dispatch(view.state.tr.setMeta(viewportKey, range))
}

/**
 * 判断节点是否在 viewport 范围内。
 * viewport=null 时始终返回 true（无 viewport 信息 = 不过滤）。
 */
export function isInViewport(
  pos: number,
  nodeSize: number,
  viewport: ViewportRange | null,
): boolean {
  if (!viewport) return true
  return pos + nodeSize > viewport.from && pos < viewport.to
}

/**
 * 从 EditorView 计算当前可见的 doc pos 范围。
 * 用二分搜索在 `.ProseMirror` 的顶层 DOM 子元素中找第一个/最后一个可见 child，
 * 再通过 `view.posAtDOM` 映射到 doc pos。
 *
 * 返回 null 表示无法计算（无滚动容器 / DOM 未就绪）。
 */
function calculateViewportRange(view: EditorView): ViewportRange | null {
  const scrollContainer = findScrollAncestor(view.dom)
  if (!scrollContainer) return null

  const pm = view.dom
  const children = pm.children
  if (children.length === 0) return null

  const scrollRect = scrollContainer.getBoundingClientRect()
  const visibleTop = scrollRect.top - BUFFER_PX
  const visibleBottom = scrollRect.bottom + BUFFER_PX

  // 二分搜索：找第一个 bottom >= visibleTop 的 child
  let lo = 0
  let hi = children.length - 1
  let firstVisible = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const rect = (children[mid] as HTMLElement).getBoundingClientRect()
    if (rect.bottom < visibleTop) {
      lo = mid + 1
    } else {
      firstVisible = mid
      hi = mid - 1
    }
  }

  // 二分搜索：找最后一个 top <= visibleBottom 的 child
  lo = firstVisible
  hi = children.length - 1
  let lastVisible = firstVisible
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const rect = (children[mid] as HTMLElement).getBoundingClientRect()
    if (rect.top > visibleBottom) {
      hi = mid - 1
    } else {
      lastVisible = mid
      lo = mid + 1
    }
  }

  // 映射到 doc pos
  // posAtDOM(el, 0) 给出 el 内部起始 pos（open token 之后），
  // 对范围判断来说足够精确（off-by-one 由 RANGE_TOLERANCE 吸收）。
  const firstChild = children[firstVisible]
  const lastChild = children[lastVisible] as HTMLElement
  const fromPos = view.posAtDOM(firstChild, 0)
  const toPos = view.posAtDOM(lastChild, lastChild.childNodes.length)

  return { from: fromPos, to: toPos }
}

export const viewportPlugin = new Plugin<ViewportRange | null>({
  key: viewportKey,
  state: {
    init: () => initialViewportHint,
    apply(tr, prev) {
      const meta = tr.getMeta(viewportKey) as ViewportRange | undefined
      if (meta) return meta
      // docChanged：map 旧 range 到新 doc 坐标
      if (tr.docChanged && prev) {
        const from = tr.mapping.map(prev.from, -1)
        const to = tr.mapping.map(prev.to, 1)
        if (from >= to) return null
        return { from, to }
      }
      return prev
    },
  },
  view: (view: EditorView) => {
    let scrollContainer: HTMLElement | null = null
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    function updateViewport() {
      if (view.isDestroyed) return
      const range = calculateViewportRange(view)
      if (!range) return
      // range 没有显著变化时不 dispatch，避免无谓 rebuild
      const prev = viewportKey.getState(view.state)
      if (
        prev
        && Math.abs(prev.from - range.from) < RANGE_TOLERANCE
        && Math.abs(prev.to - range.to) < RANGE_TOLERANCE
      ) {
        return
      }
      view.dispatch(view.state.tr.setMeta(viewportKey, range))
    }

    function onScroll() {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        updateViewport()
      }, SCROLL_DEBOUNCE_MS)
    }

    // 找到滚动容器并挂 scroll listener
    scrollContainer = findScrollAncestor(view.dom)
    if (scrollContainer) {
      scrollContainer.addEventListener('scroll', onScroll, { passive: true })
    }

    // 首帧计算 viewport（DOM 就绪后）
    requestAnimationFrame(() => {
      if (view.isDestroyed) return
      // 如果 scrollContainer 在 view factory 时还没就绪，这里再试一次
      if (!scrollContainer) {
        scrollContainer = findScrollAncestor(view.dom)
        if (scrollContainer) {
          scrollContainer.addEventListener('scroll', onScroll, { passive: true })
        }
      }
      updateViewport()
    })

    return {
      destroy() {
        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = null
        }
        if (scrollContainer) {
          scrollContainer.removeEventListener('scroll', onScroll)
        }
      },
    }
  },
})

/** 从 EditorState 读 viewport range（给 decoration 插件用）。 */
export function getViewport(state: EditorState): ViewportRange | null {
  return viewportKey.getState(state) ?? null
}
