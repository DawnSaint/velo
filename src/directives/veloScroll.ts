import type { Directive } from 'vue'

/**
 * 工作区浮动滚动条 —— 原生滚动条隐藏(width:0 不占布局空间),由 JS 创建
 * position:fixed 的 .velo-scroll-thumb 浮在内容右侧。
 *
 * 两个设计目标(纯 CSS ::-webkit-scrollbar 做不到):
 * 1. 不占布局空间 —— 原生自定义滚动条是 classic 模式(占宽度),整行高亮
 *    无法紧贴右侧 border;浮动 thumb 悬浮在内容之上,内容占满容器宽度。
 * 2. 可靠淡入淡出 —— thumb 默认 opacity:0,mouseenter 容器时 JS 给 thumb
 *    加 .velo-scroll-thumb-visible → opacity transition 淡入;mouseleave
 *    淡出。自己的 DOM transition 100% 可靠(webkit scrollbar 伪元素 transition
 *    不稳定,且 transparent thumb 时容器 :hover 不驱动重绘)。
 *
 * thumb 作为滚动容器的子元素(命令式 appendChild),position:fixed 使其
 * 不随内容滚动、不被 overflow 裁剪(前提:容器及祖先无 transform,已确认
 * 工作区滚动容器链路无 transform)。暗色模式:.velo-scroll-thumb 是容器
 * 的 DOM 后代,自然命中 .dark 祖先选择器。
 *
 * Vue 模板用 v-velo-scroll 指令;命令式 DOM(CM6 scrollDOM)用
 * attachVeloScroll / detachVeloScroll。
 */

const THUMB_WIDTH = 6
const THUMB_GAP = 2
// thumb 最小高度:超长文档下 ratio * clientHeight 会趋近 0,设下限保证可抓性。
// 40px 对齐 VS Code overlay scrollbar 下限 —— 编辑器大视口里视觉够长,
// 文件树等小容器里也不会突兀(内容通常不会短到触发下限)。
const THUMB_MIN_HEIGHT = 64

interface ScrollState {
  thumb: HTMLDivElement
  drag: { startY: number; startScrollTop: number; trackHeight: number } | null
  onScroll: () => void
  onEnter: () => void
  onLeave: () => void
  onThumbDown: (e: MouseEvent) => void
  onDragMove: (e: MouseEvent) => void
  onDragEnd: () => void
  onWinResize: () => void
  ro: ResizeObserver | null
  mo: MutationObserver | null
  cancelRaf: () => void
}

const states = new WeakMap<HTMLElement, ScrollState>()

function updateThumb(el: HTMLElement, thumb: HTMLDivElement): void {
  const { scrollTop, scrollHeight, clientHeight } = el
  // 内容不足:隐藏 thumb(display 而非 opacity,避免占位/可交互)
  if (scrollHeight <= clientHeight + 1) {
    thumb.style.display = 'none'
    return
  }
  thumb.style.display = ''

  const ratio = clientHeight / scrollHeight
  const thumbH = Math.max(ratio * clientHeight, THUMB_MIN_HEIGHT)
  const maxScroll = scrollHeight - clientHeight
  const topRatio = maxScroll > 0 ? scrollTop / maxScroll : 0
  const maxTop = clientHeight - thumbH

  // position:fixed 相对 viewport,需读容器的视口坐标算 thumb 屏幕位置
  const rect = el.getBoundingClientRect()
  thumb.style.height = `${thumbH}px`
  thumb.style.top = `${rect.top + topRatio * maxTop}px`
  thumb.style.left = `${rect.right - THUMB_WIDTH - THUMB_GAP}px`
}

function attachVeloScroll(el: HTMLElement): void {
  el.classList.add('velo-scroll')

  const thumb = document.createElement('div')
  thumb.className = 'velo-scroll-thumb'
  el.appendChild(thumb)

  let rafId: number | null = null
  const schedule = () => {
    if (rafId !== null) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      updateThumb(el, thumb)
    })
  }

  const onScroll = () => schedule()
  const onEnter = () => thumb.classList.add('velo-scroll-thumb-visible')
  const onLeave = () => {
    // 拖拽中鼠标可能移出容器,不隐藏
    if (states.get(el)?.drag) return
    thumb.classList.remove('velo-scroll-thumb-visible')
  }

  const onDragMove = (e: MouseEvent) => {
    const s = states.get(el)
    if (!s?.drag) return
    const { startY, startScrollTop, trackHeight } = s.drag
    const delta = e.clientY - startY
    const scrollRatio = trackHeight > 0 ? delta / trackHeight : 0
    el.scrollTop = startScrollTop + scrollRatio * (el.scrollHeight - el.clientHeight)
  }

  const onDragEnd = () => {
    const s = states.get(el)
    if (s) s.drag = null
    thumb.classList.remove('velo-scroll-thumb-dragging')
    document.removeEventListener('mousemove', onDragMove)
    document.removeEventListener('mouseup', onDragEnd)
  }

  const onThumbDown = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const { scrollHeight, clientHeight } = el
    const ratio = clientHeight / scrollHeight
    const thumbH = Math.max(ratio * clientHeight, THUMB_MIN_HEIGHT)
    const trackHeight = clientHeight - thumbH
    const s = states.get(el)
    if (s) s.drag = { startY: e.clientY, startScrollTop: el.scrollTop, trackHeight }
    thumb.classList.add('velo-scroll-thumb-dragging')
    document.addEventListener('mousemove', onDragMove)
    document.addEventListener('mouseup', onDragEnd)
  }

  const onWinResize = () => schedule()

  // ResizeObserver:容器尺寸变(窗口 resize / splitter 拖动)→ 重算 thumb
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => schedule())
    : null
  ro?.observe(el)

  // MutationObserver:内容 DOM 增删(文件树展开/搜索结果)→ scrollHeight 变 → 重算
  const mo = typeof MutationObserver !== 'undefined'
    ? new MutationObserver(() => schedule())
    : null
  mo?.observe(el, { childList: true, subtree: true })

  el.addEventListener('scroll', onScroll, { passive: true })
  el.addEventListener('mouseenter', onEnter)
  el.addEventListener('mouseleave', onLeave)
  thumb.addEventListener('mousedown', onThumbDown)
  window.addEventListener('resize', onWinResize)

  const state: ScrollState = {
    thumb,
    drag: null,
    onScroll,
    onEnter,
    onLeave,
    onThumbDown,
    onDragMove,
    onDragEnd,
    onWinResize,
    ro,
    mo,
    cancelRaf: () => { if (rafId !== null) cancelAnimationFrame(rafId) },
  }
  states.set(el, state)

  schedule()
}

function detachVeloScroll(el: HTMLElement): void {
  const s = states.get(el)
  if (!s) return
  el.removeEventListener('scroll', s.onScroll)
  el.removeEventListener('mouseenter', s.onEnter)
  el.removeEventListener('mouseleave', s.onLeave)
  s.thumb.removeEventListener('mousedown', s.onThumbDown)
  document.removeEventListener('mousemove', s.onDragMove)
  document.removeEventListener('mouseup', s.onDragEnd)
  window.removeEventListener('resize', s.onWinResize)
  s.ro?.disconnect()
  s.mo?.disconnect()
  s.cancelRaf()
  s.thumb.remove()
  el.classList.remove('velo-scroll')
  states.delete(el)
}

export const vVeloScroll: Directive<HTMLElement> = {
  mounted: (el) => attachVeloScroll(el),
  unmounted: (el) => detachVeloScroll(el),
}

export { attachVeloScroll, detachVeloScroll }
