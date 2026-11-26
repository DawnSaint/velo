import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import DiffOverviewRuler from '../DiffOverviewRuler.vue'
import type { DiffAnchor } from '@/utils/diffAnchors'

function mockClientHeight(el: HTMLElement, value: number) {
  Object.defineProperty(el, 'clientHeight', { configurable: true, value })
}

function mockScrollMetrics(el: HTMLElement, opts: { scrollHeight: number; clientHeight: number; scrollTop?: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: opts.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: opts.clientHeight })
  el.scrollTop = opts.scrollTop ?? 0
}

describe('DiffOverviewRuler (#diff-ruler)', () => {
  it('按两轨制渲染色块:removed 落左轨,added 落右轨,modified 左右双轨同时落块', async () => {
    const scroller = document.createElement('div')
    mockScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 200 })

    const anchors: DiffAnchor[] = [
      { index: 0, kind: 'added', startRatio: 0.1, endRatio: 0.15 },
      { index: 1, kind: 'removed', startRatio: 0.4, endRatio: 0.4 },
      { index: 2, kind: 'modified', startRatio: 0.7, endRatio: 0.8 },
    ]

    const wrapper = mount(DiffOverviewRuler, {
      props: { anchors, scrollElement: scroller },
    })
    mockClientHeight(wrapper.element as HTMLElement, 400)
    // 触发重测(重新挂载一个带 clientHeight 的容器或在 resize 时更新)
    // 由于 jsdom 初始 clientHeight=0,通过 props 变更前先设好原型或直接测试挂载流程
    wrapper.unmount()

    const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        if ((this as HTMLElement).hasAttribute('data-diff-ruler')) return 400
        return 200
      },
    })
    try {
      const w = mount(DiffOverviewRuler, {
        props: { anchors, scrollElement: scroller },
      })
      await nextTick()

      const delMarks = w.findAll('[data-ruler-mark="del"]')
      const addMarks = w.findAll('[data-ruler-mark="add"]')
      expect(delMarks).toHaveLength(2) // anchor 1 (removed) + anchor 2 (modified)
      expect(addMarks).toHaveLength(2) // anchor 0 (added) + anchor 2 (modified)

      // 点击色块 emit select(anchorIndex)
      await delMarks[0].trigger('mousedown')
      expect(w.emitted('select')).toEqual([[1]])

      await addMarks[1].trigger('mousedown')
      expect(w.emitted('select')).toEqual([[1], [2]])

      w.unmount()
    }
    finally {
      if (origClientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight)
      }
      else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
      }
    }
  })

  it('像素分桶合并:大量紧邻锚点会被合并,防止 DOM 节点膨胀', async () => {
    const scroller = document.createElement('div')
    mockScrollMetrics(scroller, { scrollHeight: 4000, clientHeight: 400 })

    // 100 个紧挨着的新增锚点落在 0.0..0.1 区间(40px 内)
    const anchors: DiffAnchor[] = Array.from({ length: 100 }, (_, i) => ({
      index: i,
      kind: 'added',
      startRatio: i * 0.001,
      endRatio: (i + 1) * 0.001,
    }))

    const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        if ((this as HTMLElement).hasAttribute('data-diff-ruler')) return 400
        return 400
      },
    })
    try {
      const w = mount(DiffOverviewRuler, {
        props: { anchors, scrollElement: scroller },
      })
      await nextTick()

      const addMarks = w.findAll('[data-ruler-mark="add"]')
      expect(addMarks.length).toBeLessThan(10)
      w.unmount()
    }
    finally {
      if (origClientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight)
      }
      else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
      }
    }
  })

  it('点击空白轨道直接滚动 scrollElement.scrollTop', async () => {
    const scroller = document.createElement('div')
    mockScrollMetrics(scroller, { scrollHeight: 1200, clientHeight: 200, scrollTop: 0 })

    const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        if ((this as HTMLElement).hasAttribute('data-diff-ruler')) return 400
        return 200
      },
    })
    try {
      const w = mount(DiffOverviewRuler, {
        props: {
          anchors: [{ index: 0, kind: 'added', startRatio: 0.1, endRatio: 0.2 }],
          scrollElement: scroller,
        },
      })
      await nextTick()

      const track = w.element as HTMLElement
      track.getBoundingClientRect = () => ({
        top: 0,
        bottom: 400,
        left: 0,
        right: 18,
        width: 18,
        height: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      })

      // 点击轨道中点(clientY = 200 → ratio 0.5 → scrollTop = 500)
      await w.trigger('mousedown', { clientY: 200 })
      window.dispatchEvent(new MouseEvent('mouseup'))
      expect(scroller.scrollTop).toBe(500)

      w.unmount()
    }
    finally {
      if (origClientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight)
      }
      else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
      }
    }
  })
})
