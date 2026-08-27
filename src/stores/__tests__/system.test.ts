import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSystemStore } from '../system'

describe('system store 自动更新设置', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('autoUpdateEnabled 默认开启', () => {
    const store = useSystemStore()
    expect(store.autoUpdateEnabled).toBe(true)
  })

  it('hydrate：合法布尔值覆盖默认值', () => {
    const store = useSystemStore()
    store.hydrateSettings({ autoUpdateEnabled: false })
    expect(store.autoUpdateEnabled).toBe(false)
  })

  it('hydrate：非法值忽略,保持当前值', () => {
    const store = useSystemStore()
    store.autoUpdateEnabled = false
    store.hydrateSettings({ autoUpdateEnabled: 'yes' as unknown as boolean })
    expect(store.autoUpdateEnabled).toBe(false)
  })

  it('hydrate：旧设置文件无 system 节(undefined)保持默认', () => {
    const store = useSystemStore()
    store.hydrateSettings(undefined)
    expect(store.autoUpdateEnabled).toBe(true)
  })

  it('snapshot：序列化当前开关状态', () => {
    const store = useSystemStore()
    store.autoUpdateEnabled = false
    expect(store.snapshotSettings()).toEqual({ autoUpdateEnabled: false })
  })

  it('snapshot → hydrate 往返一致', () => {
    const store = useSystemStore()
    store.autoUpdateEnabled = false
    const snap = store.snapshotSettings()
    setActivePinia(createPinia())
    const restored = useSystemStore()
    restored.hydrateSettings(snap)
    expect(restored.autoUpdateEnabled).toBe(false)
  })
})
