// mermaid 预览节点右键拦截回归测试。
//
// 锁死四件事:
//  1. widget 内右键 → 阻止原生菜单 + 回传正确的 blockStart / source / 坐标
//  2. widget 外右键 → 不拦截(交还浏览器默认菜单)
//  3. 展开态 / 只读态 / 多个 mermaid 块的上下文不串
//  4. doc 在右键前发生平移时,位置仍能解析到当前块 —— 这是「不在 widget 上
//     缓存 pos、改用 view.nodeDOM 反查」的理由,缓存值会 stale。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import { mermaidDecoration, mermaidDecoKey } from '../nodes/MermaidDecoration'
import {
  createMermaidContextMenuPlugin,
  type MermaidContextTarget,
} from '../plugins/mermaidContextMenu'

const MD = ['intro', '', '```mermaid', 'graph TD', '  A-->B', '```', '', 'after'].join('\n')

function makeView(
  md: string,
  onMenu: (target: MermaidContextTarget) => void,
  editable = true,
): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(md, schema),
    plugins: [
      // 与 CANONICAL_PLUGIN_ORDER 一致:拦截型插件在装饰插件之前
      createMermaidContextMenuPlugin({ onMermaidContextMenu: onMenu }),
      mermaidDecoration,
    ],
  })
  return new EditorView(container, { state, editable: () => editable })
}

function rightClick(el: Element, x = 120, y = 80): MouseEvent {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  })
  el.dispatchEvent(event)
  return event
}

function mermaidPositions(view: EditorView): number[] {
  const positions: number[] = []
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'code_block' && (node.attrs.language as string) === 'mermaid') {
      positions.push(pos)
      return false
    }
    return true
  })
  return positions
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    const parent = el.parentElement
    if (parent) parent.remove()
  })
})

describe('mermaidContextMenu 拦截与解析', () => {
  it('1. widget 内右键:阻止原生菜单,回传节点 pos / 源码 / SVG DOM / 坐标', () => {
    const onMenu = vi.fn()
    const view = makeView(MD, onMenu)
    const area = view.dom.querySelector('.mermaid-widget .mermaid-svg-area')
    expect(area).not.toBeNull()

    const event = rightClick(area!)
    expect(event.defaultPrevented).toBe(true)
    expect(onMenu).toHaveBeenCalledTimes(1)

    const ctx = onMenu.mock.calls[0][0] as MermaidContextTarget
    expect(ctx.blockStart).toBe(mermaidPositions(view)[0])
    expect(ctx.sourcePos).toBe(ctx.blockStart + 1)
    expect(ctx.source).toContain('graph TD')
    expect(ctx.source).toContain('A-->B')
    expect(ctx.isEditing).toBe(false)
    expect(ctx.editable).toBe(true)
    expect(ctx.svgArea).toBe(area)
    expect(ctx.x).toBe(120)
    expect(ctx.y).toBe(80)

    view.destroy()
  })

  it('2. 普通段落右键:不拦截,也不触发回调', () => {
    const onMenu = vi.fn()
    const view = makeView(MD, onMenu)
    const paragraph = view.dom.querySelector('p')
    expect(paragraph).not.toBeNull()

    const event = rightClick(paragraph!)
    expect(event.defaultPrevented).toBe(false)
    expect(onMenu).not.toHaveBeenCalled()

    view.destroy()
  })

  it('3. 展开源码态右键:isEditing=true;只读态右键:editable=false', () => {
    const onMenu = vi.fn()
    const view = makeView(MD, onMenu)
    const pos = mermaidPositions(view)[0]
    view.dispatch(view.state.tr.setMeta(mermaidDecoKey, { toggleEditAt: pos + 1 }))

    const widget = view.dom.querySelector('.mermaid-widget')!
    expect(widget.classList.contains('is-editing')).toBe(true)
    rightClick(widget.querySelector('.mermaid-svg-area')!)
    expect((onMenu.mock.calls[0][0] as MermaidContextTarget).isEditing).toBe(true)
    view.destroy()

    const readonlyMenu = vi.fn()
    const readonlyView = makeView(MD, readonlyMenu, false)
    const readonlyArea = readonlyView.dom.querySelector('.mermaid-widget .mermaid-svg-area')!
    rightClick(readonlyArea)
    expect((readonlyMenu.mock.calls[0][0] as MermaidContextTarget).editable).toBe(false)
    readonlyView.destroy()
  })

  it('4. 两个相邻 mermaid 块:右键第二个解析到第二个块', () => {
    const md = [
      '```mermaid',
      'graph TD',
      '  A-->B',
      '```',
      '',
      '```mermaid',
      'graph LR',
      '  X-->Y',
      '```',
    ].join('\n')
    const onMenu = vi.fn()
    const view = makeView(md, onMenu)
    const positions = mermaidPositions(view)
    expect(positions).toHaveLength(2)

    const widgets = view.dom.querySelectorAll('.mermaid-widget')
    expect(widgets).toHaveLength(2)
    rightClick(widgets[1].querySelector('.mermaid-svg-area')!)

    const ctx = onMenu.mock.calls[0][0] as MermaidContextTarget
    expect(ctx.blockStart).toBe(positions[1])
    expect(ctx.source).toContain('graph LR')
    expect(ctx.source).not.toContain('graph TD')
    view.destroy()
  })

  it('5. doc 平移后右键:位置跟随当前文档,不是右键前缓存的旧 pos', () => {
    const onMenu = vi.fn()
    const view = makeView(MD, onMenu)
    const oldPos = mermaidPositions(view)[0]

    // 在开头段落插入一个字符 → mermaid 块整体后移 1
    view.dispatch(view.state.tr.insertText('X', 1))
    const newPos = mermaidPositions(view)[0]
    expect(newPos).toBe(oldPos + 1)

    const area = view.dom.querySelector('.mermaid-widget .mermaid-svg-area')!
    rightClick(area)
    const ctx = onMenu.mock.calls[0][0] as MermaidContextTarget
    expect(ctx.blockStart).toBe(newPos)
    expect(ctx.sourcePos).toBe(newPos + 1)
    view.destroy()
  })
})
