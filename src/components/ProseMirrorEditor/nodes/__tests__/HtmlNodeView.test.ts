// HtmlNodeView 单元测试
//
// 覆盖:
//  1. 安全 HTML(<details>/<kbd>)被保留
//  2. <script> 被剥
//  3. on* 事件属性被剥
//  4. javascript: URL 被剥
//  5. NodeView dom 是 div / span,attrs.value 被 sanitize 写入 innerHTML

import { describe, expect, it } from 'vitest'
import { __test_safeRender, htmlNodeViewPlugin } from '../HtmlNodeView'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../../editor/schema'

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
  function mountView(value: string, kind: 'block' | 'inline') {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const inner = kind === 'block'
      ? schema.node('html_block', { value })
      : schema.node('paragraph', null, [schema.node('html_inline', { value })])
    const doc = schema.node('doc', null, [
      kind === 'block' ? inner : inner,
    ])
    const state = EditorState.create({ doc, schema, plugins: [htmlNodeViewPlugin] })
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