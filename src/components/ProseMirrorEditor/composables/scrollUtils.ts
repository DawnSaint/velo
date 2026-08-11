/**
 * 从 `start` 向上找第一个 overflow:auto|scroll 的祖先。用于"切换文档时复位
 * viewport 滚动位置" —— view.dom 自身不带 overflow,真实滚动容器在上层
 * (css class 例如 Tailwind 的 `overflow-auto`)。
 *
 * 通过 getComputedStyle 读 css(包括 class-based 规则),不仅 inline style。
 * 找遍到 html/body 仍没找到返回 null(caller 视情况退化处理)。
 *
 * 从 useProseMirror.ts 抽出以消除 useProseMirror ↔ viewportPlugin 的循环依赖。
 */
export function findScrollAncestor(start: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = start
  while (cur && cur !== cur.parentElement) {
    const cs = getComputedStyle(cur)
    if (
      cs.overflowY === 'auto' || cs.overflowY === 'scroll'
      || cs.overflow === 'auto' || cs.overflow === 'scroll'
    ) {
      return cur
    }
    cur = cur.parentElement
  }
  return null
}
