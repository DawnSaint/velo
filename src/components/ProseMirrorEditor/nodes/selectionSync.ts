// atom 节点选中态同步工具 —— 供 image / hr / math_block / html_block NodeView 共用。
//
// 三种选中场景:
//   1. NodeSelection 直接选中 → NodeView selectNode/deselectNode 钩子触发 syncSelected
//   2. 鼠标拖蓝 range 选区覆盖节点 → selectionchange(延迟 rAF)触发 syncSelected
//   3. 鼠标拖蓝经过 atom 但选区尚未扩展到节点位置 → mouseenter/mouseleave
//      即时触发 syncSelected(场景 3 是所有 contenteditable=false atom 的共性问题:
//      浏览器无法将选区端点放入节点内部,selectionchange 不触发或不覆盖节点)
//
// 核心设计:
// - 拖蓝期间不检查 PM state(PM 对 DOM selection 的同步是异步 rAF,拖蓝时 state
//   滞后),只用 DOM selection(即时)+ mouseInNode(触碰即选中)
// - 拖蓝期间鼠标进入节点 → extendDomSelectionToNode 把 DOM 选区焦点扩展到节点边界,
//   让浏览器即时高亮拖动起点到节点之间的文字(快拖时浏览器来不及扩展选区,中间文字
//   不会被高亮,产生视觉断层)。mousemove 在节点内持续 re-extend(浏览器每次
//   mousemove 会从 anchor 重新计算选区,可能覆盖我们的扩展)
// - 松开时鼠标在节点上 → 扩展 PM 选区把节点纳入(extendSelectionToNode),让选区
//   变成"真"的:Delete/Backspace 走 PM 默认 range 删除时会连节点一起删。不扩展的话
//   选区端点停在节点前(pos),节点不在选区内 → 按删除只删文字不删节点
// - dragEndedOnNode 粘性标志在扩展前 bridging 视觉态(mouseup 到双 rAF 之间的间隙)
// - mouseleave 非拖蓝时不触发 syncSelected —— 让粘性状态保持到选区真正变化

import { TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'

export interface SelectionSyncOptions {
  /** NodeView 的根 DOM 元素 */
  dom: HTMLElement
  /** ProseMirror EditorView */
  view: EditorView
  /** 获取节点当前位置的函数(NodeView 工厂参数) */
  getPos: () => number | undefined
  /** 获取当前节点引用(用于读取 nodeSize) */
  getNode: () => PMNode
  /** 返回 true 时跳过选中态(如 math_block 编辑态) */
  skipSelected?: () => boolean
}

export interface SelectionSync {
  /** 重新计算并同步 .selected class */
  syncSelected: () => void
  /** 移除所有监听器,在 NodeView destroy 中调用 */
  destroy: () => void
}

export function createSelectionSync(opts: SelectionSyncOptions): SelectionSync {
  const { dom, view, getPos, getNode, skipSelected } = opts

  let mouseInNode = false
  let isDragging = false
  // 粘性标志:mouseup 时鼠标在节点上 → true,保持选中直到选区变化
  let dragEndedOnNode = false

  // DOM 选区与节点纵向重叠判断。
  // 只判纵向:鼠标从上方快速拖到 atom 行时,浏览器把选区映射到 atom 位置,
  // Range.getBoundingClientRect() 返回的矩形只到节点左边缘,横向重叠会失败。纵向
  // 重叠只需选区跨到节点所在行即触发,符合"拖到本行即高亮"语义。
  function isDomSelectionOverlapping(): boolean {
    const sel = view.dom.ownerDocument.getSelection()
    if (!sel || sel.rangeCount === 0) return false
    const range = sel.getRangeAt(0)
    if (range.collapsed) return false
    const selRect = range.getBoundingClientRect()
    if (selRect.width === 0 && selRect.height === 0) return false
    const nodeRect = dom.getBoundingClientRect()
    return selRect.bottom > nodeRect.top && selRect.top < nodeRect.bottom
  }

  // PM state 选区重叠判断(覆盖 NodeSelection 直接选中 + 键盘移动光标场景)。
  function isPmSelectionOverlapping(): boolean {
    const pos = getPos()
    if (pos === undefined || pos < 0) return false
    const sel = view.state.selection
    const node = getNode()
    return sel.to >= pos && sel.from < pos + node.nodeSize
  }

  function hasNonCollapsedSelection(): boolean {
    const sel = view.dom.ownerDocument.getSelection()
    return !!sel && sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed
  }

  function syncSelected() {
    if (skipSelected?.()) {
      dom.classList.remove('selected')
      return
    }
    const domOverlapping = isDomSelectionOverlapping()
    // 拖蓝期间 PM state 滞后(异步 rAF 同步),不检查;松开后 PM state 可靠。
    const pmOverlapping = !isDragging && isPmSelectionOverlapping()
    // 鼠标触碰补丁:所有 contenteditable=false atom 的共性问题 —— 选区端点进不了
    // 节点内部。拖蓝期间用 mouseInNode(触碰即选中),松开后用 dragEndedOnNode
    // (粘性:松开时鼠标在节点上就保持选中,直到选区变化)。
    const mouseOverlapping = hasNonCollapsedSelection() && (
      (isDragging && mouseInNode) || (!isDragging && dragEndedOnNode)
    )
    dom.classList.toggle('selected', domOverlapping || pmOverlapping || mouseOverlapping)
  }

  // selectionchange 延迟 rAF:PM 的 selectionchange 监听器先执行(注册更早)并
  // 调度 rAF 同步 state,我们的 rAF 排在其后 → 读到已同步的 PM state。
  // 选区变为 collapsed(用户点击别处放置光标)时清除粘性标志。
  const onSelectionChange = () => requestAnimationFrame(() => {
    const sel = view.dom.ownerDocument.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.getRangeAt(0).collapsed) {
      dragEndedOnNode = false
    }
    syncSelected()
  })

  const onMouseDown = () => {
    isDragging = true
    dragEndedOnNode = false
  }

  // 双 rAF:第一帧让 PM 调度同步,第二帧让 PM 同步完成。
  // 松开时鼠标在节点上 → 设置粘性标志(bridging 视觉态),并扩展 PM 选区把节点纳入,
  // 使 Delete/Backspace 能删掉节点。dragEndedOnNode 在扩展完成后由 isPmSelectionOverlapping
  // 接管(选区已真正覆盖节点),选区 collapsed 时清除。
  const onMouseUp = () => {
    const endedOnNode = mouseInNode
    if (endedOnNode) dragEndedOnNode = true
    isDragging = false
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (endedOnNode) extendSelectionToNode()
      syncSelected()
    }))
  }

  // 扩展 PM 选区把节点纳入:contenteditable=false atom 的选区端点停在节点边界(pos
  // 或 pos+nodeSize),节点不在选区内。把 from/to 扩展到覆盖 [pos, pos+nodeSize],
  // 使 Delete/Backspace 的默认 range 删除连节点一起删。仅在编辑模式 + 非空选区时执行。
  function extendSelectionToNode() {
    if (!view.editable) return
    const pos = getPos()
    if (pos === undefined || pos < 0) return
    const node = getNode()
    const nodeEnd = pos + node.nodeSize
    const sel = view.state.selection
    if (sel.empty) return
    // 已覆盖节点 → 无需扩展
    if (sel.from <= pos && sel.to >= nodeEnd) return
    const newFrom = Math.min(sel.from, pos)
    const newTo = Math.max(sel.to, nodeEnd)
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, newFrom, newTo),
    ))
  }

  // 拖蓝期间把 DOM 选区焦点扩展到节点边界。快拖到 contenteditable=false atom 上时,
  // 浏览器无法把选区端点放入节点内部 → 选区端点卡在拖动起点附近,中间文字不被高亮。
  // 用 Selection.extend() 把焦点移到节点边界(pos 或 nodeEnd),浏览器即时高亮
  // 从 anchor 到节点边界的全部文字。仅在编辑模式 + 非折叠选区时执行。
  function extendDomSelectionToNode() {
    if (!view.editable) return
    const pos = getPos()
    if (pos === undefined || pos < 0) return
    const node = getNode()
    const nodeEnd = pos + node.nodeSize

    const sel = view.dom.ownerDocument.getSelection()
    if (!sel || !sel.anchorNode || sel.isCollapsed) return

    // 用 anchor 的 PM 位置判断拖动方向
    let anchorPos: number
    try {
      anchorPos = view.posAtDOM(sel.anchorNode, sel.anchorOffset)
    } catch {
      return
    }
    if (anchorPos < 0) return

    let targetPos: number
    if (anchorPos <= pos) {
      // 向下拖:扩展焦点到节点前
      targetPos = pos
    } else if (anchorPos >= nodeEnd) {
      // 向上拖:扩展焦点到节点后
      targetPos = nodeEnd
    } else {
      return
    }

    const domAtTarget = view.domAtPos(targetPos)
    sel.extend(domAtTarget.node, domAtTarget.offset)
  }

  // mouseenter/mouseleave 在节点 DOM 上注册:鼠标进出节点边界时即时触发。
  // 拖蓝期间:mouseenter 先扩展 DOM 选区(高亮中间文字)再 syncSelected(节点高亮);
  // mousemove 在节点内持续 re-extend(浏览器每次 mousemove 从 anchor 重新计算选区,
  // 可能覆盖我们的扩展);mouseleave 只 syncSelected(浏览器在可编辑区能自行扩展)。
  // 非拖蓝时不触发 syncSelected —— 避免破坏松开后的粘性选中态。
  const onMouseEnter = () => {
    mouseInNode = true
    if (isDragging) {
      extendDomSelectionToNode()
      syncSelected()
    }
  }
  const onMouseMoveInNode = () => {
    if (!isDragging) return
    extendDomSelectionToNode()
    syncSelected()
  }
  const onMouseLeave = () => {
    mouseInNode = false
    if (isDragging) syncSelected()
  }

  view.dom.ownerDocument.addEventListener('mousedown', onMouseDown)
  view.dom.ownerDocument.addEventListener('mouseup', onMouseUp)
  view.dom.ownerDocument.addEventListener('selectionchange', onSelectionChange)
  dom.addEventListener('mouseenter', onMouseEnter)
  dom.addEventListener('mouseleave', onMouseLeave)
  dom.addEventListener('mousemove', onMouseMoveInNode)

  function destroy() {
    view.dom.ownerDocument.removeEventListener('mousedown', onMouseDown)
    view.dom.ownerDocument.removeEventListener('mouseup', onMouseUp)
    view.dom.ownerDocument.removeEventListener('selectionchange', onSelectionChange)
    dom.removeEventListener('mouseenter', onMouseEnter)
    dom.removeEventListener('mouseleave', onMouseLeave)
    dom.removeEventListener('mousemove', onMouseMoveInNode)
  }

  return { syncSelected, destroy }
}
