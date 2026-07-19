import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StatusBar from '../StatusBar.vue'

function mountStatusBar(overrides: Record<string, unknown> = {}) {
  return mount(StatusBar, {
    props: {
      activeRoot: 'C:\\notes',
      knownRoots: ['C:\\notes', 'D:\\archive'],
      currentFilePath: 'C:\\notes\\drafts\\a.md',
      content: '你好 Velo\n\nsecond paragraph',
      dirty: false,
      sourceMode: false,
      readOnly: false,
      readOnlyLocked: false,
      cursor: { line: 2, column: 3 },
      ...overrides,
    },
  })
}

describe('StatusBar', () => {
  it('renders workspace, word count and cursor position', () => {
    const wrapper = mountStatusBar()

    expect(wrapper.text()).toContain('工作区C:/notes')
    expect(wrapper.text()).toContain('字数 5')
    expect(wrapper.text()).toContain('行 2, 列 3')
  })

  it('shows dirty indicator only when dirty', () => {
    expect(mountStatusBar({ dirty: false }).text()).not.toContain('未保存')
    expect(mountStatusBar({ dirty: true }).text()).toContain('未保存')
  })

  it('opens workspace menu and emits workspace actions', async () => {
    const wrapper = mountStatusBar()

    await wrapper.get('[aria-haspopup="menu"]').trigger('click')
    expect(wrapper.text()).toContain('D:/archive')

    await wrapper.findAll('[role="menuitem"]')[1].trigger('click')
    expect(wrapper.emitted('set-active-root')?.[0]).toEqual(['D:\\archive'])

    await wrapper.get('[aria-haspopup="menu"]').trigger('click')
    await wrapper.findAll('[role="menuitem"]').at(-2)!.trigger('click')
    expect(wrapper.emitted('pick-workspace')).toHaveLength(1)

    await wrapper.get('[aria-haspopup="menu"]').trigger('click')
    await wrapper.findAll('[role="menuitem"]').at(-1)!.trigger('click')
    expect(wrapper.emitted('set-active-root')?.at(-1)).toEqual([null])
  })

  it('emits toggle-source-mode from the bottom bar icon segment', async () => {
    const wrapper = mountStatusBar({ sourceMode: true })

    const button = wrapper.get('[aria-label="切换到所见即所得"]')
    expect(button.text()).toBe('')
    await button.trigger('click')

    expect(wrapper.emitted('toggle-source-mode')).toHaveLength(1)
  })

  it('emits toggle-read-only when the lock icon segment is clicked', async () => {
    const wrapper = mountStatusBar({ readOnly: false })
    const button = wrapper.get('[aria-label="切换到阅读模式"]')
    await button.trigger('click')
    expect(wrapper.emitted('toggle-read-only')).toHaveLength(1)
  })

  it('swaps the lock icon and aria-label by readOnly state', () => {
    const editable = mountStatusBar({ readOnly: false })
    expect(editable.find('[aria-label="切换到阅读模式"]').exists()).toBe(true)
    expect(editable.find('[aria-label="切换到可编辑"]').exists()).toBe(false)

    const locked = mountStatusBar({ readOnly: true })
    expect(locked.find('[aria-label="切换到可编辑"]').exists()).toBe(true)
    expect(locked.find('[aria-label="切换到阅读模式"]').exists()).toBe(false)
  })

  it('disables the read-only toggle when readOnlyLocked (sample document)', async () => {
    const wrapper = mountStatusBar({ readOnly: true, readOnlyLocked: true })
    const button = wrapper.get('[aria-label="切换到可编辑"]')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('title')).toContain('示例文档为只读')
    // 即便强行 click 也不 emit —— documentStore 那层还会兜底(setter 尊重 locked)
    await button.trigger('click')
    expect(wrapper.emitted('toggle-read-only')).toBeUndefined()
  })

  it('does not expose a file path copy button', () => {
    const wrapper = mountStatusBar()

    expect(wrapper.find('button[title="C:/notes/drafts/a.md"]').exists()).toBe(false)
  })

  it('opens detailed stats popover from the word count', async () => {
    const wrapper = mountStatusBar()

    await wrapper.get('[aria-haspopup="dialog"]').trigger('click')

    expect(wrapper.text()).toContain('文档统计')
    expect(wrapper.text()).toContain('字符数')
    expect(wrapper.text()).toContain('段落数')
    expect(wrapper.text()).toContain('预计阅读')
  })

  it('falls back gracefully without workspace', () => {
    const wrapper = mountStatusBar({
      activeRoot: null,
      knownRoots: [],
      currentFilePath: null,
    })

    expect(wrapper.text()).toContain('无工作区')
  })

  // 设置页激活时隐藏文档相关区段(模式切换 / 字数 / 行列 / 未保存),
  // 这些数据属于上一个文档,在设置页显示会误导;工作区标签仍保留。
  it('hides document-specific segments when settingsActive', () => {
    const wrapper = mountStatusBar({ settingsActive: true, dirty: true })

    // 工作区标签保留
    expect(wrapper.text()).toContain('工作区')
    // 文档相关区段隐藏
    expect(wrapper.text()).not.toContain('未保存')
    expect(wrapper.text()).not.toContain('字数')
    expect(wrapper.text()).not.toContain('行')
    expect(wrapper.find('[aria-label="切换到源码模式"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="切换到阅读模式"]').exists()).toBe(false)
  })
})
