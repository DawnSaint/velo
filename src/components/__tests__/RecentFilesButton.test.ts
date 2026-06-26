import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import RecentFilesButton from '../RecentFilesButton.vue'

function clickDocumentBody() {
  const event = typeof PointerEvent === 'undefined'
    ? new MouseEvent('pointerdown', { bubbles: true })
    : new PointerEvent('pointerdown', { bubbles: true })
  document.body.dispatchEvent(event)
}

describe('RecentFilesButton', () => {
  it('空列表打开后显示空态', async () => {
    const wrapper = mount(RecentFilesButton, { props: { entries: [] }, attachTo: document.body })

    await wrapper.get('button').trigger('click')

    expect(wrapper.text()).toContain('暂无最近文件')
    wrapper.unmount()
  })

  it('展示 basename + 路径,点击条目 emit open-recent', async () => {
    const wrapper = mount(RecentFilesButton, {
      props: {
        entries: [{ path: 'C:\\docs\\note.md', openedAt: 1 }],
      },
      attachTo: document.body,
    })

    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toContain('note.md')
    expect(wrapper.text()).toContain('C:/docs/note.md')

    await wrapper.get('[role="menuitem"]').trigger('click')

    expect(wrapper.emitted('open-recent')).toEqual([["C:\\docs\\note.md"]])
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('Escape 和点外部关闭菜单', async () => {
    const wrapper = mount(RecentFilesButton, {
      props: { entries: [{ path: '/a.md', openedAt: 1 }] },
      attachTo: document.body,
    })

    await wrapper.get('button').trigger('click')
    expect(wrapper.find('[role="menu"]').exists()).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)

    await wrapper.get('button').trigger('click')
    clickDocumentBody()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
