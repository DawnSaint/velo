// B3 NodeView 延迟创建：用共享 IntersectionObserver 让昂贵的 KaTeX 渲染
// 延迟到节点进入视口才执行，滚出视口后由调用方缓存 innerHTML 并销毁昂贵 DOM。
//
// 设计要点：
// - 一个 observer 服务所有 math NodeView（浏览器内部 coalesce 回调，远比
//   每节点一个 observer 高效）
// - rootMargin 与 viewportPlugin 的 BUFFER_PX(1000px) 对齐：节点要滚出视口
//   1000px 以外才触发销毁，快速滚动时空白/重渲染窗口极小
// - root: null（浏览器视口）—— Velo 编辑器主区填满窗口，真实滚动容器 ≈ 视口；
//   NodeView 工厂拿不到滚动容器引用，视口 root 足够精确
// - jsdom / 无 IO 环境：observeLazy 同步调 handler(true) 立即渲染，行为同
//   旧实现（测试与"无滚动容器"兜底都不缺席渲染）

type LazyHandler = (isIntersecting: boolean) => void

let observer: IntersectionObserver | null = null
const handlers = new WeakMap<Element, LazyHandler>()

/** 视口上下 buffer（像素），与 viewportPlugin 的 BUFFER_PX 对齐。 */
const ROOT_MARGIN = '1000px 0px'

function ensureObserver(): IntersectionObserver | null {
  if (observer) return observer
  if (typeof IntersectionObserver === 'undefined') return null
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const handler = handlers.get(entry.target)
      if (handler) handler(entry.isIntersecting)
    }
  }, { rootMargin: ROOT_MARGIN })
  return observer
}

/**
 * 观察 `el` 的视口可见性，可见性变化时调 `handler(isIntersecting)`。
 * 无 IntersectionObserver 时（jsdom / SSR）同步调 `handler(true)` 立即渲染。
 */
export function observeLazy(el: HTMLElement, handler: LazyHandler): void {
  const obs = ensureObserver()
  handlers.set(el, handler)
  if (!obs) {
    handler(true)
    return
  }
  obs.observe(el)
}

/** 停止观察 `el`（NodeView destroy 时调）。 */
export function unobserveLazy(el: HTMLElement): void {
  const obs = ensureObserver()
  if (obs) obs.unobserve(el)
  handlers.delete(el)
}
