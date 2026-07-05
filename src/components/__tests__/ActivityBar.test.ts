import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ActivityBar from '../ActivityBar.vue'

// 默认 props 工厂 —— ActivityBar v0.6.x 把 FileMenuButton 收纳进第一个位置,
// 测试只关心 ActivityBar 自身的按钮渲染 / emit 转发,FileMenuButton 的
// 行为另由 FileMenuButton.test.ts 覆盖。这里给「文件」按钮所需的最小 props,
// 避免 FileMenuButton 内部 useTemplateRef / Teleport 报错。
const baseProps = {
  isTauri: true,
  exporting: false,
  recentEntries: [] as Array<{ path: string, openedAt: number }>,
  welcomeEnabled: false,
}

describe('ActivityBar', () => {
  it('renders all five primary shell actions', () => {
    const wrapper = mount(ActivityBar, { props: { active: null, ...baseProps } })

    expect(wrapper.find('[aria-label="文件"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="工作区"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="大纲"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="全局搜索"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="设置"]').exists()).toBe(true)
  })

  it('emits a dedicated event for each navigation action', async () => {
    const wrapper = mount(ActivityBar, { props: { active: null, ...baseProps } })

    await wrapper.get('[aria-label="工作区"]').trigger('click')
    await wrapper.get('[aria-label="大纲"]').trigger('click')
    await wrapper.get('[aria-label="全局搜索"]').trigger('click')
    await wrapper.get('[aria-label="设置"]').trigger('click')

    expect(wrapper.emitted('select-files')).toHaveLength(1)
    expect(wrapper.emitted('select-outline')).toHaveLength(1)
    expect(wrapper.emitted('select-search')).toHaveLength(1)
    expect(wrapper.emitted('select-settings')).toHaveLength(1)
  })

  it('marks the active action as pressed', () => {
    const wrapper = mount(ActivityBar, { props: { active: 'files', ...baseProps } })

    expect(wrapper.get('[aria-label="工作区"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[aria-label="大纲"]').attributes('aria-pressed')).toBe('false')
  })

  // 端到端守住 slot ref 链:ActivityBar 的「文件」按钮走 `#trigger` 自定义视觉,
  // 必须 `:ref="registerRef"` 把元素喂回 FileMenuButton 算 menuPos。漏了这行
  // 的话 recomputeMenuPos 走 null 分支 → menuPos = null → 主菜单 v-if=false → 用户
  // 点了毫无反应。FileMenuButton 自身的「菜单打开」用例覆盖默认 slot 路径,
  // 这里单独覆盖 ActivityBar 的自定义 slot 路径。
  it('opens the file dropdown panel when the activity-bar trigger is clicked', async () => {
    const wrapper = mount(ActivityBar, {
      props: { active: null, ...baseProps },
      // Teleport 在 jsdom 里默认丢内容;stub 后内容 inline 进 wrapper.find。
      global: { stubs: { Teleport: true } },
      attachTo: document.body,
    })

    // 点击前:DOM 中没有 [role="menu"](FileMenuButton 的两个 Teleport 面板
    // 都没渲染)。
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)

    await wrapper.get('[aria-label="文件"]').trigger('click')
    // FileMenuButton.toggleMenu 内部两次 await nextTick(recomputeMenuPos 又一次),
    // flushPromises 之后再多 .$nextTick 一次保险。
    await flushPromises()
    await wrapper.vm.$nextTick()

    const menu = wrapper.find('[role="menu"]')
    expect(menu.exists()).toBe(true)
    expect(menu.text()).toContain('新建文件')
    expect(menu.text()).toContain('保存')
    expect(menu.text()).toContain('最近文件')

    wrapper.unmount()
  })
})