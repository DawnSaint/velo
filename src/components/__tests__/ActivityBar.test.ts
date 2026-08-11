import { mount } from '@vue/test-utils'
import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, getActivePinia, setActivePinia, type Pinia } from 'pinia'
import ActivityBar from '../ActivityBar.vue'
import { useEditorStore } from '@/stores/editor'

// ActivityBar v0.7.x 起不再承载 FileMenuButton(已移到 App.vue 顶栏 logo 位),
// 只保留视图入口(工作区 / 大纲 / 全局搜索 / 资产)+ 设置。测试只关心
// ActivityBar 自身的按钮渲染 / emit 转发 / 排序隐藏。

// ActivityBar v0.6.1 起读 editorStore(排序 / 隐藏态),mount 必须装 pinia。
// 每个用例 beforeEach 建 fresh pinia,mutate-store 用例拿同一实例先改 store 再 mount。
function mountBar(options: {
  props?: Record<string, unknown>
  stubs?: Record<string, boolean>
  attachTo?: HTMLElement
} = {}) {
  return mount(ActivityBar, {
    props: { active: null, ...(options.props ?? {}) },
    global: {
      plugins: [getActivePinia() as Pinia],
      stubs: options.stubs ?? {},
    },
    attachTo: options.attachTo,
  })
}

describe('ActivityBar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders all primary shell actions', () => {
    const wrapper = mountBar({ props: { active: null } })

    expect(wrapper.find('[aria-label="工作区"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="大纲"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="全局搜索"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="资产"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="版本历史"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="设置"]').exists()).toBe(true)
  })

  it('emits a dedicated event for each navigation action', async () => {
    const wrapper = mountBar({ props: { active: null } })

    await wrapper.get('[aria-label="工作区"]').trigger('click')
    await wrapper.get('[aria-label="大纲"]').trigger('click')
    await wrapper.get('[aria-label="全局搜索"]').trigger('click')
    await wrapper.get('[aria-label="资产"]').trigger('click')
    await wrapper.get('[aria-label="版本历史"]').trigger('click')
    await wrapper.get('[aria-label="设置"]').trigger('click')

    expect(wrapper.emitted('select-files')).toHaveLength(1)
    expect(wrapper.emitted('select-outline')).toHaveLength(1)
    expect(wrapper.emitted('select-search')).toHaveLength(1)
    expect(wrapper.emitted('select-assets')).toHaveLength(1)
    expect(wrapper.emitted('select-history')).toHaveLength(1)
    expect(wrapper.emitted('select-settings')).toHaveLength(1)
  })

  it('marks the active action as pressed', () => {
    const wrapper = mountBar({ props: { active: 'files' } })

    expect(wrapper.get('[aria-label="工作区"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[aria-label="大纲"]').attributes('aria-pressed')).toBe('false')
  })

  // —— v0.6.1 自定义:隐藏 / 排序反应到渲染 ——
  //
  // 拖拽 DOM 接线不在单测范围(同 TabBar,逻辑在 store 已覆盖);这里只测
  // 「store 状态变化 → ActivityBar 渲染同步」这条用户可见行为。

  it('hides a view item when the store marks it hidden', () => {
    const store = useEditorStore()
    store.toggleActivityBarHidden('outline')
    const wrapper = mountBar({ props: { active: null } })

    expect(wrapper.find('[aria-label="大纲"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="工作区"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="全局搜索"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="资产"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="版本历史"]').exists()).toBe(true)
  })

  it('settings 不可隐藏:toggle 后仍渲染(固定显示)', () => {
    const store = useEditorStore()
    store.toggleActivityBarHidden('settings')
    const wrapper = mountBar({ props: { active: null } })

    expect(wrapper.find('[aria-label="设置"]').exists()).toBe(true)
  })

  it('renders view items in the stored order', () => {
    const store = useEditorStore()
    // 默认 [files, outline, search, assets, history] → 把 outline 拖到 files 之前
    store.reorderActivityBar('outline', 'files', 'before')
    const wrapper = mountBar({ props: { active: null } })

    // [draggable="true"] 命中的恰好是 5 个可重排视图入口(文件 / settings 不带 draggable)
    const labels = wrapper
      .findAll('[draggable="true"]')
      .map(b => b.attributes('aria-label'))
    expect(labels).toEqual(['大纲', '工作区', '全局搜索', '资产', '版本历史'])
  })
})
