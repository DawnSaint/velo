// 图片右键菜单命令回归测试 —— 走真实 EditorView,先由拦截插件拿到上下文,
// 再把 ctx 交给 runImageMenuAction,覆盖复制 / 剪切 / 删除节点 / 删除文件的边界。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { EditorState, Plugin, PluginKey } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import { createImageNodeView } from '../editor/imageNodeView'
import { resolveImageSrc } from '@/utils/imageSrc'
import { remove } from '@/tauri/fs'
import { runImageMenuAction } from '../nodes/imageContextActions'
import { createImageContextMenuPlugin, type ImageContextTarget } from '../plugins/imageContextMenu'
import { useNotifyStore } from '@/stores/notify'

// 自绘确认框在单测里没有 VeloConfirmDialog 挂载,用 ask 桩结算;默认「取消」。
const { confirmAsk } = vi.hoisted(() => ({ confirmAsk: vi.fn() }))
vi.mock('@/stores/confirm', () => ({
  useConfirmStore: () => ({ ask: confirmAsk }),
}))

const DOC = '/doc/note.md'
const MD = ['intro', '', '![a](assets/a.png)', '', '![b](assets/b.png)'].join('\n')

let captured: ImageContextTarget | null = null

const imageNodeViewPlugin = new Plugin({
  key: new PluginKey('imageInlineView'),
  props: {
    nodeViews: {
      image: createImageNodeView({ proxyDomURL: (url) => resolveImageSrc(url, DOC) }),
    },
  },
})

function makeView(editable = true): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  captured = null
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(MD, schema),
    plugins: [
      createImageContextMenuPlugin({
        onImageContextMenu: (t) => {
          captured = t
        },
        resolveAbsPath: (src) => `/doc/${src}`,
      }),
      imageNodeViewPlugin,
    ],
  })
  return new EditorView(container, { state, editable: () => editable })
}

function captureTarget(view: EditorView, index = 0): ImageContextTarget {
  const wrappers = view.dom.querySelectorAll('.velo-image-inline')
  wrappers[index]
    .querySelector('img')!
    .dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 2 }),
    )
  if (!captured) throw new Error('右键未被拦截')
  return captured
}

function images(view: EditorView): string[] {
  const out: string[] = []
  view.state.doc.descendants((node) => {
    if (node.type.name === 'image') out.push(node.attrs.src as string)
    return true
  })
  return out
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(writeText).mockClear()
  vi.mocked(remove).mockClear()
})

afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    const parent = el.parentElement
    if (parent) parent.remove()
  })
})

describe('runImageMenuAction', () => {
  it('复制 Markdown:写完整 `![alt](src)`,含 title 时一并写出', async () => {
    const view = makeView()
    const ctx = captureTarget(view)

    await runImageMenuAction(view, ctx, 'copy-markdown', DOC)
    const text = vi.mocked(writeText).mock.calls[0][0] as string
    expect(text).toBe('![a](assets/a.png)')
    view.destroy()
  })

  it('复制路径 / 相对路径:绝对路径原样,相对路径剥掉文档目录前缀', async () => {
    const view = makeView()
    const ctx = captureTarget(view)

    await runImageMenuAction(view, ctx, 'copy-path', DOC)
    expect(vi.mocked(writeText).mock.calls[0][0]).toBe('/doc/assets/a.png')

    await runImageMenuAction(view, ctx, 'copy-relative-path', DOC)
    expect(vi.mocked(writeText).mock.calls[1][0]).toBe('assets/a.png')
    view.destroy()
  })

  it('剪切:先复制到剪贴板,再删掉该节点,其余节点保留', async () => {
    const view = makeView()
    const ctx = captureTarget(view)

    await runImageMenuAction(view, ctx, 'cut', DOC)
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(images(view)).toEqual(['assets/b.png'])
    view.destroy()
  })

  it('删除图片节点:只删节点不动磁盘,不写剪贴板', async () => {
    const view = makeView()
    const ctx = captureTarget(view)

    await runImageMenuAction(view, ctx, 'delete-node', DOC)
    expect(images(view)).toEqual(['assets/b.png'])
    expect(remove).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
    view.destroy()
  })

  it('删除图片文件:确认后删文件 + 移除所有引用它的节点(同 src 多次出现全删)', async () => {
    const md = ['![a](assets/a.png)', '', '![again](assets/a.png)'].join('\n')
    const container = document.createElement('div')
    document.body.appendChild(container)
    captured = null
    const state = EditorState.create({
      schema,
      doc: fromMarkdown(md, schema),
      plugins: [
        createImageContextMenuPlugin({
          onImageContextMenu: (t) => {
            captured = t
          },
          resolveAbsPath: (src) => `/doc/${src}`,
        }),
        imageNodeViewPlugin,
      ],
    })
    const view = new EditorView(container, { state, editable: () => true })
    confirmAsk.mockResolvedValue(true)

    const ctx = captureTarget(view, 0)
    await runImageMenuAction(view, ctx, 'delete-file', DOC)

    expect(remove).toHaveBeenCalledWith('/doc/assets/a.png')
    expect(images(view)).toEqual([])
    view.destroy()
  })

  it('删除图片文件被取消(confirm=false):既不删文件也不改文档', async () => {
    const view = makeView()
    confirmAsk.mockResolvedValue(false)
    const ctx = captureTarget(view)

    await runImageMenuAction(view, ctx, 'delete-file', DOC)

    expect(remove).not.toHaveBeenCalled()
    expect(images(view)).toHaveLength(2)
    view.destroy()
  })

  it('只读态下写操作收敛为 info Toast,不落任何变更', async () => {
    const view = makeView(false)
    const ctx = captureTarget(view)

    await runImageMenuAction(view, ctx, 'delete-node', DOC)
    await runImageMenuAction(view, ctx, 'cut', DOC)

    expect(images(view)).toHaveLength(2)
    expect(remove).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()
    const store = useNotifyStore()
    expect(store.toasts.some((t) => t.type === 'info')).toBe(true)
    view.destroy()
  })

  it('复制类动作在 doc 变化后仍能用快照兜底(节点找不到时用 ctx 快照)', async () => {
    const view = makeView()
    const ctx = captureTarget(view)
    // 把两张图都删掉 → liveImage 找不到节点
    view.dispatch(view.state.tr.delete(0, view.state.doc.content.size))

    await runImageMenuAction(view, ctx, 'copy-markdown', DOC)
    expect(vi.mocked(writeText).mock.calls[0][0]).toBe('![a](assets/a.png)')
    view.destroy()
  })

  it('外链图片复制路径 → error Toast,不抛异常', async () => {
    const md = ['![x](https://example.com/x.png)'].join('\n')
    const container = document.createElement('div')
    document.body.appendChild(container)
    captured = null
    const state = EditorState.create({
      schema,
      doc: fromMarkdown(md, schema),
      plugins: [
        createImageContextMenuPlugin({
          onImageContextMenu: (t) => {
            captured = t
          },
          resolveAbsPath: () => null,
        }),
        imageNodeViewPlugin,
      ],
    })
    const view = new EditorView(container, { state, editable: () => true })
    const ctx = captureTarget(view)

    await expect(runImageMenuAction(view, ctx, 'copy-path', DOC)).resolves.toBeUndefined()
    expect(useNotifyStore().toasts.some((t) => t.type === 'error')).toBe(true)
    view.destroy()
  })
})
