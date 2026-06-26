// 通用"侧栏宽度可拖拽 + 窗口过窄自动收起 + 拖拽过窄自动收起 + 出区自动恢复"composable(v0.5.5)
//
// 接管四件事:
//   1. 拖拽手柄 mousedown → 进入 drag,window mousemove/mouseup 跟踪;写 width ref;
//      rAF 节流避免 mousemove 高频 ref 写入造成 layout thrash。
//   2. 双击手柄 → 调 onCollapse(由调用方决定怎么收起,本 composable 不耦合可见性)。
//   3. window.resize 监听:innerWidth < collapseBelow 时调一次 onCollapse
//      (wasBelow ref 去重),保证不会因为每次 resize event 都重复触发。
//   4. 拖拽到 dragCollapseBelow 之下时调一次 onDragCollapse(VSCode/Obsidian 行为):
//      拖得过窄直接收起侧栏,而不是卡死在 min。wasDragCollapsed 去重。
//      回到阈值之上时调一次 onDragReopen,让调用方把"先收起又拖回来"的侧栏
//      重新打开(VSCode/Obsidian 同款交互)。循环进入 / 退出区可多次触发。
//
// **不用 HTML5 draggable**:Tauri 即便 dragDropEnabled: false,底层仍监听
// dragenter/dragover 用作 OS 文件 drop 探测。mousedown/mousemove/mouseup
// 走纯 DOM 事件,不被 Tauri 截获,memory: tauri-2-dragdropenabled-default。

import { onScopeDispose, ref, type Ref } from 'vue'

export interface ResizeSplitterOptions {
  /** 当前宽度 ref;composable 在拖拽中写入此 ref。 */
  width: Ref<number>
  /** 拖拽下界(px,默认 0)。允许低于 SIDEBAR_WIDTH_MIN 是为了 drag-collapse 触发:
   *  调用方需要把稳定下限(SIDEBAR_WIDTH_MIN)放在 onCommit / 显示逻辑里做,
   *  本 composable 只管拖拽 raw range。 */
  min?: number
  /** 拖拽上界(px) */
  max: number
  /** 拖拽中每次 commit(rAF 节流),失败可选。
   *  通常接 store 的 setSidebarWidth —— 不传则只改 ref 不落盘。
   *  **稳定下限由调用方负责**:本 composable 不会过滤低于 SIDEBAR_WIDTH_MIN 的值,
   *  调用方需自行判断是否落盘(否则侧栏宽度会被拖到 < SIDEBAR_WIDTH_MIN 也写进 store)。 */
  onCommit?: (next: number) => void
  /** 窗口宽度低于此值时触发 onCollapse(px);不传则不监听。 */
  collapseBelow?: number
  /** 进入"窗口过窄"区时调一次,出区复位 wasBelow 让下次能再次触发。 */
  onCollapse?: () => void
  /** 拖拽宽度低于此值时触发 onDragCollapse(px);不传则拖拽全程不触发自动收起。
   *  通常 < SIDEBAR_WIDTH_MIN,让"拖到很窄 = 收起"语义生效(VSCode / Obsidian 风格)。 */
  dragCollapseBelow?: number
  /** 拖拽宽度跨过 dragCollapseBelow 下界时调一次(去重),
   *  回到阈值之上后复位 wasDragCollapsed 让下次能再次触发。
   *  与 onCollapse 是两个独立回调,因为业务上可能是同一个 handler,
   *  也可能分别处理(本项目共用)。 */
  onDragCollapse?: () => void
  /** 拖拽宽度从 dragCollapseBelow 之下回到阈值之上时调一次(去重,与 onDragCollapse
   *  配对),让调用方把"先收起又拖回来"的侧栏重新打开(VSCode / Obsidian 风格)。
   *  多次 enter / exit 循环可多次触发。不传则不响应。 */
  onDragReopen?: () => void
}

export interface ResizeSplitterReturn {
  /** 拖拽中为 true。模板用它给手柄上常亮色 + body cursor 提示。 */
  isDragging: Ref<boolean>
  /** 手柄 mousedown handler。 */
  startDrag: (e: MouseEvent) => void
  /** 手柄 dblclick handler。 */
  onSplitterDoubleClick: (e: MouseEvent) => void
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function useResizeSplitter(opts: ResizeSplitterOptions): ResizeSplitterReturn {
  const isDragging = ref(false)

  // drag state —— 仅拖拽中有效
  let dragStartX = 0
  let dragStartWidth = 0
  let rafId: number | null = null
  let pendingNext = 0

  // collapse dedupe —— 进入"窗口过窄"区只触发一次
  let wasBelow = false
  // drag-collapse dedupe —— 拖拽过窄只触发一次
  let wasDragCollapsed = false

  // 拖拽下界默认 0,让 drag-collapse 能触发到 0
  const dragMin = opts.min ?? 0

  function flushPending() {
    rafId = null
    opts.width.value = pendingNext
    opts.onCommit?.(pendingNext)
  }

  function maybeFireDragCollapse(currentWidth: number) {
    if (opts.dragCollapseBelow === undefined) return
    if (currentWidth < opts.dragCollapseBelow) {
      if (!wasDragCollapsed) {
        wasDragCollapsed = true
        opts.onDragCollapse?.()
      }
    }
    else if (wasDragCollapsed) {
      // 回到阈值之上:只在"曾经进过区"这一拍 fire onDragReopen,避免
      // 在阈值之上稳定停留时反复触发;fire 完立刻复位,让下一轮 enter/exit
      // 循环能再次触发 onDragCollapse / onDragReopen
      wasDragCollapsed = false
      opts.onDragReopen?.()
    }
  }

  function onMouseMove(e: MouseEvent) {
    if (!isDragging.value) return
    const dx = e.clientX - dragStartX
    pendingNext = clamp(dragStartWidth + dx, dragMin, opts.max)
    // drag-collapse 判定必须每次 mousemove 都跑(放在 rAF 守卫外):
    // mousemove 高频时 rafId 几乎一直非空,放在守卫内会被早 return 跳过,
    // wasDragCollapsed 就永远不会被重置 → 出区后无法再次触发。
    maybeFireDragCollapse(pendingNext)
    if (rafId !== null) return
    rafId = requestAnimationFrame(flushPending)
  }

  function endDrag() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
      // 释放前把最后一次值落盘,避免 rAF 没跑就被卸掉导致最后 1px 漂移
      flushPending()
    }
    isDragging.value = false
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', endDrag)
  }

  function startDrag(e: MouseEvent) {
    // 只响应左键,右键/中键放行让原生菜单继续可用
    if (e.button !== 0) return
    e.preventDefault()
    dragStartX = e.clientX
    dragStartWidth = opts.width.value
    pendingNext = dragStartWidth
    // 新一轮拖拽开始,重置 drag-collapse dedupe:上次拖拽如果收起过侧栏,
    // 下次拖拽如果从稳定宽度出发,不应该立刻就 fire collapse
    wasDragCollapsed = false
    isDragging.value = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', endDrag)
  }

  function onSplitterDoubleClick(_e: MouseEvent) {
    opts.onCollapse?.()
  }

  function onWindowResize() {
    if (opts.collapseBelow === undefined) return
    const below = typeof window !== 'undefined' && window.innerWidth < opts.collapseBelow
    if (below && !wasBelow) {
      wasBelow = true
      opts.onCollapse?.()
    }
    else if (!below) {
      wasBelow = false
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onWindowResize)
    // mount 时立即跑一次:启动时窗口已经 < 阈值也要自动收起
    onWindowResize()
  }

  // 组件卸载 / scope dispose 自动清场 —— body 样式 + 所有 listener
  onScopeDispose(() => {
    endDrag()
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', onWindowResize)
    }
  })

  return { isDragging, startDrag, onSplitterDoubleClick }
}