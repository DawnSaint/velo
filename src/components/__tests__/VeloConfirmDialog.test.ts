import { mount } from '@vue/test-utils'
import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import VeloConfirmDialog from '../VeloConfirmDialog.vue'
import { useConfirmStore } from '@/stores/confirm'

function dialogEl(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
  if (!el) throw new Error('确认弹窗未渲染')
  return el
}

describe('VeloConfirmDialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  it('只渲染标题 / 一句说明 / 路径 / 双按钮,点主按钮结算 true', async () => {
    const wrapper = mount(VeloConfirmDialog, { attachTo: document.body })
    const store = useConfirmStore()
    const result = store.ask({
      title: '工作区目录已失效',
      message: '该文件夹已不存在，可能已被移动或删除。',
      detail: 'C:/桌面/test',
      confirmText: '从列表移除',
    })
    await nextTick()

    const dialog = dialogEl()
    expect(dialog.textContent).toContain('工作区目录已失效')
    expect(dialog.textContent).toContain('C:/桌面/test')
    // 精简版不带键盘提示 / 额外说明,焦点留在提醒内容上
    expect(dialog.textContent).not.toContain('Enter')
    expect(dialog.textContent).not.toContain('其他工作区')

    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map(b => b.textContent?.trim())).toEqual(['取消', '从列表移除'])
    buttons[1]?.click()
    await expect(result).resolves.toBe(true)
    expect(store.current).toBeNull()
    wrapper.unmount()
  })

  it('Esc 取消并清空请求', async () => {
    const wrapper = mount(VeloConfirmDialog, { attachTo: document.body })
    const store = useConfirmStore()
    const result = store.ask({ title: 't', message: 'm' })
    await nextTick()
    expect(dialogEl()).not.toBeNull()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await expect(result).resolves.toBe(false)
    expect(store.current).toBeNull()
    wrapper.unmount()
  })

  it('无请求时不渲染任何弹窗', () => {
    const wrapper = mount(VeloConfirmDialog, { attachTo: document.body })
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    wrapper.unmount()
  })
})
