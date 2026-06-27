import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import CommandPalettePanel from '../CommandPalettePanel.vue'
import type { CommandPaletteItem } from '@/utils/commandPalette'

function makeItems(): CommandPaletteItem[] {
  return [
    { id: 'save', title: '保存', group: 'app', shortcut: 'Ctrl+S', keywords: ['save'], run: vi.fn() },
    { id: 'open', title: '打开文件', group: 'app', shortcut: 'Ctrl+O', keywords: ['open'], run: vi.fn() },
    { id: 'quick', title: '快速打开文件', group: 'workspace', disabled: true, disabledReason: '需要先打开工作区', run: vi.fn() },
  ]
}

function mountPanel(items = makeItems()) {
  return mount(CommandPalettePanel, {
    props: { open: true, items },
    attachTo: document.body,
    global: { stubs: { Teleport: true } },
  })
}

describe('CommandPalettePanel', () => {
  let wrapper: VueWrapper | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('打开后 focus 输入框并渲染 > 前缀', async () => {
    wrapper = mountPanel()
    await nextTick()

    expect(document.activeElement).toBe(wrapper.find('[data-testid="command-palette-input"]').element)
    expect(wrapper.text()).toContain('>')
  })

  it('输入 query 后过滤结果', async () => {
    wrapper = mountPanel()

    await wrapper.find('[data-testid="command-palette-input"]').setValue('open')

    expect(wrapper.text()).toContain('打开文件')
    expect(wrapper.text()).not.toContain('保存')
  })

  it('ArrowDown/ArrowUp 循环导航,Enter 执行选中命令并关闭', async () => {
    const items = makeItems()
    wrapper = mountPanel(items)
    const input = wrapper.find('[data-testid="command-palette-input"]')

    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'ArrowUp' })
    await input.trigger('keydown', { key: 'Enter' })

    expect(items[0].run).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })

  it('Enter 在 disabled 命令上不执行也不关闭', async () => {
    const items = makeItems()
    wrapper = mountPanel(items)
    const input = wrapper.find('[data-testid="command-palette-input"]')

    await input.setValue('quick')
    await input.trigger('keydown', { key: 'Enter' })

    expect(items[2].run).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:open')).toBeUndefined()
  })

  it('点击 disabled 命令不执行也不关闭', async () => {
    const items = makeItems()
    wrapper = mountPanel(items)

    await wrapper.get('[data-testid="command-palette-row-quick"]').trigger('click')

    expect(items[2].run).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:open')).toBeUndefined()
  })

  it('Escape 关闭面板', async () => {
    wrapper = mountPanel()

    await wrapper.find('[data-testid="command-palette-input"]').trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })

  it('点击外部关闭面板', async () => {
    wrapper = mountPanel()

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await nextTick()

    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })

  it('Escape 也可在焦点离开输入框时关闭面板', async () => {
    wrapper = mountPanel()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()

    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })

})
