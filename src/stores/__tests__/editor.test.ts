import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useEditorStore } from '../editor'

describe('editor store 默认值', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('fontSize 默认 14px', () => {
    const store = useEditorStore()
    expect(store.fontSize).toBe('14px')
  })

  it('primaryColor 默认 Velo 蓝', () => {
    const store = useEditorStore()
    expect(store.primaryColor).toBe('#1F71D9')
  })

  it('fontFamily 默认是带中文 fallback 的系统字体栈', () => {
    const store = useEditorStore()
    expect(store.fontFamily).toContain('PingFang SC')
    expect(store.fontFamily).toContain('Microsoft YaHei')
  })

  it('darkMode 默认 false', () => {
    const store = useEditorStore()
    expect(store.darkMode).toBe(false)
  })

  it('所有 ref 可写且双向反映', () => {
    const store = useEditorStore()
    store.darkMode = true
    expect(store.darkMode).toBe(true)

    store.primaryColor = '#FF0000'
    expect(store.primaryColor).toBe('#FF0000')
  })
})
