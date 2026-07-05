// TabContextMenu 可见性 / emit 测试(v0.6.x 标签右键菜单)。
//
// 原则:菜单组件是纯展示 + emit,无需真实 store。
//   - 不测具体 Tailwind class(纯视觉,改了不挂)
//   - 聚焦「可见性是否正确」:hasFile / isInActiveRoot / tabIndex / showSave
//   - 不测 Teleport 行为(Vue Test Utils 默认 mount 时 Teleport 不 teleport,
//     但本测试只关心条件渲染,不影响)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import TabContextMenu from '../TabContextMenu.vue'

const baseTab = {
  tabId: 'tab-1',
  filePath: '/ws/note.md',
  active: true,
  dirty: false,
  readOnly: false,
  activeRoot: '/ws',
}

function mountMenu(overrides: Partial<{
  x: number
  y: number
  totalTabs: number
  tabIndex: number
  tab: typeof baseTab
}> = {}) {
  // Stub <Teleport> 为普通 div:Teleport to="body" 在 jsdom 里会把内容搬出
  // 组件 host,Vue Test Utils 的 wrapper.find() 找不到 — 在产品里 Teleport
  // 是把菜单搬到 body 顶层防止被父级 overflow:hidden 截断,测试里不关心这个,
  // 只验证条件渲染 / emit 即可。
  return mount(TabContextMenu, {
    props: {
      x: 100,
      y: 100,
      totalTabs: 3,
      tabIndex: 0,
      tab: { ...baseTab, ...overrides.tab },
      ...overrides,
    },
    global: {
      stubs: {
        Teleport: true,
      },
    },
  })
}

describe('TabContextMenu', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  // —— 基础可见性 ——

  it('文件 + active root + 中间位置:显示全部项', () => {
    const w = mountMenu()
    // 关闭组
    expect(w.find('[data-testid="tab-ctx-close"]').exists()).toBe(true)
    expect(w.find('[data-testid="tab-ctx-close-others"]').exists()).toBe(true)
    expect(w.find('[data-testid="tab-ctx-close-right"]').exists()).toBe(true)
    expect(w.find('[data-testid="tab-ctx-close-saved"]').exists()).toBe(true)
    expect(w.find('[data-testid="tab-ctx-close-all"]').exists()).toBe(true)
    // save 不显示(clean)
    expect(w.find('[data-testid="tab-ctx-save"]').exists()).toBe(false)
    // 复制组
    expect(w.find('[data-testid="tab-ctx-copy-path"]').exists()).toBe(true)
    expect(w.find('[data-testid="tab-ctx-copy-filename"]').exists()).toBe(true)
    expect(w.find('[data-testid="tab-ctx-copy-relative"]').exists()).toBe(true)
    // 树 / 资源管理器
    expect(w.find('[data-testid="tab-ctx-reveal-in-tree"]').exists()).toBe(true)
    expect(w.find('[data-testid="tab-ctx-reveal-in-explorer"]').exists()).toBe(true)
  })

  // —— 总数 ≤ 1 ——

  it('总数 = 1 时「关闭其他」隐藏', () => {
    const w = mountMenu({ totalTabs: 1 })
    expect(w.find('[data-testid="tab-ctx-close"]').exists()).toBe(true)
    expect(w.find('[data-testid="tab-ctx-close-others"]').exists()).toBe(false)
    expect(w.find('[data-testid="tab-ctx-close-right"]').exists()).toBe(false) // tabIndex=0 = 最后一个
    expect(w.find('[data-testid="tab-ctx-close-saved"]').exists()).toBe(true)
    expect(w.find('[data-testid="tab-ctx-close-all"]').exists()).toBe(true)
  })

  // —— 关闭右侧 ——

  it('tabIndex = totalTabs - 1(最右)时「关闭右侧」隐藏', () => {
    const w = mountMenu({ totalTabs: 3, tabIndex: 2 })
    expect(w.find('[data-testid="tab-ctx-close-right"]').exists()).toBe(false)
  })

  it('tabIndex < totalTabs - 1 时「关闭右侧」显示', () => {
    const w = mountMenu({ totalTabs: 3, tabIndex: 0 })
    expect(w.find('[data-testid="tab-ctx-close-right"]').exists()).toBe(true)
  })

  // —— Save ——

  it('dirty + 非只读:显示「保存」', () => {
    const w = mountMenu({ tab: { ...baseTab, dirty: true } })
    expect(w.find('[data-testid="tab-ctx-save"]').exists()).toBe(true)
  })

  it('dirty 但只读(sample 锁):「保存」隐藏', () => {
    const w = mountMenu({ tab: { ...baseTab, dirty: true, readOnly: true } })
    expect(w.find('[data-testid="tab-ctx-save"]').exists()).toBe(false)
  })

  // —— filePath 缺失(未命名 / sample)——

  it('filePath = null:文件相关项全部隐藏', () => {
    const w = mountMenu({ tab: { ...baseTab, filePath: null as unknown as string } })
    expect(w.find('[data-testid="tab-ctx-copy-path"]').exists()).toBe(false)
    expect(w.find('[data-testid="tab-ctx-copy-filename"]').exists()).toBe(false)
    expect(w.find('[data-testid="tab-ctx-copy-relative"]').exists()).toBe(false)
    expect(w.find('[data-testid="tab-ctx-reveal-in-tree"]').exists()).toBe(false)
    expect(w.find('[data-testid="tab-ctx-reveal-in-explorer"]').exists()).toBe(false)
  })

  // —— isInActiveRoot ——

  it('activeRoot = null:「复制相对路径」「在文件树中显示」隐藏', () => {
    const w = mountMenu({ tab: { ...baseTab, activeRoot: null as unknown as string } })
    expect(w.find('[data-testid="tab-ctx-copy-relative"]').exists()).toBe(false)
    expect(w.find('[data-testid="tab-ctx-reveal-in-tree"]').exists()).toBe(false)
    // 其它文件项仍可见
    expect(w.find('[data-testid="tab-ctx-copy-path"]').exists()).toBe(true)
    expect(w.find('[data-testid="tab-ctx-reveal-in-explorer"]').exists()).toBe(true)
  })

  it('filePath 不在 activeRoot 下:「复制相对路径」「在文件树中显示」隐藏', () => {
    const w = mountMenu({
      tab: { ...baseTab, filePath: '/other/place/note.md', activeRoot: '/ws' },
    })
    expect(w.find('[data-testid="tab-ctx-copy-relative"]').exists()).toBe(false)
    expect(w.find('[data-testid="tab-ctx-reveal-in-tree"]').exists()).toBe(false)
  })

  // —— emit ——

  it('点击「关闭其他」emit close-others', async () => {
    const w = mountMenu()
    await w.find('[data-testid="tab-ctx-close-others"]').trigger('click')
    expect(w.emitted('close-others')).toHaveLength(1)
  })

  it('点击「保存」emit save', async () => {
    const w = mountMenu({ tab: { ...baseTab, dirty: true } })
    await w.find('[data-testid="tab-ctx-save"]').trigger('click')
    expect(w.emitted('save')).toHaveLength(1)
  })

  it('右键二次弹菜单被 prevent(@contextmenu.prevent)', async () => {
    const w = mountMenu()
    const root = w.find('[role="menu"]')
    // 模拟右键:Vue Test Utils 的 trigger 不传 event 细节,我们用 dispatchEvent 验证 preventDefault 被调
    const evt = new Event('contextmenu', { cancelable: true })
    root.element.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
  })

  it('defineExpose 暴露 rootEl', () => {
    const w = mountMenu()
    const vm = w.vm as unknown as { rootEl: HTMLElement | null }
    expect(vm.rootEl).toBeTruthy()
    expect(vm.rootEl?.tagName).toBe('DIV')
  })
})
