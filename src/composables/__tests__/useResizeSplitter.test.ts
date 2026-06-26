import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useResizeSplitter } from '../useResizeSplitter'

// jsdom 默认 window.innerWidth 是 1024,通过 setter 改 —— 走 Object.defineProperty
function setWindowInnerWidth(n: number) {
  Object.defineProperty(window, 'innerWidth', { value: n, configurable: true, writable: true })
}

describe('useResizeSplitter', () => {
  beforeEach(() => {
    setWindowInnerWidth(1200)
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
  })

  it('拖右 → 宽度增加,clamp 到 max', async () => {
    const width = ref(300)
    const onCommit = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      const { startDrag } = useResizeSplitter({ width, min: 200, max: 600, onCommit })
      startDrag(new MouseEvent('mousedown', { button: 0, clientX: 100 }))
      // 拖到 clientX=400 → dx=+300 → 期望 600(clamp)
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }))
    })
    await nextTick()
    await new Promise(r => requestAnimationFrame(r))
    expect(width.value).toBe(600)
    expect(onCommit).toHaveBeenCalledWith(600)
    scope.stop()
  })

  it('拖左 → 宽度减少,clamp 到 min', async () => {
    const width = ref(300)
    const onCommit = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      const { startDrag } = useResizeSplitter({ width, min: 200, max: 600, onCommit })
      startDrag(new MouseEvent('mousedown', { button: 0, clientX: 400 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200 }))
    })
    await nextTick()
    await new Promise(r => requestAnimationFrame(r))
    expect(width.value).toBe(200)
    expect(onCommit).toHaveBeenCalledWith(200)
    scope.stop()
  })

  it('mouseup 后 mousemove 不再生效', async () => {
    const width = ref(300)
    const onCommit = vi.fn()
    const scope = effectScope()
    let startDragFn: ((e: MouseEvent) => void) | null = null
    scope.run(() => {
      const r = useResizeSplitter({ width, min: 200, max: 600, onCommit })
      startDragFn = r.startDrag
    })
    startDragFn!(new MouseEvent('mousedown', { button: 0, clientX: 100 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200 }))
    await new Promise(r => requestAnimationFrame(r))
    expect(width.value).toBe(400)
    const callsAfterFirstMove = onCommit.mock.calls.length

    // mouseup 后再 mousmove 应该被忽略
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 200 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 }))
    await new Promise(r => requestAnimationFrame(r))
    expect(width.value).toBe(400)
    expect(onCommit.mock.calls.length).toBe(callsAfterFirstMove)
    scope.stop()
  })

  it('右键 mousedown 不触发拖拽', async () => {
    const width = ref(300)
    const onCommit = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      const { startDrag, isDragging } = useResizeSplitter({ width, min: 200, max: 600, onCommit })
      startDrag(new MouseEvent('mousedown', { button: 2, clientX: 100 }))
      expect(isDragging.value).toBe(false)
    })
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }))
    await new Promise(r => requestAnimationFrame(r))
    expect(width.value).toBe(300)
    expect(onCommit).not.toHaveBeenCalled()
    scope.stop()
  })

  it('拖拽中 body cursor = col-resize + user-select = none,end 后恢复', async () => {
    const width = ref(300)
    const scope = effectScope()
    scope.run(() => {
      const { startDrag } = useResizeSplitter({ width, min: 200, max: 600 })
      startDrag(new MouseEvent('mousedown', { button: 0, clientX: 100 }))
      expect(document.body.style.cursor).toBe('col-resize')
      expect(document.body.style.userSelect).toBe('none')
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 100 }))
      expect(document.body.style.cursor).toBe('')
      expect(document.body.style.userSelect).toBe('')
    })
    scope.stop()
  })

  it('窗口 resize 低于阈值 → onCollapse 调一次', async () => {
    const onCollapse = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      useResizeSplitter({ width: ref(300), min: 200, max: 600, collapseBelow: 800, onCollapse })
    })
    expect(onCollapse).not.toHaveBeenCalled()
    setWindowInnerWidth(700)
    window.dispatchEvent(new Event('resize'))
    expect(onCollapse).toHaveBeenCalledTimes(1)
    // 连续多次 resize 仍低于 → 不重复触发
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    expect(onCollapse).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('窗口 resize 回上 → 出区;再次进入阈值区 → onCollapse 再调', async () => {
    const onCollapse = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      useResizeSplitter({ width: ref(300), min: 200, max: 600, collapseBelow: 800, onCollapse })
    })
    setWindowInnerWidth(700)
    window.dispatchEvent(new Event('resize'))
    expect(onCollapse).toHaveBeenCalledTimes(1)
    setWindowInnerWidth(1200)
    window.dispatchEvent(new Event('resize'))
    expect(onCollapse).toHaveBeenCalledTimes(1) // 出区不触发
    setWindowInnerWidth(600)
    window.dispatchEvent(new Event('resize'))
    expect(onCollapse).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('mount 时窗口已经低于阈值 → onCollapse 立即触发', async () => {
    const onCollapse = vi.fn()
    setWindowInnerWidth(500)
    const scope = effectScope()
    scope.run(() => {
      useResizeSplitter({ width: ref(300), min: 200, max: 600, collapseBelow: 800, onCollapse })
    })
    expect(onCollapse).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('不传 collapseBelow → resize 不触发 onCollapse', async () => {
    const onCollapse = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      useResizeSplitter({ width: ref(300), min: 200, max: 600, onCollapse })
    })
    setWindowInnerWidth(400)
    window.dispatchEvent(new Event('resize'))
    expect(onCollapse).not.toHaveBeenCalled()
    scope.stop()
  })

  it('scope dispose → 移除 resize 监听与 body 样式', async () => {
    const onCollapse = vi.fn()
    const width = ref(300)
    const scope = effectScope()
    scope.run(() => {
      const { startDrag } = useResizeSplitter({ width, min: 200, max: 600, collapseBelow: 800, onCollapse })
      startDrag(new MouseEvent('mousedown', { button: 0, clientX: 100 }))
    })
    expect(document.body.style.cursor).toBe('col-resize')
    scope.stop()
    // dispose 后 resize 监听被移除,onCollapse 不再被触发
    setWindowInnerWidth(500)
    window.dispatchEvent(new Event('resize'))
    expect(onCollapse).not.toHaveBeenCalled()
    // body 样式也清掉
    expect(document.body.style.cursor).toBe('')
  })

  // ========== dragCollapseBelow(v0.5.5,VSCode / Obsidian 风格拖拽过窄自动收起) ==========

  it('拖拽到 dragCollapseBelow 之下 → onDragCollapse 调一次', async () => {
    const onDragCollapse = vi.fn()
    const width = ref(300)
    const onCommit = vi.fn()
    const scope = effectScope()
    scope.run(() => {
      const { startDrag } = useResizeSplitter({
        width,
        min: 0,
        max: 600,
        onCommit,
        dragCollapseBelow: 80,
        onDragCollapse,
      })
      startDrag(new MouseEvent('mousedown', { button: 0, clientX: 400 }))
      // 拖到 clientX=200 → dx=-200 → 期望 100(>80,不触发)
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200 }))
      expect(onDragCollapse).not.toHaveBeenCalled()
      // 继续拖到 clientX=100 → dx=-300 → 期望 0(<80,触发)
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
      expect(onDragCollapse).toHaveBeenCalledTimes(1)
    })
    await new Promise(r => requestAnimationFrame(r))
    // onCommit 在 rAF 里跑 —— 这里 width 已经被写入 0
    expect(width.value).toBe(0)
    expect(onCommit).toHaveBeenLastCalledWith(0)
    scope.stop()
  })

  it('onDragCollapse 去重 —— 拖到阈值之下多次 mousemove 只 fire 一次', async () => {
    const onDragCollapse = vi.fn()
    const width = ref(300)
    const scope = effectScope()
    scope.run(() => {
      const { startDrag } = useResizeSplitter({
        width,
        min: 0,
        max: 600,
        dragCollapseBelow: 80,
        onDragCollapse,
      })
      startDrag(new MouseEvent('mousedown', { button: 0, clientX: 400 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
    })
    expect(onDragCollapse).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('dragCollapseBelow 出区(回到阈值之上)→ 复位,下次再次进入能再 fire', async () => {
    const onDragCollapse = vi.fn()
    const width = ref(300)
    const scope = effectScope()
    scope.run(() => {
      const { startDrag } = useResizeSplitter({
        width,
        min: 0,
        max: 600,
        dragCollapseBelow: 80,
        onDragCollapse,
      })
      startDrag(new MouseEvent('mousedown', { button: 0, clientX: 400 }))
      // 进入区
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
      expect(onDragCollapse).toHaveBeenCalledTimes(1)
      // 出区
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }))
      // 再进区
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
      expect(onDragCollapse).toHaveBeenCalledTimes(2)
    })
    scope.stop()
  })

  it('dragCollapseBelow 出区 → onDragReopen 调一次(VSCode / Obsidian drag-reopen 行为)', async () => {
    const onDragCollapse = vi.fn()
    const onDragReopen = vi.fn()
    const width = ref(300)
    const scope = effectScope()
    scope.run(() => {
      const { startDrag } = useResizeSplitter({
        width,
        min: 0,
        max: 600,
        dragCollapseBelow: 80,
        onDragCollapse,
        onDragReopen,
      })
      startDrag(new MouseEvent('mousedown', { button: 0, clientX: 400 }))
      // 进入区:onDragCollapse fire,onDragReopen 不动
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
      expect(onDragCollapse).toHaveBeenCalledTimes(1)
      expect(onDragReopen).toHaveBeenCalledTimes(0)
      // 出区:onDragReopen fire 一次
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }))
      expect(onDragReopen).toHaveBeenCalledTimes(1)
    })
    scope.stop()
  })

  it('dragCollapseBelow 进入 → 退出 → 再进入 序列:onDragCollapse / onDragReopen 交替 fire', async () => {
    const onDragCollapse = vi.fn()
    const onDragReopen = vi.fn()
    const width = ref(300)
    const scope = effectScope()
    scope.run(() => {
      const { startDrag } = useResizeSplitter({
        width,
        min: 0,
        max: 600,
        dragCollapseBelow: 80,
        onDragCollapse,
        onDragReopen,
      })
      startDrag(new MouseEvent('mousedown', { button: 0, clientX: 400 }))
      // 1) enter
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
      expect(onDragCollapse).toHaveBeenCalledTimes(1)
      expect(onDragReopen).toHaveBeenCalledTimes(0)
      // 2) exit
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }))
      expect(onDragCollapse).toHaveBeenCalledTimes(1)
      expect(onDragReopen).toHaveBeenCalledTimes(1)
      // 3) re-enter
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50 }))
      expect(onDragCollapse).toHaveBeenCalledTimes(2)
      expect(onDragReopen).toHaveBeenCalledTimes(1)
      // 4) re-exit
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }))
      expect(onDragCollapse).toHaveBeenCalledTimes(2)
      expect(onDragReopen).toHaveBeenCalledTimes(2)
    })
    scope.stop()
  })

  it('拖到 0 多次 mousemove 都保持 collapse 区:onDragReopen 不动(只在"跨边界"那一拍 fire)', async () => {
    const onDragCollapse = vi.fn()
    const onDragReopen = vi.fn()
    const width = ref(300)
    const scope = effectScope()
    scope.run(() => {
      const { startDrag } = useResizeSplitter({
        width,
        min: 0,
        max: 600,
        dragCollapseBelow: 80,
        onDragCollapse,
        onDragReopen,
      })
      startDrag(new MouseEvent('mousedown', { button: 0, clientX: 400 }))
      // 在 collapse 区里来回,只要不跨过阈值就不算 exit
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 50 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 30 }))
      expect(onDragCollapse).toHaveBeenCalledTimes(1)
      expect(onDragReopen).toHaveBeenCalledTimes(0)
    })
    scope.stop()
  })

  it('不传 onDragReopen → 出区也不报错,行为等价于只 fire onDragCollapse', async () => {
    const onDragCollapse = vi.fn()
    const width = ref(300)
    const scope = effectScope()
    expect(() => {
      scope.run(() => {
        const { startDrag } = useResizeSplitter({
          width,
          min: 0,
          max: 600,
          dragCollapseBelow: 80,
          onDragCollapse,
          // 注意:故意不传 onDragReopen
        })
        startDrag(new MouseEvent('mousedown', { button: 0, clientX: 400 }))
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }))
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
      })
    }).not.toThrow()
    expect(onDragCollapse).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('dragCollapseBelow 触发后 mouseup + 再次 startDrag → 重置 dedupe 可再次触发', async () => {
    const onDragCollapse = vi.fn()
    const width = ref(300)
    const scope = effectScope()
    let startDragFn: ((e: MouseEvent) => void) | null = null
    scope.run(() => {
      const r = useResizeSplitter({
        width,
        min: 0,
        max: 600,
        dragCollapseBelow: 80,
        onDragCollapse,
      })
      startDragFn = r.startDrag
    })
    // 第一次拖拽:触发 collapse
    startDragFn!(new MouseEvent('mousedown', { button: 0, clientX: 400 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 100 }))
    expect(onDragCollapse).toHaveBeenCalledTimes(1)
    // 第二次拖拽:同样路径,startDrag 重置 wasDragCollapsed,能再次触发
    startDragFn!(new MouseEvent('mousedown', { button: 0, clientX: 400 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
    expect(onDragCollapse).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('min 默认 0(不传 min)→ 允许拖到 0', async () => {
    const width = ref(300)
    const scope = effectScope()
    scope.run(() => {
      const { startDrag } = useResizeSplitter({ width, max: 600 })
      startDrag(new MouseEvent('mousedown', { button: 0, clientX: 400 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
    })
    await new Promise(r => requestAnimationFrame(r))
    expect(width.value).toBe(0)
    scope.stop()
  })

  it('不传 dragCollapseBelow → 拖到 0 也不触发 onDragCollapse', async () => {
    const onDragCollapse = vi.fn()
    const width = ref(300)
    const scope = effectScope()
    scope.run(() => {
      const { startDrag } = useResizeSplitter({ width, min: 0, max: 600, onDragCollapse })
      startDrag(new MouseEvent('mousedown', { button: 0, clientX: 400 }))
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
    })
    expect(onDragCollapse).not.toHaveBeenCalled()
    scope.stop()
  })
})