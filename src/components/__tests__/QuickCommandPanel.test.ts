import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, getActivePinia, setActivePinia, type Pinia } from 'pinia'
import QuickCommandPanel from '../QuickCommandPanel.vue'
import type { CommandPaletteItem } from '@/utils/commandPalette'

function makeItems(): CommandPaletteItem[] {
  return [
    { id: 'save', title: '保存', group: 'app', shortcut: 'Ctrl+S', keywords: ['save'], run: vi.fn() },
    { id: 'open', title: '打开文件', group: 'app', shortcut: 'Ctrl+O', keywords: ['open'], run: vi.fn() },
    { id: 'quick', title: '快速打开文件', group: 'workspace', disabled: true, disabledReason: '需要先打开工作区', run: vi.fn() },
  ]
}

function mountPanel(props: Partial<{ open: boolean, items: CommandPaletteItem[], initialQuery: string }> = {}) {
  return mount(QuickCommandPanel, {
    props: {
      open: true,
      items: makeItems(),
      initialQuery: '>',
      ...props,
    },
    attachTo: document.body,
    global: {
      plugins: [getActivePinia() as Pinia],
      stubs: { Teleport: true },
    },
  })
}

describe('QuickCommandPanel', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('命令模式下 focus 输入框并预填 > 前缀', async () => {
    wrapper = mountPanel({ initialQuery: '>' })
    await nextTick()

    const input = wrapper.find('[data-testid="quick-command-input"]').element as HTMLInputElement
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('>')
  })

  it('命令模式输入过滤结果(输入含 > 前缀)', async () => {
    wrapper = mountPanel({ initialQuery: '>' })

    await wrapper.find('[data-testid="quick-command-input"]').setValue('>open')

    expect(wrapper.text()).toContain('打开文件')
    expect(wrapper.text()).not.toContain('保存')
  })

  it('ArrowDown/ArrowUp 循环导航,Enter 执行选中命令并关闭', async () => {
    const items = makeItems()
    wrapper = mountPanel({ items, initialQuery: '>' })
    const input = wrapper.find('[data-testid="quick-command-input"]')

    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'ArrowUp' })
    await input.trigger('keydown', { key: 'Enter' })

    expect(items[0].run).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })

  it('Enter 在 disabled 命令上不执行也不关闭', async () => {
    const items = makeItems()
    wrapper = mountPanel({ items, initialQuery: '>' })
    const input = wrapper.find('[data-testid="quick-command-input"]')

    await input.setValue('>quick')
    await input.trigger('keydown', { key: 'Enter' })

    expect(items[2].run).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:open')).toBeUndefined()
  })

  it('点击 disabled 命令不执行也不关闭', async () => {
    const items = makeItems()
    wrapper = mountPanel({ items, initialQuery: '>' })

    await wrapper.get('[data-testid="quick-command-row-quick"]').trigger('click')

    expect(items[2].run).not.toHaveBeenCalled()
    expect(wrapper.emitted('update:open')).toBeUndefined()
  })

  it('Escape 关闭面板', async () => {
    wrapper = mountPanel({ initialQuery: '>' })

    await wrapper.find('[data-testid="quick-command-input"]').trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })

  it('点击外部关闭面板', async () => {
    wrapper = mountPanel({ initialQuery: '>' })

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await nextTick()

    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })

  it('全局 Escape 也能关闭面板', async () => {
    wrapper = mountPanel({ initialQuery: '>' })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()

    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })

  it('file 模式无工作区显示空态,输入 > 切到命令模式渲染命令', async () => {
    wrapper = mountPanel({ initialQuery: '' })
    await nextTick()

    // file 模式 + 无工作区 → 索引空 → 提示无 .md 文件
    expect(wrapper.text()).toContain('工作区内没有 .md 文件')

    // 输入 > 切换到命令模式,空 text 列出全部命令
    await wrapper.find('[data-testid="quick-command-input"]').setValue('>')
    expect(wrapper.text()).toContain('保存')
    expect(wrapper.text()).not.toContain('工作区内没有 .md 文件')
  })
})
