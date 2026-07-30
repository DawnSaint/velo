import { onActivated, onBeforeUnmount, onDeactivated, onMounted } from 'vue'

/**
 * 视口约束：把菜单坐标 clamp 到视口内，贴边留 8px 安全距。
 */
export function clampToViewport(
  clientX: number,
  clientY: number,
  menuW: number,
  menuH: number,
): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(clientX, window.innerWidth - menuW - 8)),
    y: Math.max(8, Math.min(clientY, window.innerHeight - menuH - 8)),
  }
}

/**
 * 右键菜单全局 listener 管理。
 *
 * 统一管「点外部关闭」+「Escape 关闭」的 document 级 pointerdown(capture) +
 * keydown listener，消除各父组件（TabBar / ActivityBar / AssetPanel / FileTree）
 * 各写一份的重复。
 *
 * **不持有菜单状态**——调用方自管 ref（`contextMenu` / `closeContextMenu`），
 * 本 composable 只通过 getter / callback 与之交互。这样各菜单的 data 结构
 * （tabId / node / absPath…）保持原样，不引入泛型间接层。
 *
 * 生命周期：`onMounted` + `onActivated` 注册，`onBeforeUnmount` + `onDeactivated`
 * 卸载，内部 guard 防重复。KeepAlive 场景（FileTree / AssetPanel 在 Sidebar 内）
 * 也正确处理。
 *
 * 与父组件自有 listener 共存：FileTree 的 `onGlobalPointerDown` 还管行内 input
 * 提交，两份 listener 各自检查自己的状态（inline input 激活时 menu 必为 null，
 * 反之亦然），互不干扰。
 */
export function useContextMenu(opts: {
  /** 菜单是否打开 —— 没开时 listener 快速 return */
  isOpen: () => boolean
  /** 菜单 DOM 根元素 —— 用于判定「点内部不关闭」 */
  getMenuEl: () => HTMLElement | null
  /** 关闭菜单 */
  close: () => void
}): void {
  function onGlobalPointerDown(event: PointerEvent) {
    if (!opts.isOpen()) return
    const target = event.target as Node | null
    if (!target) return
    const menuEl = opts.getMenuEl()
    if (menuEl && (menuEl === target || menuEl.contains(target))) return
    opts.close()
  }

  function onGlobalKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && opts.isOpen()) opts.close()
  }

  let attached = false

  function attach() {
    if (attached) return
    document.addEventListener('pointerdown', onGlobalPointerDown, true)
    document.addEventListener('keydown', onGlobalKeydown)
    attached = true
  }

  function detach() {
    if (!attached) return
    document.removeEventListener('pointerdown', onGlobalPointerDown, true)
    document.removeEventListener('keydown', onGlobalKeydown)
    attached = false
  }

  onMounted(attach)
  onActivated(attach)
  onDeactivated(detach)
  onBeforeUnmount(detach)
}
