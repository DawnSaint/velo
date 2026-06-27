import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ActivityBar from '../ActivityBar.vue'

describe('ActivityBar', () => {
  it('renders primary shell actions', () => {
    const wrapper = mount(ActivityBar, { props: { active: null } })

    expect(wrapper.find('[aria-label="文件"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="工作区"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="大纲"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="全局搜索"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="设置"]').exists()).toBe(true)
  })

  it('emits a dedicated event for each action', async () => {
    const wrapper = mount(ActivityBar, { props: { active: null } })

    await wrapper.get('[aria-label="文件"]').trigger('click')
    await wrapper.get('[aria-label="工作区"]').trigger('click')
    await wrapper.get('[aria-label="大纲"]').trigger('click')
    await wrapper.get('[aria-label="全局搜索"]').trigger('click')
    await wrapper.get('[aria-label="设置"]').trigger('click')

    expect(wrapper.emitted('select-file-actions')).toHaveLength(1)
    expect(wrapper.emitted('select-files')).toHaveLength(1)
    expect(wrapper.emitted('select-outline')).toHaveLength(1)
    expect(wrapper.emitted('select-search')).toHaveLength(1)
    expect(wrapper.emitted('select-settings')).toHaveLength(1)
  })

  it('marks the active action as pressed', () => {
    const wrapper = mount(ActivityBar, { props: { active: 'fileActions' } })

    expect(wrapper.get('[aria-label="文件"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[aria-label="工作区"]').attributes('aria-pressed')).toBe('false')
  })
})
