// linkClickPlugin 单元测试
//
// 模式参照 nodes/__tests__/FootnoteNodeViews.integration.test.ts ——
// 真实 EditorView + MouseEvent.dispatchEvent,jsdom 不支持的能力(
// scrollIntoView)polyfill 成 vi.fn。

import { describe, expect, it, beforeEach, vi } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { Schema } from 'prosemirror-model'
import { linkClickPlugin, linkClickPluginKey } from '../linkClick'
import { SKIP_CONTENT_EMIT } from '../../editor/transactionMeta'
import { open } from '@tauri-apps/plugin-shell'

// jsdom 不实现 scrollIntoView;module-scope 持有 mock 实例,各测试 reset 后再断言。
const scrollIntoViewMock = vi.fn()

// 最小 schema:只要 doc/paragraph/heading/text + link mark 够 linkClick 测试用。
// 走本地 schema 避免和 production schema(image/table/mermaid/...)耦合,失败信号更清晰。
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    heading: {
      content: 'inline*',
      group: 'block',
      defining: true,
      attrs: {
        id: { default: '' },
        level: { default: 1 },
      },
      parseDOM: [1, 2, 3, 4, 5, 6].map(level => ({
        tag: `h${level}`,
        getAttrs: (dom: HTMLElement) => ({ level, id: dom.id }),
      })),
      toDOM: node => [`h${node.attrs.level}`, { id: node.attrs.id as string }, 0],
    },
  },
  marks: {
    link: {
      attrs: {
        href: {},
        title: { default: null },
      },
      parseDOM: [{
        tag: 'a[href]',
        getAttrs: (dom: HTMLElement) => ({
          href: dom.getAttribute('href'),
          title: dom.getAttribute('title'),
        }),
      }],
      toDOM: mark => ['a', { ...mark.attrs }],
    },
  },
})

beforeEach(() => {
  scrollIntoViewMock.mockReset()
  Element.prototype.scrollIntoView = scrollIntoViewMock
  vi.mocked(open).mockReset()
  vi.mocked(open).mockResolvedValue(undefined)
})

interface Mounted {
  view: EditorView
  host: HTMLElement
  cleanup: () => void
}

function mountView(doc: ReturnType<typeof schema.node>): Mounted {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const state = EditorState.create({ doc, schema, plugins: [linkClickPlugin] })
  const view = new EditorView(host, { state })
  return {
    view,
    host,
    cleanup: () => {
      view.destroy()
      host.remove()
    },
  }
}

function paragraphWithLink(href: string, label = 'link') {
  const linkMark = schema.marks.link.create({ href })
  return schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text(label, [linkMark])]),
  ])
}

describe('linkClickPlugin', () => {
  it('plain click on <a> swaps link with source text and starts edit session', () => {
    const { view, cleanup } = mountView(paragraphWithLink('https://x.com'))
    const a = view.dom.querySelector('a') as HTMLAnchorElement
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(event)
    expect(open).not.toHaveBeenCalled()
    // 渲染好的 <a> 被替换成源码文本
    expect(view.dom.querySelector('a')).toBeNull()
    expect(view.dom.textContent).toContain('[link](https://x.com)')
    // 光标落在源码内(不是 doc 头)
    expect(view.state.selection.from).toBeGreaterThan(0)
    expect(view.state.selection.from).toBeLessThan(view.state.doc.content.size)
    // plugin state 持有 edit session
    const pluginState = linkClickPluginKey.getState(view.state)
    expect(pluginState?.session).not.toBeNull()
    expect(pluginState?.session?.originalSource).toBe('[link](https://x.com)')
    // defaultPrevented = true(我们接管了 click)
    expect(event.defaultPrevented).toBe(true)
    cleanup()
  })

  it('enter edit session dispatches SKIP_CONTENT_EMIT (no content emit on link→source swap)', () => {
    // 进入编辑态是瞬时视图切换(link mark → 源码纯文本),不挂 SKIP_CONTENT_EMIT 会让
    // onChange 回写 toMarkdown 把纯文本转义成 \[..\]\(..),污染 documentStore.content;
    // 切源代码模式读到转义串,切回所见即所得后 fromMarkdown 解析转义串只剩纯文本,
    // 无法变回链接。参照 imageEditPlugin.triggerImageEdit 同款 meta。
    const { view, cleanup } = mountView(paragraphWithLink('https://x.com'))
    let captured: { tr: any } | null = null
    const origDispatch = view.dispatch
    view.dispatch = (tr: any) => {
      if (tr.getMeta(SKIP_CONTENT_EMIT) !== undefined) captured = { tr }
      origDispatch.call(view, tr)
    }
    const a = view.dom.querySelector('a') as HTMLAnchorElement
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    view.dispatch = origDispatch

    expect(captured).not.toBeNull()
    expect(captured!.tr.getMeta(SKIP_CONTENT_EMIT)).toBe(true)
    cleanup()
  })

  it('cursor leaving edit range commits: source parsed and link re-applied', () => {
    const { view, cleanup } = mountView(paragraphWithLink('https://x.com'))
    const a = view.dom.querySelector('a') as HTMLAnchorElement
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(view.dom.textContent).toContain('[link](https://x.com)')

    // 把光标移到 doc 末尾(editTo 之后)→ 离开 edit 范围 → 触发 commit
    // TextSelection.atStart(doc) 会落在 position 1(= editFrom),仍在范围内 → 不会触发 commit
    const endPos = view.state.doc.content.size
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, endPos)))

    // commit 后:源码文本消失,<a> 重新出现
    expect(view.dom.querySelector('a')).not.toBeNull()
    expect(view.dom.querySelector('a')?.getAttribute('href')).toBe('https://x.com')
    expect(view.dom.textContent).not.toContain('[')
    cleanup()
  })

  it('cursor leaving commits: space-containing anchor href preserved (no escape)', () => {
    // `[回到开头](# Markdown 语法)` 这种含空格的锚点 href:link.ts pattern 与
    // fromMarkdown 都把整段 `# Markdown 语法` 当 href。旧 parseLinkSource 正则
    // [^()\s]* 排空格 → commit 判残缺 → 纯文本被 toMarkdown 转义成 \[..\]\(..)。
    const { view, cleanup } = mountView(paragraphWithLink('# Markdown 语法'))
    const a = view.dom.querySelector('a') as HTMLAnchorElement
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    const endPos = view.state.doc.content.size
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, endPos)))

    expect(view.dom.querySelector('a')).not.toBeNull()
    expect(view.dom.querySelector('a')?.getAttribute('href')).toBe('# Markdown 语法')
    expect(view.dom.textContent).not.toContain('\\[')
    cleanup()
  })

  it('Ctrl+click on external URL calls open with the href', async () => {
    const { view, cleanup } = mountView(paragraphWithLink('https://x.com'))
    const a = view.dom.querySelector('a') as HTMLAnchorElement
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })
    a.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    // open() 是 async,等一个 microtask 让 promise 链解析到 mock
    await Promise.resolve()
    expect(open).toHaveBeenCalledWith('https://x.com')
    cleanup()
  })

  it('Cmd+click on external URL calls open with the href', async () => {
    const { view, cleanup } = mountView(paragraphWithLink('https://x.com'))
    const a = view.dom.querySelector('a') as HTMLAnchorElement
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })
    a.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await Promise.resolve()
    expect(open).toHaveBeenCalledWith('https://x.com')
    cleanup()
  })

  it('Ctrl+click on #anchor scrolls to matching heading and does not call open', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('back', [schema.marks.link.create({ href: '#section-1' })]),
      ]),
      schema.node('heading', { id: 'section-1', level: 2 }, [schema.text('Target')]),
    ])
    const { view, cleanup } = mountView(doc)
    const a = view.dom.querySelector('a') as HTMLAnchorElement
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    expect(open).not.toHaveBeenCalled()
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    cleanup()
  })

  it('Ctrl+click on #anchor with no matching heading does not throw and does nothing', () => {
    const { view, cleanup } = mountView(paragraphWithLink('#nonexistent'))
    const a = view.dom.querySelector('a') as HTMLAnchorElement
    expect(() => {
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    }).not.toThrow()
    expect(open).not.toHaveBeenCalled()
    expect(scrollIntoViewMock).not.toHaveBeenCalled()
    cleanup()
  })

  it('open rejection is swallowed with console.warn, no unhandled rejection', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(open).mockRejectedValueOnce(new Error('boom'))
    const { view, cleanup } = mountView(paragraphWithLink('https://nonexistent.invalid'))
    const a = view.dom.querySelector('a') as HTMLAnchorElement
    expect(() => {
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    }).not.toThrow()
    // 等 reject 走完到 console.warn
    await new Promise(r => setTimeout(r, 0))
    expect(warnSpy).toHaveBeenCalledWith(
      '[linkClick] failed to open',
      'https://nonexistent.invalid',
      expect.anything(),
    )
    warnSpy.mockRestore()
    cleanup()
  })

  it('click on plain text does not call open and does not throw', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('just text')]),
    ])
    const { view, cleanup } = mountView(doc)
    const p = view.dom.querySelector('p') as HTMLElement
    expect(() => {
      p.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    }).not.toThrow()
    expect(open).not.toHaveBeenCalled()
    cleanup()
  })
})