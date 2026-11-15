// mermaid 右键菜单命令回归测试 —— 走真实 EditorView,先由拦截插件拿到上下文,
// 再把 ctx 交给 runMermaidMenuAction,覆盖复制 / 剪切 / 删除 / 展开源码的
// 边界(尤其是「整段删除不能吃掉后面的段落」)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import { mermaidDecoration, mermaidDecoKey } from '../nodes/MermaidDecoration'
import { runMermaidMenuAction } from '../nodes/mermaidContextActions'
import {
  createMermaidContextMenuPlugin,
  type MermaidContextTarget,
} from '../plugins/mermaidContextMenu'
import { useNotifyStore } from '@/stores/notify'

const MD = ['intro', '', '```mermaid', 'graph TD', '  A-->B', '```', '', 'after'].join('\n')

let captured: MermaidContextTarget | null = null

function makeView(): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(MD, schema),
    plugins: [
      createMermaidContextMenuPlugin({
        onMermaidContextMenu: (t) => {
          captured = t
        },
      }),
      mermaidDecoration,
    ],
  })
  return new EditorView(container, { state })
}

function captureTarget(view: EditorView): MermaidContextTarget {
  captured = null
  const area = view.dom.querySelector('.mermaid-widget .mermaid-svg-area')
  if (!area) throw new Error('mermaid widget 未渲染')
  area.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 20,
    }),
  )
  if (!captured) throw new Error('右键未被拦截')
  return captured
}

function mermaidCount(view: EditorView): number {
  let count = 0
  view.state.doc.descendants((node) => {
    if (node.type.name === 'code_block' && (node.attrs.language as string) === 'mermaid') count++
    return true
  })
  return count
}

function docText(view: EditorView): string {
  return view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(writeText).mockClear()
})

afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    const parent = el.parentElement
    if (parent) parent.remove()
  })
})

describe('runMermaidMenuAction', () => {
  it('复制:写整块 markdown(含围栏),复制 Mermaid 代码:只写源码', async () => {
    const view = makeView()
    const ctx = captureTarget(view)

    await runMermaidMenuAction(view, ctx, 'copy')
    const fenced = vi.mocked(writeText).mock.calls[0][0] as string
    expect(fenced).toContain('```mermaid')
    expect(fenced).toContain('A-->B')
    expect(fenced.trimEnd().endsWith('```')).toBe(true)

    await runMermaidMenuAction(view, ctx, 'copy-source')
    const plain = vi.mocked(writeText).mock.calls[1][0] as string
    expect(plain).toContain('graph TD')
    expect(plain).not.toContain('```')
    view.destroy()
  })

  it('剪切:先复制到剪贴板,再删掉整段,后续段落保留', async () => {
    const view = makeView()
    const ctx = captureTarget(view)

    await runMermaidMenuAction(view, ctx, 'cut')
    expect(vi.mocked(writeText)).toHaveBeenCalledTimes(1)
    expect(mermaidCount(view)).toBe(0)
    expect(docText(view)).toContain('intro')
    expect(docText(view)).toContain('after')
    view.destroy()
  })

  it('删除节点:整段被删,不吞掉后续段落,也不写剪贴板', async () => {
    const view = makeView()
    const ctx = captureTarget(view)

    await runMermaidMenuAction(view, ctx, 'delete')
    expect(mermaidCount(view)).toBe(0)
    expect(docText(view)).toContain('after')
    expect(vi.mocked(writeText)).not.toHaveBeenCalled()
    view.destroy()
  })

  it('展开源代码:editNodeSet 命中当前块的 sourcePos', async () => {
    const view = makeView()
    const ctx = captureTarget(view)

    await runMermaidMenuAction(view, ctx, 'toggle-source')
    const deco = mermaidDecoKey.getState(view.state)!
    expect(deco.editNodeSet.has(ctx.sourcePos)).toBe(true)
    expect(mermaidCount(view)).toBe(1)
    view.destroy()
  })

  it('图片复制在不支持图片剪贴板的环境下收敛为 error Toast,不抛异常', async () => {
    const view = makeView()
    const ctx = captureTarget(view)

    await expect(runMermaidMenuAction(view, ctx, 'copy-image')).resolves.toBeUndefined()
    expect(useNotifyStore().toasts.some((t) => t.type === 'error')).toBe(true)
    view.destroy()
  })
})
