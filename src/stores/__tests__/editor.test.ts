import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  useEditorStore,
  normalizeActivityBarConfig,
  clampZoomLevel,
  clampSidebarWidth,
  ZOOM_LEVEL_MIN,
  ZOOM_LEVEL_MAX,
  ZOOM_LEVEL_DEFAULT,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_DEFAULT,
} from '../editor'

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

  it('fontFamily 默认包含 CJK fallback', () => {
    const store = useEditorStore()
    // fontFamily 是 computed，由 buildFontStack(latin, cjk, mono) 派生
    // CJK system stack 同时包含 PingFang SC 和 Microsoft YaHei 做跨平台 fallback
    expect(store.fontFamily).toContain('PingFang SC')
    expect(store.fontFamily).toContain('Microsoft YaHei')
  })

  it('latinFont / cjkFont / monoFont 默认按平台', () => {
    const store = useEditorStore()
    const expectedLatin = /Mac/.test(navigator.userAgent) ? 'charter' : 'cambria'
    const expectedCjk = /Mac/.test(navigator.userAgent) ? 'pingfang' : 'yahei'
    const expectedMono = /Mac/.test(navigator.userAgent) ? 'sfmono' : 'cascadiacode'
    expect(store.latinFont).toBe(expectedLatin)
    expect(store.cjkFont).toBe(expectedCjk)
    expect(store.monoFont).toBe(expectedMono)
  })

  it('fontMono 默认是等宽字体栈', () => {
    const store = useEditorStore()
    expect(store.fontMono).toContain('ui-monospace')
  })

  it('改 latinFont 后 fontFamily computed 响应', () => {
    const store = useEditorStore()
    store.latinFont = 'georgia'
    expect(store.fontFamily).toContain('Georgia')
  })

  it('改 cjkFont 后 fontFamily computed 响应', () => {
    const store = useEditorStore()
    store.cjkFont = 'songti'
    expect(store.fontFamily).toContain('Songti')
  })

  it('改 monoFont 后 fontMono computed 响应', () => {
    const store = useEditorStore()
    store.monoFont = 'jetbrains'
    expect(store.fontMono).toContain('JetBrains Mono')
  })

  it('themeMode 默认 system', () => {
    const store = useEditorStore()
    expect(store.themeMode).toBe('system')
  })

  it('darkMode computed：themeMode=light 时 false，themeMode=dark 时 true', () => {
    const store = useEditorStore()
    store.themeMode = 'light'
    expect(store.darkMode).toBe(false)
    store.themeMode = 'dark'
    expect(store.darkMode).toBe(true)
  })

  it('darkMode computed：themeMode=system 时跟随 systemDarkMode', () => {
    const store = useEditorStore()
    store.themeMode = 'system'
    store.systemDarkMode = false
    expect(store.darkMode).toBe(false)
    store.systemDarkMode = true
    expect(store.darkMode).toBe(true)
  })

  it('zoomLevel 默认 1.0(v0.7.12)', () => {
    const store = useEditorStore()
    expect(store.zoomLevel).toBe(1.0)
  })

  it('zoomLevel 可写且双向反映', () => {
    const store = useEditorStore()
    store.zoomLevel = 1.5
    expect(store.zoomLevel).toBe(1.5)
  })

  it('所有 ref 可写且双向反映', () => {
    const store = useEditorStore()
    store.themeMode = 'dark'
    expect(store.themeMode).toBe('dark')

    store.primaryColor = '#FF0000'
    expect(store.primaryColor).toBe('#FF0000')
  })
})

describe('editor store ActivityBar 自定义 (v0.6.1)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('默认顺序 files/outline/search/assets,无隐藏,visible 即 order', () => {
    const store = useEditorStore()
    expect(store.activityBarOrder).toEqual(['files', 'outline', 'search', 'assets', 'history'])
    expect(store.activityBarHidden).toEqual([])
    expect(store.visibleActivityBarItems).toEqual(['files', 'outline', 'search', 'assets', 'history'])
  })

  it('reorder before: 把 from 移到 to 之前', () => {
    const store = useEditorStore()
    store.reorderActivityBar('outline', 'files', 'before')
    expect(store.activityBarOrder).toEqual(['outline', 'files', 'search', 'assets', 'history'])
  })

  it('reorder after: 把 from 移到 to 之后(跨项)', () => {
    const store = useEditorStore()
    store.reorderActivityBar('files', 'search', 'after')
    expect(store.activityBarOrder).toEqual(['outline', 'search', 'files', 'assets', 'history'])
  })

  it('reorder from===to 为 no-op', () => {
    const store = useEditorStore()
    store.reorderActivityBar('files', 'files', 'before')
    expect(store.activityBarOrder).toEqual(['files', 'outline', 'search', 'assets', 'history'])
  })

  it('reorder 拒绝非可重排项(settings 不参与排序)', () => {
    const store = useEditorStore()
    store.reorderActivityBar('settings', 'files', 'before')
    store.reorderActivityBar('files', 'settings', 'after')
    expect(store.activityBarOrder).toEqual(['files', 'outline', 'search', 'assets', 'history'])
  })

  it('toggleActivityBarHidden 来回切换,visible 同步过滤', () => {
    const store = useEditorStore()
    store.toggleActivityBarHidden('outline')
    expect(store.activityBarHidden).toEqual(['outline'])
    expect(store.visibleActivityBarItems).toEqual(['files', 'search', 'assets', 'history'])
    store.toggleActivityBarHidden('outline')
    expect(store.activityBarHidden).toEqual([])
    expect(store.visibleActivityBarItems).toEqual(['files', 'outline', 'search', 'assets', 'history'])
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
    expect(store.activityBarOrder).toEqual(['files', 'outline', 'search', 'assets', 'history'])
    expect(store.activityBarHidden).toEqual([])
  })

  it('hydrateActivityBarConfig 走 normalize 写入 store(settings 从 hidden 剔除)', () => {
    const store = useEditorStore()
    store.hydrateActivityBarConfig(['search', 'bogus'], ['settings', 'outline'])
    expect(store.activityBarOrder).toEqual(['search', 'files', 'outline', 'assets', 'history'])
    expect(store.activityBarHidden).toEqual(['outline'])
  })
})

describe('normalizeActivityBarConfig 防御性归一化', () => {
  it('过滤未知项 + 按默认序补齐缺失项', () => {
    const { order, hidden } = normalizeActivityBarConfig(['search', 'unknown', 'files'], [])
    expect(order).toEqual(['search', 'files', 'outline', 'assets', 'history'])
    expect(hidden).toEqual([])
  })

  it('dedupe order 重复项', () => {
    const { order } = normalizeActivityBarConfig(['files', 'files', 'search'], [])
    expect(order).toEqual(['files', 'search', 'outline', 'assets', 'history'])
  })

  it('hidden 剔除 settings(固定显示),过滤未知 + dedupe', () => {
    const { hidden } = normalizeActivityBarConfig([], ['settings', 'settings', 'bogus', 'outline'])
    expect(hidden).toEqual(['outline'])
  })

  it('undefined 输入回退默认', () => {
    const { order, hidden } = normalizeActivityBarConfig(undefined, undefined)
    expect(order).toEqual(['files', 'outline', 'search', 'assets', 'history'])
    expect(hidden).toEqual([])
  })

  it('空数组 order 补齐全部默认项', () => {
    const { order } = normalizeActivityBarConfig([], [])
    expect(order).toEqual(['files', 'outline', 'search', 'assets', 'history'])
  })

  it('非数组输入回退默认', () => {
    const { order, hidden } = normalizeActivityBarConfig('files', { settings: true })
    expect(order).toEqual(['files', 'outline', 'search', 'assets', 'history'])
    expect(hidden).toEqual([])
  })
})

describe('editor store zoomLevel hydrate / snapshot (v0.7.12)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('hydrate 合法 zoomLevel 写入 store', () => {
    const store = useEditorStore()
    store.hydrateSettings({
      fontSize: '16px',
      primaryColor: '#1F71D9',
      zoomLevel: 1.3,
    })
    expect(store.zoomLevel).toBe(1.3)
  })

  it('hydrate 超出范围 clamp 到 MAX', () => {
    const store = useEditorStore()
    store.hydrateSettings({
      fontSize: '16px',
      primaryColor: '#1F71D9',
      zoomLevel: 5.0,
    })
    expect(store.zoomLevel).toBe(ZOOM_LEVEL_MAX)
  })

  it('hydrate 超出范围 clamp 到 MIN', () => {
    const store = useEditorStore()
    store.hydrateSettings({
      fontSize: '16px',
      primaryColor: '#1F71D9',
      zoomLevel: 0.1,
    })
    expect(store.zoomLevel).toBe(ZOOM_LEVEL_MIN)
  })

  it('hydrate 缺失 zoomLevel 不改默认值', () => {
    const store = useEditorStore()
    store.hydrateSettings({
      fontSize: '16px',
      primaryColor: '#1F71D9',
    })
    expect(store.zoomLevel).toBe(ZOOM_LEVEL_DEFAULT)
  })

  it('hydrate 非法类型(字符串)不改默认值', () => {
    const store = useEditorStore()
    store.hydrateSettings({
      fontSize: '16px',
      primaryColor: '#1F71D9',
      zoomLevel: '1.5' as unknown as number,
    })
    expect(store.zoomLevel).toBe(ZOOM_LEVEL_DEFAULT)
  })

  it('snapshot 包含 zoomLevel', () => {
    const store = useEditorStore()
    store.zoomLevel = 1.4
    const snap = store.snapshotSettings()
    expect(snap.zoomLevel).toBe(1.4)
  })
})

describe('editor store 字体选配 hydrate / snapshot', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('hydrate latinFont / cjkFont / monoFont 写入 store', () => {
    const store = useEditorStore()
    store.hydrateSettings({
      fontSize: '16px',
      primaryColor: '#1F71D9',
      latinFont: 'georgia',
      cjkFont: 'songti',
      monoFont: 'jetbrains',
    })
    expect(store.latinFont).toBe('georgia')
    expect(store.cjkFont).toBe('songti')
    expect(store.monoFont).toBe('jetbrains')
    // computed 派生
    expect(store.fontFamily).toContain('Georgia')
    expect(store.fontFamily).toContain('Songti')
    expect(store.fontMono).toContain('JetBrains Mono')
  })

  it('hydrate 缺失字体字段不改默认值', () => {
    const store = useEditorStore()
    store.hydrateSettings({
      fontSize: '16px',
      primaryColor: '#1F71D9',
    })
    const expectedLatin = /Mac/.test(navigator.userAgent) ? 'charter' : 'cambria'
    const expectedCjk = /Mac/.test(navigator.userAgent) ? 'pingfang' : 'yahei'
    const expectedMono = /Mac/.test(navigator.userAgent) ? 'sfmono' : 'cascadiacode'
    expect(store.latinFont).toBe(expectedLatin)
    expect(store.cjkFont).toBe(expectedCjk)
    expect(store.monoFont).toBe(expectedMono)
  })

  it('snapshot 包含 latinFont / cjkFont / monoFont', () => {
    const store = useEditorStore()
    store.latinFont = 'georgia'
    store.cjkFont = 'yahei'
    store.monoFont = 'consolas'
    const snap = store.snapshotSettings()
    expect(snap.latinFont).toBe('georgia')
    expect(snap.cjkFont).toBe('yahei')
    expect(snap.monoFont).toBe('consolas')
  })
})

describe('editor store sidebarWidth (v0.7.13 全局粒度)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('默认值 256', () => {
    const store = useEditorStore()
    expect(store.sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT)
  })

  it('setSidebarWidth clamp 到 [MIN, MAX]', () => {
    const store = useEditorStore()
    store.setSidebarWidth(800)
    expect(store.sidebarWidth).toBe(SIDEBAR_WIDTH_MAX)
    store.setSidebarWidth(100)
    expect(store.sidebarWidth).toBe(SIDEBAR_WIDTH_MIN)
    store.setSidebarWidth(350)
    expect(store.sidebarWidth).toBe(350)
  })

  it('hydrate 合法 sidebarWidth 写入 store', () => {
    const store = useEditorStore()
    store.hydrateSettings({
      fontSize: '16px',
      primaryColor: '#1F71D9',
      sidebarWidth: 400,
    })
    expect(store.sidebarWidth).toBe(400)
  })

  it('hydrate 超出范围 clamp', () => {
    const store = useEditorStore()
    store.hydrateSettings({
      fontSize: '16px',
      primaryColor: '#1F71D9',
      sidebarWidth: 800,
    })
    expect(store.sidebarWidth).toBe(SIDEBAR_WIDTH_MAX)
  })

  it('hydrate 缺失 sidebarWidth 不改默认值', () => {
    const store = useEditorStore()
    store.hydrateSettings({
      fontSize: '16px',
      primaryColor: '#1F71D9',
    })
    expect(store.sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT)
  })

  it('snapshot 包含 sidebarWidth', () => {
    const store = useEditorStore()
    store.setSidebarWidth(420)
    const snap = store.snapshotSettings()
    expect(snap.sidebarWidth).toBe(420)
  })
})

describe('clampSidebarWidth', () => {
  it('合法值原样返回', () => {
    expect(clampSidebarWidth(256)).toBe(256)
    expect(clampSidebarWidth(200)).toBe(SIDEBAR_WIDTH_MIN)
    expect(clampSidebarWidth(600)).toBe(SIDEBAR_WIDTH_MAX)
  })

  it('低于 MIN clamp 到 MIN', () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_WIDTH_MIN)
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_WIDTH_MIN)
  })

  it('高于 MAX clamp 到 MAX', () => {
    expect(clampSidebarWidth(800)).toBe(SIDEBAR_WIDTH_MAX)
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_WIDTH_MAX)
  })

  it('NaN 回退默认', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH_DEFAULT)
  })
})

describe('clampZoomLevel', () => {
  it('合法值原样返回', () => {
    expect(clampZoomLevel(1.0)).toBe(1.0)
    expect(clampZoomLevel(0.5)).toBe(0.5)
    expect(clampZoomLevel(2.0)).toBe(2.0)
  })

  it('低于 MIN clamp 到 MIN', () => {
    expect(clampZoomLevel(0.1)).toBe(ZOOM_LEVEL_MIN)
    expect(clampZoomLevel(-1)).toBe(ZOOM_LEVEL_MIN)
  })

  it('高于 MAX clamp 到 MAX', () => {
    expect(clampZoomLevel(3.0)).toBe(ZOOM_LEVEL_MAX)
    expect(clampZoomLevel(100)).toBe(ZOOM_LEVEL_MAX)
  })

  it('NaN / Infinity 回退默认', () => {
    expect(clampZoomLevel(Number.NaN)).toBe(ZOOM_LEVEL_DEFAULT)
    expect(clampZoomLevel(Number.POSITIVE_INFINITY)).toBe(ZOOM_LEVEL_MAX)
    expect(clampZoomLevel(Number.NEGATIVE_INFINITY)).toBe(ZOOM_LEVEL_MIN)
  })
})
