import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useEditorStore, normalizeActivityBarConfig } from '../editor'

describe('editor store 默认值', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('fontSize 默认 16px', () => {
    const store = useEditorStore()
    expect(store.fontSize).toBe('16px')
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

  it('showCodeLineNumbers 默认 false(v0.5.11 可选行号,默认关闭)', () => {
    const store = useEditorStore()
    expect(store.showCodeLineNumbers).toBe(false)
  })

  it('所有 ref 可写且双向反映', () => {
    const store = useEditorStore()
    store.darkMode = true
    expect(store.darkMode).toBe(true)

    store.primaryColor = '#FF0000'
    expect(store.primaryColor).toBe('#FF0000')

    store.showCodeLineNumbers = true
    expect(store.showCodeLineNumbers).toBe(true)
  })
})

describe('editor store ActivityBar 自定义 (v0.6.1)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('默认顺序 files/outline/search/assets,无隐藏,visible 即 order', () => {
    const store = useEditorStore()
    expect(store.activityBarOrder).toEqual(['files', 'outline', 'search', 'assets'])
    expect(store.activityBarHidden).toEqual([])
    expect(store.visibleActivityBarItems).toEqual(['files', 'outline', 'search', 'assets'])
  })

  it('reorder before: 把 from 移到 to 之前', () => {
    const store = useEditorStore()
    store.reorderActivityBar('outline', 'files', 'before')
    expect(store.activityBarOrder).toEqual(['outline', 'files', 'search', 'assets'])
  })

  it('reorder after: 把 from 移到 to 之后(跨项)', () => {
    const store = useEditorStore()
    store.reorderActivityBar('files', 'search', 'after')
    expect(store.activityBarOrder).toEqual(['outline', 'search', 'files', 'assets'])
  })

  it('reorder from===to 为 no-op', () => {
    const store = useEditorStore()
    store.reorderActivityBar('files', 'files', 'before')
    expect(store.activityBarOrder).toEqual(['files', 'outline', 'search', 'assets'])
  })

  it('reorder 拒绝非可重排项(settings 不参与排序)', () => {
    const store = useEditorStore()
    store.reorderActivityBar('settings', 'files', 'before')
    store.reorderActivityBar('files', 'settings', 'after')
    expect(store.activityBarOrder).toEqual(['files', 'outline', 'search', 'assets'])
  })

  it('toggleActivityBarHidden 来回切换,visible 同步过滤', () => {
    const store = useEditorStore()
    store.toggleActivityBarHidden('outline')
    expect(store.activityBarHidden).toEqual(['outline'])
    expect(store.visibleActivityBarItems).toEqual(['files', 'search', 'assets'])
    store.toggleActivityBarHidden('outline')
    expect(store.activityBarHidden).toEqual([])
    expect(store.visibleActivityBarItems).toEqual(['files', 'outline', 'search', 'assets'])
  })

  it('toggleActivityBarHidden 拒绝隐藏 settings(固定显示)', () => {
    const store = useEditorStore()
    store.toggleActivityBarHidden('settings')
    expect(store.isActivityBarItemHidden('settings')).toBe(false)
    expect(store.activityBarHidden).toEqual([])
  })

  it('resetActivityBar 恢复默认顺序 + 全部显示', () => {
    const store = useEditorStore()
    store.reorderActivityBar('outline', 'files', 'before')
    store.toggleActivityBarHidden('files')
    store.resetActivityBar()
    expect(store.activityBarOrder).toEqual(['files', 'outline', 'search', 'assets'])
    expect(store.activityBarHidden).toEqual([])
  })

  it('hydrateActivityBarConfig 走 normalize 写入 store(settings 从 hidden 剔除)', () => {
    const store = useEditorStore()
    store.hydrateActivityBarConfig(['search', 'bogus'], ['settings', 'outline'])
    expect(store.activityBarOrder).toEqual(['search', 'files', 'outline', 'assets'])
    expect(store.activityBarHidden).toEqual(['outline'])
  })
})

describe('normalizeActivityBarConfig 防御性归一化', () => {
  it('过滤未知项 + 按默认序补齐缺失项', () => {
    const { order, hidden } = normalizeActivityBarConfig(['search', 'unknown', 'files'], [])
    expect(order).toEqual(['search', 'files', 'outline', 'assets'])
    expect(hidden).toEqual([])
  })

  it('dedupe order 重复项', () => {
    const { order } = normalizeActivityBarConfig(['files', 'files', 'search'], [])
    expect(order).toEqual(['files', 'search', 'outline', 'assets'])
  })

  it('hidden 剔除 settings(固定显示),过滤未知 + dedupe', () => {
    const { hidden } = normalizeActivityBarConfig([], ['settings', 'settings', 'bogus', 'outline'])
    expect(hidden).toEqual(['outline'])
  })

  it('undefined 输入回退默认', () => {
    const { order, hidden } = normalizeActivityBarConfig(undefined, undefined)
    expect(order).toEqual(['files', 'outline', 'search', 'assets'])
    expect(hidden).toEqual([])
  })

  it('空数组 order 补齐全部默认项', () => {
    const { order } = normalizeActivityBarConfig([], [])
    expect(order).toEqual(['files', 'outline', 'search', 'assets'])
  })

  it('非数组输入回退默认', () => {
    const { order, hidden } = normalizeActivityBarConfig('files', { settings: true })
    expect(order).toEqual(['files', 'outline', 'search', 'assets'])
    expect(hidden).toEqual([])
  })
})
