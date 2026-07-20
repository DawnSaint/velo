// HtmlNodeView 单元测试
//
// 覆盖:
//  1. 安全 HTML(<details>/<kbd>)被保留
//  2. <script> 被剥
//  3. on* 事件属性被剥
//  4. javascript: URL 被剥
//  5. NodeView dom 是 div / span,attrs.value 被 sanitize 写入 innerHTML
//  6. HTML 块内 <img> src 走 proxyDomURL 代理(与 image NodeView 同款)
//  7. 块级 HTML 源码切换:点击按钮 → code_block / 光标移出 commit / Escape cancel / 阅读模式

import { describe, expect, it } from 'vitest'
import { __test_safeRender, createHtmlNodeViewPlugin } from '../HtmlNodeView'
import { htmlSourceEditPlugin, htmlSourceEditEscapeKeymap } from '../../plugins/htmlSourceEdit'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../../editor/schema'

const identityProxy = (u: string): string => u

function sanitize(raw: string): string {
  const div = document.createElement('div')
  __test_safeRender(div, raw)
  return div.innerHTML
}

describe('HtmlNodeView - sanitize 行为', () => {
  it('<details>/<summary> 被保留', () => {
    const out = sanitize('<details><summary>X</summary>Y</details>')
    expect(out).toContain('<details>')
    expect(out).toContain('<summary>')
    expect(out).toContain('Y')
  })

  it('<kbd>/<sub>/<sup>/<mark> 被保留', () => {
    expect(sanitize('<kbd>Ctrl</kbd>')).toContain('<kbd>')
    expect(sanitize('H<sub>2</sub>O')).toContain('<sub>')
    expect(sanitize('x<sup>2</sup>')).toContain('<sup>')
    expect(sanitize('<mark>highlight</mark>')).toContain('<mark>')
  })

  it('<script> 被剥光', () => {
    const out = sanitize('<script>alert(1)</script>safe')
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert')
    expect(out).toContain('safe')
  })

  it('on* 事件属性被剥', () => {
    const out = sanitize('<img src="x" onerror="alert(1)">')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('alert')
  })

  it('javascript: URL 被剥', () => {
    const out = sanitize('<a href="javascript:alert(1)">click</a>')
    expect(out).not.toMatch(/href\s*=\s*["']?javascript:/i)
  })

  it('<iframe> 被禁(防 frame embedding)', () => {
    const out = sanitize('<iframe src="https://evil.example"></iframe>')
    expect(out).not.toContain('iframe')
  })

  it('普通 https 链接保留', () => {
    const out = sanitize('<a href="https://example.com">x</a>')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('x')
  })
})

describe('HtmlNodeView - 真实 EditorView 渲染', () => {
  function mountView(value: string, kind: 'block' | 'inline', proxyDomURL = identityProxy) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const inner = kind === 'block'
      ? schema.node('html_block', { value })
      : schema.node('paragraph', null, [schema.node('html_inline', { value })])
    const doc = schema.node('doc', null, [
      kind === 'block' ? inner : inner,
    ])
    const plugin = createHtmlNodeViewPlugin({ proxyDomURL })
    const state = EditorState.create({ doc, schema, plugins: [plugin] })
    const view = new EditorView(host, { state })
    return { view, host, cleanup: () => { view.destroy(); host.remove() } }
  }

  it('html_block 渲染:dom 是 div.velo-html-block,sanitize 后 innerHTML', () => {
    const { view, cleanup } = mountView('<details><summary>X</summary>Y</details>', 'block')
    const blockDom = view.dom.querySelector('.velo-html-block')
    expect(blockDom).not.toBeNull()
    expect(blockDom!.tagName.toLowerCase()).toBe('div')
    expect(blockDom!.querySelector('details')).not.toBeNull()
    expect(blockDom!.querySelector('summary')?.textContent).toBe('X')
    cleanup()
  })

  it('html_inline 渲染:dom 是 span.velo-html-inline,sanitize 后 innerHTML', () => {
    const { view, cleanup } = mountView('<kbd>Ctrl</kbd>', 'inline')
    const inlineDom = view.dom.querySelector('.velo-html-inline')
    expect(inlineDom).not.toBeNull()
    expect(inlineDom!.tagName.toLowerCase()).toBe('span')
    expect(inlineDom!.querySelector('kbd')?.textContent).toBe('Ctrl')
    cleanup()
  })

  it('html_block 内的 <script> 不被 NodeView 渲染', () => {
    const { view, cleanup } = mountView('<script>alert(1)</script><p>safe</p>', 'block')
    const blockDom = view.dom.querySelector('.velo-html-block') as HTMLElement
    expect(blockDom.innerHTML).not.toContain('script')
    expect(blockDom.innerHTML).toContain('safe')
    cleanup()
  })
})

describe('HtmlNodeView - img src 代理', () => {
  it('html_block 内 <img> src 走 proxyDomURL', () => {
    const proxy = (url: string) => `asset://proxy/${url}`
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = schema.node('doc', null, [
      schema.node('html_block', { value: '<img src="assets/img.png" alt="x">' }),
    ])
    const plugin = createHtmlNodeViewPlugin({ proxyDomURL: proxy })
    const state = EditorState.create({ doc, schema, plugins: [plugin] })
    const view = new EditorView(host, { state })

    const img = view.dom.querySelector('.velo-html-block img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('asset://proxy/assets/img.png')
    expect(img.alt).toBe('x')
    view.destroy()
    host.remove()
  })

  it('html_inline 内 <img> src 走 proxyDomURL', () => {
    const proxy = (url: string) => `asset://proxy/${url}`
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.node('html_inline', { value: '<img src="pic.jpg">' }),
      ]),
    ])
    const plugin = createHtmlNodeViewPlugin({ proxyDomURL: proxy })
    const state = EditorState.create({ doc, schema, plugins: [plugin] })
    const view = new EditorView(host, { state })

    const img = view.dom.querySelector('.velo-html-inline img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('asset://proxy/pic.jpg')
    view.destroy()
    host.remove()
  })

  it('http(s) / data: src 经 proxyDomURL 透传(image NodeView 同款 resolveImageSrc 已处理)', () => {
    // resolveImageSrc 对 http(s)/data:/asset:/tauri: 原样返回;这里用 identity 模拟
    const proxy = (url: string) => url
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = schema.node('doc', null, [
      schema.node('html_block', { value: '<img src="https://example.com/a.png">' }),
    ])
    const plugin = createHtmlNodeViewPlugin({ proxyDomURL: proxy })
    const state = EditorState.create({ doc, schema, plugins: [plugin] })
    const view = new EditorView(host, { state })

    const img = view.dom.querySelector('.velo-html-block img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('https://example.com/a.png')
    view.destroy()
    host.remove()
  })

  it('无 src 的 <img> 不报错(跳过代理)', () => {
    const proxy = (url: string) => `asset://proxy/${url}`
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = schema.node('doc', null, [
      schema.node('html_block', { value: '<img alt="no-src">' }),
    ])
    const plugin = createHtmlNodeViewPlugin({ proxyDomURL: proxy })
    const state = EditorState.create({ doc, schema, plugins: [plugin] })
    const view = new EditorView(host, { state })

    const img = view.dom.querySelector('.velo-html-block img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.alt).toBe('no-src')
    view.destroy()
    host.remove()
  })
})

describe('HtmlNodeView - 块级 HTML 源码切换(code_block 范式)', () => {
  function mountBlockView(value: string, editable?: () => boolean) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    // doc = paragraph(空) + html_block + paragraph(空)
    // 空段提供"光标移出 code_block"的着陆点
    const doc = schema.node('doc', null, [
      schema.node('paragraph'),
      schema.node('html_block', { value }),
      schema.node('paragraph'),
    ])
    const nodeViewPlugin = createHtmlNodeViewPlugin({ proxyDomURL: identityProxy })
    const plugins = [nodeViewPlugin, htmlSourceEditPlugin, htmlSourceEditEscapeKeymap]
    const state = EditorState.create({ doc, schema, plugins })
    const view = new EditorView(host, { state, editable })
    return { view, host, cleanup: () => { view.destroy(); host.remove() } }
  }

  it('渲染态:右上角有源码切换按钮(code-xml svg)', () => {
    const { view, cleanup } = mountBlockView('<details><summary>X</summary>Y</details>')
    const btn = view.dom.querySelector('.html-source-toggle-btn')
    expect(btn).not.toBeNull()
    expect(btn!.tagName.toLowerCase()).toBe('button')
    expect(btn!.innerHTML).toContain('<svg')
    cleanup()
  })

  it('点击按钮:html_block 被替换为 code_block,内容为原始 HTML 源码', () => {
    const { view, cleanup } = mountBlockView('<details><summary>X</summary>Y</details>')
    const btn = view.dom.querySelector('.html-source-toggle-btn') as HTMLButtonElement
    btn.click()

    // html_block 消失,code_block 出现(doc.child(0)=空段, child(1)=code_block)
    expect(view.dom.querySelector('.velo-html-block')).toBeNull()
    const codeBlock = view.state.doc.child(1)
    expect(codeBlock.type.name).toBe('code_block')
    expect(codeBlock.attrs.language).toBe('html')
    expect(codeBlock.textContent).toBe('<details><summary>X</summary>Y</details>')
    cleanup()
  })

  it('光标移出 code_block → commit:code_block 替换回 html_block,值更新', () => {
    const { view, cleanup } = mountBlockView('<p>old</p>')
    const btn = view.dom.querySelector('.html-source-toggle-btn') as HTMLButtonElement
    btn.click()

    // doc = paragraph(2) + code_block + paragraph(2),code_block 在 pos 2
    const codeBlockPos = 2
    const codeBlock = view.state.doc.nodeAt(codeBlockPos)!
    expect(codeBlock.type.name).toBe('code_block')

    // 修改 code_block 内容(替换全部文本)
    const textStart = codeBlockPos + 1
    const textEnd = codeBlockPos + codeBlock.nodeSize - 1
    view.dispatch(view.state.tr.replaceWith(textStart, textEnd, view.state.schema.text('<p>new</p>')))

    // 光标移出 code_block → 移到第一个空段(pos 1 = 段内)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))

    // commit:code_block 替换回 html_block,值已更新
    const htmlBlock = view.state.doc.nodeAt(codeBlockPos)!
    expect(htmlBlock.type.name).toBe('html_block')
    expect(htmlBlock.attrs.value).toBe('<p>new</p>')
    // 渲染态恢复
    expect(view.dom.querySelector('.velo-html-block')).not.toBeNull()
    cleanup()
  })

  it('光标移出 code_block 值未变 → commit 仍替换回 html_block(原值)', () => {
    const { view, cleanup } = mountBlockView('<p>x</p>')
    const btn = view.dom.querySelector('.html-source-toggle-btn') as HTMLButtonElement
    btn.click()

    // 不改内容,直接移出光标到第一个空段
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))

    // commit:code_block 替换回 html_block,值不变
    const htmlBlock = view.state.doc.nodeAt(2)!
    expect(htmlBlock.type.name).toBe('html_block')
    expect(htmlBlock.attrs.value).toBe('<p>x</p>')
    cleanup()
  })

  it('Escape cancel:code_block 替换回 html_block,还原原始 HTML', () => {
    const { view, cleanup } = mountBlockView('<p>original</p>')
    const btn = view.dom.querySelector('.html-source-toggle-btn') as HTMLButtonElement
    btn.click()

    // 修改 code_block 内容
    view.dispatch(view.state.tr.insertText('<p>changed</p>', 3))

    // 按 Escape(keymap 插件监听 keydown)
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    // cancel:code_block 替换回 html_block,值还原
    const htmlBlock = view.state.doc.nodeAt(2)!
    expect(htmlBlock.type.name).toBe('html_block')
    expect(htmlBlock.attrs.value).toBe('<p>original</p>')
    cleanup()
  })

  it('阅读模式:不渲染源码切换按钮', () => {
    const { view, cleanup } = mountBlockView('<p>x</p>', () => false)
    const btn = view.dom.querySelector('.html-source-toggle-btn')
    expect(btn).toBeNull()
    cleanup()
  })

})
