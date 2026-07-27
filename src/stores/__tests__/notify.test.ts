// notify store 合约测试:push / dismiss / 自动消失 / 上限。
//
// 与 document / export store 测试同款:setActivePinia + fake timers。

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useNotifyStore } from '../notify'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useNotifyStore', () => {
  it('success / info / warning / error 各推一条 toast，类型正确', () => {
    const store = useNotifyStore()
    store.success('ok')
    store.info('hi')
    store.warning('warn')
    store.error('bad')

    expect(store.toasts).toHaveLength(4)
    expect(store.toasts[0]).toMatchObject({ type: 'success', message: 'ok' })
    expect(store.toasts[1]).toMatchObject({ type: 'info', message: 'hi' })
    expect(store.toasts[2]).toMatchObject({ type: 'warning', message: 'warn' })
    expect(store.toasts[3]).toMatchObject({ type: 'error', message: 'bad' })
  })

  it('每条 toast 有唯一递增 id', () => {
    const store = useNotifyStore()
    store.success('a')
    store.success('b')
    const ids = store.toasts.map(t => t.id)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    expect(ids[1]).toBeGreaterThan(ids[0])
  })

  it('默认 duration 按 type 分配(error 久于 success)', () => {
    const store = useNotifyStore()
    store.success('s')
    store.error('e')
    const s = store.toasts.find(t => t.type === 'success')!
    const e = store.toasts.find(t => t.type === 'error')!
    expect(s.duration).toBeLessThan(e.duration)
    expect(s.duration).toBeGreaterThan(0)
  })

  it('自定义 duration 覆盖默认值', () => {
    const store = useNotifyStore()
    store.success('custom', 1000)
    expect(store.toasts[0].duration).toBe(1000)
  })

  it('duration=0 表示不自动消失', () => {
    const store = useNotifyStore()
    store.info('persistent', 0)
    expect(store.toasts[0].duration).toBe(0)
    vi.advanceTimersByTime(999_999)
    expect(store.toasts).toHaveLength(1) // 仍在列表
  })

  it('到时自动 dismiss', () => {
    const store = useNotifyStore()
    store.success('bye', 3000)
    expect(store.toasts).toHaveLength(1)
    vi.advanceTimersByTime(3000)
    expect(store.toasts).toHaveLength(0)
  })

  it('手动 dismiss(id) 移除指定 toast', () => {
    const store = useNotifyStore()
    store.success('keep')
    store.success('remove')
    const idToRemove = store.toasts[1].id
    store.dismiss(idToRemove)
    expect(store.toasts).toHaveLength(1)
    expect(store.toasts[0].message).toBe('keep')
  })

  it('dismiss 不存在的 id 是 no-op', () => {
    const store = useNotifyStore()
    store.success('only')
    store.dismiss(99999)
    expect(store.toasts).toHaveLength(1)
  })

  it('超过上限(5)时移除最早的', () => {
    const store = useNotifyStore()
    for (let i = 0; i < 7; i++) store.info(`msg-${i}`, 0)
    // 上限 5，最早的 2 条被移除
    expect(store.toasts).toHaveLength(5)
    expect(store.toasts[0].message).toBe('msg-2')
    expect(store.toasts[4].message).toBe('msg-6')
  })
})
