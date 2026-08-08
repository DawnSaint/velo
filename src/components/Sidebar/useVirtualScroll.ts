// 虚拟滚动 + Sticky 目录头 composable。
//
// 虚拟滚动:只渲染视口内可见行 + overscan 缓冲,spacer div 撑住总高度。
// DOM 节点从 O(n) 降至 O(viewport),无论展开多少目录渲染开销近恒定。
//
// Sticky 目录头:滚动时已滚出视口顶部的目录行级联粘贴(同 VSCode)。
// 用 flatItems 内存数组 + 固定行高算各行 offset,从当前可见区域第一行
// 向前走找各层级最近的目录祖先 → 渲染 overlay。不走 querySelectorAll /
// offsetTop,消除 DOM 扫描 + 布局回流。
//
// 两者合并到 updateViewport:同一次 rAF 回调读 scrollTop + clientHeight,
// 同时更新 visibleRange 和 stickyHeaders,避免重复布局读取。

import { computed, nextTick, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import type { TreeNode } from './useTreeData'

export type VisualItem =
  | { kind: 'node', node: TreeNode, depth: number, expanded: boolean }
  | { kind: 'inlineNew', parentDir: string, depth: number, subKind: 'newFile' | 'newDir' }

interface UseVirtualScrollOptions {
  flatItems: ComputedRef<VisualItem[]>
  rootCollapsed: Ref<boolean>
  isRootNode: (node: TreeNode) => boolean
  rootDisplay: ComputedRef<string>
}

export function useVirtualScroll(options: UseVirtualScrollOptions) {
  const { flatItems, rootCollapsed, isRootNode, rootDisplay } = options
  const workspace = useWorkspaceStore()

  const ROW_HEIGHT = 30 // h-7.5 = 1.875rem = 30px
  const OVERSCAN = 5 // 视口上下额外渲染的行数,减少滚动时的闪烁
  const scrollContainerRef = ref<HTMLElement | null>(null)
  let scrollRafId: number | null = null
  const stickyHeaders = ref<{ node: TreeNode; depth: number }[]>([])
  const visibleRange = ref({ start: 0, end: 0 })

  /** 视口内可见行(含 overscan),由 flatItems 切片得来。 */
  const visibleItems = computed<VisualItem[]>(() => {
    const items = flatItems.value
    const { start, end } = visibleRange.value
    if (start >= end || start >= items.length) return []
    return items.slice(start, Math.min(end, items.length))
  })

  function onScroll() {
    if (scrollRafId !== null) return
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null
      updateViewport()
    })
  }

  function updateViewport() {
    const container = scrollContainerRef.value
    if (!container) {
      visibleRange.value = { start: 0, end: 0 }
      stickyHeaders.value = []
      return
    }

    const items = flatItems.value
    if (!items.length) {
      visibleRange.value = { start: 0, end: 0 }
      stickyHeaders.value = []
      return
    }

    const st = container.scrollTop
    const vh = container.clientHeight

    // clientHeight === 0 (jsdom / 容器尚未布局) → 全量渲染,不虚拟化
    if (vh === 0) {
      visibleRange.value = { start: 0, end: items.length }
      stickyHeaders.value = []
      return
    }

    // — 虚拟滚动:计算可见范围 —
    const start = Math.max(0, Math.floor(st / ROW_HEIGHT) - OVERSCAN)
    const end = Math.min(items.length, Math.ceil((st + vh) / ROW_HEIGHT) + OVERSCAN)
    visibleRange.value = { start, end }

    // — Sticky 目录头 —
    if (st <= 0) {
      stickyHeaders.value = []
      return
    }
    // 行高统一按 ROW_HEIGHT;inlineNew 行(h-8=32px)差 2px,
    // inline 编辑期间用户不滚动,视觉无感知。
    const headers: { node: TreeNode; depth: number }[] = []
    const seenDepths = new Set<number>()

    // 从当前可见区域第一行向前走,找各层级最近的目录祖先。
    // 向前走的步数 = scrollTop / ROW_HEIGHT,通常 < 200,远快于全量 DOM 扫描。
    const startIdx = Math.min(Math.floor(st / ROW_HEIGHT), items.length - 1)
    for (let i = startIdx; i >= 0; i--) {
      const item = items[i]
      if (item.kind !== 'node' || !item.node.isDir) continue
      if (seenDepths.has(item.depth)) continue

      const rowTop = i * ROW_HEIGHT
      const threshold = item.depth * ROW_HEIGHT
      // 条件 1:已滚过阈值
      if (rowTop - st > threshold) continue

      // 条件 2:子树仍可见 —— 下一个 depth<=当前的同级/祖先级行还没滚过阈值
      let endTop = items.length * ROW_HEIGHT
      for (let j = i + 1; j < items.length; j++) {
        if (items[j].depth <= item.depth) {
          endTop = j * ROW_HEIGHT
          break
        }
      }
      if (endTop - st <= threshold) continue

      seenDepths.add(item.depth)
      headers.unshift({ node: item.node, depth: item.depth })
    }

    stickyHeaders.value = headers
  }

  function stickyIsExpanded(node: TreeNode): boolean {
    if (isRootNode(node)) return !rootCollapsed.value
    return workspace.isDirExpanded(node.fullPath)
  }

  function stickyDisplayName(node: TreeNode): string {
    return isRootNode(node) ? rootDisplay.value : node.name
  }

  /** 取消挂起的 rAF(生命周期卸载时调用)。 */
  function cancelRaf() {
    if (scrollRafId !== null) { cancelAnimationFrame(scrollRafId); scrollRafId = null }
  }

  /** 重置视口状态(resetTransientUi 调用)。 */
  function reset() {
    stickyHeaders.value = []
    visibleRange.value = { start: 0, end: 0 }
  }

  // flatItems 变化时(展开/折叠/CRUD)重新计算 viewport + sticky。
  // 同步调用确保 visibleRange 在 Vue 重渲染前更新,避免空帧闪烁;
  // nextTick 再补一次以处理 DOM 更新后 scrollTop 可能被浏览器 clamp 的情况。
  watch([flatItems, rootCollapsed], () => {
    updateViewport()
    nextTick(updateViewport)
  })

  return {
    ROW_HEIGHT,
    scrollContainerRef,
    stickyHeaders,
    visibleRange,
    visibleItems,
    onScroll,
    updateViewport,
    stickyIsExpanded,
    stickyDisplayName,
    cancelRaf,
    reset,
  }
}
