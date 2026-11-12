import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useConfirmStore } from '../confirm'

describe('confirm store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('ask 生成待决请求,confirm 结算 true 并清空', async () => {
    const store = useConfirmStore()
    const result = store.ask({
      title: '工作区目录已失效',
      message: '该文件夹已不存在',
      detail: 'C:/桌面/test',
      confirmText: '从列表移除',
      kind: 'warning',
    })

    expect(store.current).toMatchObject({
      title: '工作区目录已失效',
      message: '该文件夹已不存在',
      detail: 'C:/桌面/test',
      confirmText: '从列表移除',
      cancelText: '取消',
      kind: 'warning',
    })

    store.confirm()
    await expect(result).resolves.toBe(true)
    expect(store.current).toBeNull()
  })

  it('cancel 结算 false', async () => {
    const store = useConfirmStore()
    const result = store.ask({ title: 't', message: 'm', kind: 'danger' })
    expect(store.current?.kind).toBe('danger')
    store.cancel()
    await expect(result).resolves.toBe(false)
    expect(store.current).toBeNull()
  })

  it('并发 ask 把上一个按 false 结算,不留悬挂 promise', async () => {
    const store = useConfirmStore()
    const first = store.ask({ title: 'first', message: 'm' })
    const second = store.ask({ title: 'second', message: 'm' })

    await expect(first).resolves.toBe(false)
    expect(store.current?.title).toBe('second')
    store.confirm()
    await expect(second).resolves.toBe(true)
  })

  it('重复 settle 不二次结算', async () => {
    const store = useConfirmStore()
    const result = store.ask({ title: 't', message: 'm' })
    store.cancel()
    store.confirm()
    await expect(result).resolves.toBe(false)
  })
})
