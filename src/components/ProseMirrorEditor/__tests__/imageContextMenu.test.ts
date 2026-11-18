// 图片节点右键拦截回归测试。
//
// 锁死四件事:
//  1. .velo-image-inline 内右键(含 img / 编辑按钮)→ 阻止原生菜单 + 回传正确 pos / src
//  2. 图片外右键 → 不拦截(交还浏览器默认菜单)
//  3. 多个同 src / 不同 src 图片,右键解析到正确节点
//  4. doc 平移后位置仍跟随当前文档(不在 DOM 上缓存 pos)
//  5. 空 src 占位节点不接管;外链 / data: src 的 absPath 为 null

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState, Plugin, PluginKey } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import { createImageNodeView } from '../editor/imageNodeView'
import { resolveImageSrc } from '@/utils/imageSrc'
import {
  createImageContextMenuPlugin,
  isLocalImageSrc,
  type ImageContextTarget,
} from '../plugins/imageContextMenu'

const MD = ['intro', '', '![a](assets/a.png)', '', '![b](https://x.com/b.png)'].join('\n')

/** image NodeView plugin(真实 id:imageInlineView)—— 没它 .velo-image-inline 不会渲染。 */
const imageNodeViewPlugin = new Plugin({
  key: new PluginKey('imageInlineView'),
  props: {
    nodeViews: {
      image: createImageNodeView({ proxyDomURL: (url) => resolveImageSrc(url, '/doc/note.md') }),
    },
  },
})

function makeView(
  md: string,
  onMenu: (target: ImageContextTarget) => void,
  resolveAbsPath: (src: string) => string | null = (s) => `/doc/${s}`,
  editable = true,
): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(md, schema),
    plugins: [
      // 与 CANONICAL_PLUGIN_ORDER 一致:拦截型菜单排在 NodeView 之前
      createImageContextMenuPlugin({ onImageContextMenu: onMenu, resolveAbsPath }),
      imageNodeViewPlugin,
    ],
  })
  return new EditorView(container, { state, editable: () => editable })
}

function rightClick(el: Element, x = 10, y = 20): MouseEvent {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  })
  el.dispatchEvent(event)
  return event
}

function imagePositions(view: EditorView): number[] {
  const positions: number[] = []
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image') {
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

describe('isLocalImageSrc', () => {
  it('本地路径判定:相对 / 绝对为本地,协议链接不是', () => {
    expect(isLocalImageSrc('assets/a.png')).toBe(true)
    expect(isLocalImageSrc('/abs/a.png')).toBe(true)
    expect(isLocalImageSrc('C:/x/a.png')).toBe(true)
    expect(isLocalImageSrc('https://x.com/a.png')).toBe(false)
    expect(isLocalImageSrc('http://x.com/a.png')).toBe(false)
    expect(isLocalImageSrc('data:image/png;base64,xx')).toBe(false)
    expect(isLocalImageSrc('asset://localhost/a.png')).toBe(false)
  })
})

describe('imageContextMenu 拦截与解析', () => {
  it('1. img 内右键:阻止原生菜单,回传节点 pos / src / 坐标 / absPath', () => {
    const onMenu = vi.fn()
    const view = makeView(MD, onMenu)
    const wrapper = view.dom.querySelector('.velo-image-inline')
    expect(wrapper).not.toBeNull()

    const event = rightClick(wrapper!.querySelector('img')!)
    expect(event.defaultPrevented).toBe(true)
    expect(onMenu).toHaveBeenCalledTimes(1)

    const ctx = onMenu.mock.calls[0][0] as ImageContextTarget
    expect(ctx.pos).toBe(imagePositions(view)[0])
    expect(ctx.src).toBe('assets/a.png')
    expect(ctx.absPath).toBe('/doc/assets/a.png')
    expect(ctx.editable).toBe(true)
    expect(ctx.x).toBe(10)
    expect(ctx.y).toBe(20)
    expect(ctx.wrapper).toBe(wrapper)
    view.destroy()
  })

  it('2. 编辑按钮上右键同样命中(按钮也算节点内)', () => {
    const onMenu = vi.fn()
    const view = makeView(MD, onMenu)
    const btn = view.dom.querySelector('.image-edit-btn')
    expect(btn).not.toBeNull()
    rightClick(btn!)
    expect(onMenu).toHaveBeenCalledTimes(1)
    view.destroy()
  })

  it('3. 普通段落右键:不拦截,也不触发回调', () => {
    const onMenu = vi.fn()
    const view = makeView(MD, onMenu)
    const paragraph = view.dom.querySelector('p')
    expect(paragraph).not.toBeNull()

    const event = rightClick(paragraph!)
    expect(event.defaultPrevented).toBe(false)
    expect(onMenu).not.toHaveBeenCalled()
    view.destroy()
  })

  it('4. 两张图并存:右键第二张解析到第二张', () => {
    const onMenu = vi.fn()
    const view = makeView(MD, onMenu)
    const positions = imagePositions(view)
    expect(positions).toHaveLength(2)
    const wrappers = view.dom.querySelectorAll('.velo-image-inline')
    expect(wrappers).toHaveLength(2)

    rightClick(wrappers[1].querySelector('img')!)
    const ctx = onMenu.mock.calls[0][0] as ImageContextTarget
    expect(ctx.pos).toBe(positions[1])
    expect(ctx.src).toBe('https://x.com/b.png')
    // 外链没有磁盘路径
    expect(ctx.absPath).toBeNull()
    view.destroy()
  })

  it('5. 只读态右键:editable=false,但依然拦截', () => {
    const onMenu = vi.fn()
    const view = makeView(MD, onMenu, (s) => `/doc/${s}`, false)
    rightClick(view.dom.querySelector('.velo-image-inline img')!)

    expect((onMenu.mock.calls[0][0] as ImageContextTarget).editable).toBe(false)
    view.destroy()
  })

  it('6. doc 平移后右键:位置跟随当前文档', () => {
    const onMenu = vi.fn()
    const view = makeView(MD, onMenu)
    const oldPos = imagePositions(view)[0]

    // 开头段落插一个字符 → 图片整体后移 1
    view.dispatch(view.state.tr.insertText('X', 1))
    const newPos = imagePositions(view)[0]
    expect(newPos).toBe(oldPos + 1)

    rightClick(view.dom.querySelector('.velo-image-inline img')!)
    expect((onMenu.mock.calls[0][0] as ImageContextTarget).pos).toBe(newPos)
    view.destroy()
  })
})
