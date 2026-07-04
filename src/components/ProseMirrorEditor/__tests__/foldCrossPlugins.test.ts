// v0.5.12 折叠 × 其他 plugin 跨集成的回归测试。
//
// 隔离本文件 vs foldDecoration.test.ts 的原因:跨插件 set(foldedCodeBlockPosSet /
// foldedMermaidPosSet)挂在 FoldDecoration.ts 的 module-level,跟其他 fork /
// dispatch 重度 scenario 同 suite 跑在某些 dispatch 时序下会让 test 之间的
// module 状态不收敛(jsdom + async listener 残留)。把这两个核心 cross-plugin
// 用例抽到自己的文件,suite 短、状态干净,失败时不会被其他测试噪音掩盖。
//
// 关注:
//  1. codeLineNumber × fold:折叠含 code_block 的 heading → gutter 不渲染;
//     展开 → 回来(对应 #23 时机修复)
//  2. mermaid × fold:折叠含 mermaid 的 heading → mermaid widget 不渲染;
//     展开 → 回来(对应 #25 跨插件集合同步)

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import { foldDecoration, foldKey } from '../nodes/FoldDecoration'
import { mermaidDecoration } from '../nodes/MermaidDecoration'
import { codeLineNumberPlugin, lineNumbersKey } from '../nodes/CodeLineNumberWidget'

function makeView(initialMd: string, plugins: any[]): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(initialMd, schema),
    plugins,
  })
  return new EditorView(container, { state })
}

function findHeadingContentStart(view: EditorView, text: string): number {
  let contentStart = -1
  view.state.doc.descendants((node, p) => {
    if (node.type.name === 'heading' && node.textContent.includes(text) && contentStart < 0) {
      contentStart = p + 1
      return false
    }
    return true
  })
  return contentStart
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    el.parentElement?.remove()
  })
})

describe('codeLineNumber × fold', () => {
  it('折叠含 code_block 的 heading → 行号 widget 不渲染;展开 → 回来', () => {
    const md = [
      '# Section',
      '',
      '```js',
      'const a = 1',
      'const b = 2',
      '```',
      '',
    ].join('\n')
    const view = makeView(md, [foldDecoration, codeLineNumberPlugin])
    view.dispatch(view.state.tr.setMeta(lineNumbersKey, { enabled: true }))
    expect(view.dom.querySelector('.velo-code-gutter-widget')).not.toBeNull()

    const contentStart = findHeadingContentStart(view, 'Section')
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: contentStart }))
    expect(view.dom.querySelector('.velo-code-gutter-widget')).toBeNull()

    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: contentStart }))
    expect(view.dom.querySelector('.velo-code-gutter-widget')).not.toBeNull()

    view.destroy()
  })
})

describe('mermaid × fold', () => {
  it('折叠含 mermaid 的 heading → mermaid widget 不渲染;展开 → 渲染回来', () => {
    const md = [
      '# Section',
      '',
      '```mermaid',
      'graph TD',
      '  A-->B',
      '```',
      '',
    ].join('\n')
    const view = makeView(md, [foldDecoration, mermaidDecoration])
    expect(view.dom.querySelector('.mermaid-widget')).not.toBeNull()

    const contentStart = findHeadingContentStart(view, 'Section')
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: contentStart }))
    expect(view.dom.querySelector('.mermaid-widget')).toBeNull()

    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: contentStart }))
    expect(view.dom.querySelector('.mermaid-widget')).not.toBeNull()

    view.destroy()
  })
})
