// MermaidContextMenu 可见性 / emit 测试。
// 纯展示组件:只锁「用户要求的功能项齐全」「只读态隐藏写操作」「展开态文案」,
// 不测 Teleport / Tailwind class(同 TabContextMenu.test.ts 的取舍)。

import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MermaidContextMenu from '../ProseMirrorEditor/MermaidContextMenu.vue'

function mountMenu(
  overrides: Partial<{
    x: number
    y: number
    isEditing: boolean
    editable: boolean
  }> = {},
) {
  return mount(MermaidContextMenu, {
    props: {
      x: 100,
      y: 100,
      isEditing: false,
      editable: true,
      ...overrides,
    },
    global: { stubs: { Teleport: true } },
  })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('MermaidContextMenu', () => {
  it('可写 + 折叠态:功能项齐全,标签为「展开源代码」', () => {
    const w = mountMenu()
    const ids = [
      'mermaid-toggle-source',
      'mermaid-copy',
      'mermaid-cut',
      'mermaid-copy-source',
      'mermaid-copy-image',
      'mermaid-save-png',
      'mermaid-delete',
    ]
    for (const id of ids) expect(w.find(`[data-testid="${id}"]`).exists()).toBe(true)
    expect(w.find('[data-testid="mermaid-toggle-source"]').text()).toBe('展开源代码')
  })

  it('展开态显示「收起源代码」', () => {
    const w = mountMenu({ isEditing: true })
    expect(w.find('[data-testid="mermaid-toggle-source"]').text()).toBe('收起源代码')
  })

  it('只读态:隐藏展开 / 剪切 / 删除,保留复制与另存为', () => {
    const w = mountMenu({ editable: false })
    expect(w.find('[data-testid="mermaid-toggle-source"]').exists()).toBe(false)
    expect(w.find('[data-testid="mermaid-cut"]').exists()).toBe(false)
    expect(w.find('[data-testid="mermaid-delete"]').exists()).toBe(false)
    expect(w.find('[data-testid="mermaid-copy"]').exists()).toBe(true)
    expect(w.find('[data-testid="mermaid-copy-image"]').exists()).toBe(true)
    expect(w.find('[data-testid="mermaid-save-svg"]').exists()).toBe(true)
    expect(w.find('[data-testid="mermaid-save-source"]').exists()).toBe(true)
  })

  it('点击菜单项:emit(action) + emit(close)', async () => {
    const w = mountMenu()
    await w.find('[data-testid="mermaid-copy-source"]').trigger('click')
    expect(w.emitted('action')?.[0]).toEqual(['copy-source'])
    expect(w.emitted('close')).toHaveLength(1)
  })
})
