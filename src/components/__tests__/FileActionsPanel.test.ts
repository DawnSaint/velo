import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FileActionsPanel from '../FileActionsPanel.vue'

describe('FileActionsPanel', () => {
  it('renders grouped file actions with shortcuts', () => {
    const wrapper = mount(FileActionsPanel, {
      props: { isTauri: true, exporting: false },
    })

    for (const label of ['新建文件', '新窗口', '打开文件', '打开文件夹', '保存', '另存为', '导出']) {
      expect(wrapper.find(`[aria-label="${label}"]`).exists()).toBe(true)
    }
    for (const shortcut of ['Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+O', 'Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+Shift+E']) {
      expect(wrapper.text()).toContain(shortcut)
    }
    expect(wrapper.findAll('[data-testid="file-actions-separator"]')).toHaveLength(2)
  })

  it('emits the matching event for each action row', async () => {
    const wrapper = mount(FileActionsPanel, {
      props: { isTauri: true, exporting: false },
    })

    await wrapper.get('[aria-label="新建文件"]').trigger('click')
    await wrapper.get('[aria-label="新窗口"]').trigger('click')
    await wrapper.get('[aria-label="打开文件"]').trigger('click')
    await wrapper.get('[aria-label="打开文件夹"]').trigger('click')
    await wrapper.get('[aria-label="保存"]').trigger('click')
    await wrapper.get('[aria-label="另存为"]').trigger('click')
    await wrapper.get('[aria-label="导出"]').trigger('click')

    expect(wrapper.emitted('new-doc')).toHaveLength(1)
    expect(wrapper.emitted('new-window')).toHaveLength(1)
    expect(wrapper.emitted('open-file')).toHaveLength(1)
    expect(wrapper.emitted('open-folder')).toHaveLength(1)
    expect(wrapper.emitted('save')).toHaveLength(1)
    expect(wrapper.emitted('save-as')).toHaveLength(1)
    expect(wrapper.emitted('export')).toHaveLength(1)
  })

  it('hides the new window action outside Tauri', () => {
    const wrapper = mount(FileActionsPanel, {
      props: { isTauri: false, exporting: false },
    })

    expect(wrapper.find('[aria-label="新窗口"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="新建文件"]').exists()).toBe(true)
  })

  it('disables export while exporting', async () => {
    const wrapper = mount(FileActionsPanel, {
      props: { isTauri: true, exporting: true },
    })
    const button = wrapper.get('[aria-label="导出中…"]')

    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(wrapper.emitted('export')).toBeUndefined()
  })
})
