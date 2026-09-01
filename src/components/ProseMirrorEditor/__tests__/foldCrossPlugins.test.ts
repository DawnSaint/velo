// v0.5.12 折叠 × 其他 plugin 跨集成的回归测试。
//
// 隔离本文件 vs foldDecoration.test.ts 的原因:跨插件 set(foldedCodeBlockPosSet /
// foldedMermaidPosSet)挂在 FoldDecoration.ts 的 module-level,跟其他 fork /
// dispatch 重度 scenario 同 suite 跑在某些 dispatch 时序下会让 test 之间的
// module 状态不收敛(jsdom + async listener 残留)。把这两个核心 cross-plugin
// 用例抽到自己的文件,suite 短、状态干净,失败时不会被其他测试噪音掩盖。
//
// 关注:
//  1. codeLineNumber × fold:折叠含 code_block 的 heading → 行号不渲染;
//     展开 → 回来(对应 #23 时机修复)
//  2. mermaid × fold:折叠含 mermaid 的 heading → mermaid widget 不渲染;
//     展开 → 回来(对应 #25 跨插件集合同步)
//  3. toc × fold:折叠含 [TOC] 的 heading → toc widget 不渲染;
//     展开 → 回来(toc widget 是 block-level sibling,不受 velo-folded 影响)

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import { foldDecoration, foldKey } from '../nodes/FoldDecoration'
import { mermaidDecoration } from '../nodes/MermaidDecoration'
import { codeLineNumberPlugin, lineNumbersKey } from '../nodes/CodeLineNumberWidget'
import { tocDecoration } from '../nodes/TocDecoration'
import { syntaxAutoFormatPlugin } from '../plugins/syntaxAutoFormat'
import { history, undo } from 'prosemirror-history'

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
    // 找到 code_block 的 pos,toggle 开启该块的行号
    let codeBlockPos = -1
    view.state.doc.descendants((node, p) => {
      if (node.type.name === 'code_block' && codeBlockPos < 0) {
        codeBlockPos = p
        return false
      }
      return true
    })
    view.dispatch(view.state.tr.setMeta(lineNumbersKey, { toggle: codeBlockPos }))
    expect(view.dom.querySelector('.velo-code-lineno')).not.toBeNull()

    const contentStart = findHeadingContentStart(view, 'Section')
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: contentStart }))
    expect(view.dom.querySelector('.velo-code-lineno')).toBeNull()

    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: contentStart }))
    expect(view.dom.querySelector('.velo-code-lineno')).not.toBeNull()

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

describe('toc × fold', () => {
  it('折叠含 [TOC] 的 heading → toc widget 不渲染;展开 → 渲染回来', () => {
    const md = [
      '# Section',
      '',
      '[TOC]',
      '',
      '## Sub',
      '',
      'text',
      '',
    ].join('\n')
    const view = makeView(md, [foldDecoration, tocDecoration])
    expect(view.dom.querySelector('.velo-toc')).not.toBeNull()

    const contentStart = findHeadingContentStart(view, 'Section')
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: contentStart }))
    expect(view.dom.querySelector('.velo-toc')).toBeNull()

    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: contentStart }))
    expect(view.dom.querySelector('.velo-toc')).not.toBeNull()

    view.destroy()
  })

  it('点击删除按钮 → 整个 toc 节点被删除(不残留 [TOC] 文本)', () => {
    const md = [
      '# Section',
      '',
      '[TOC]',
      '',
      '## Sub',
      '',
      'text',
      '',
    ].join('\n')
    const view = makeView(md, [foldDecoration, tocDecoration, syntaxAutoFormatPlugin])
    expect(view.dom.querySelector('.velo-toc')).not.toBeNull()

    const deleteBtn = view.dom.querySelector('.velo-toc-delete-btn') as HTMLButtonElement
    expect(deleteBtn).not.toBeNull()
    deleteBtn.click()

    // toc widget 应消失
    expect(view.dom.querySelector('.velo-toc')).toBeNull()
    // doc 中不应还有 toc 节点
    let hasToc = false
    view.state.doc.descendants((node) => {
      if (node.type.name === 'toc') hasToc = true
    })
    expect(hasToc).toBe(false)
    // 不应残留 [TOC] 文本
    expect(view.state.doc.textContent).not.toContain('[TOC]')

    view.destroy()
  })

  it('删除 toc 后 undo → 光标不跳到文档开头', () => {
    const md = [
      '# Section',
      '',
      '[TOC]',
      '',
      '## Sub',
      '',
      'text',
      '',
    ].join('\n')
    const view = makeView(md, [
      foldDecoration,
      tocDecoration,
      syntaxAutoFormatPlugin,
      history(),
    ])
    // 把光标放到末尾的 text 段落
    const textParaEnd = view.state.doc.content.size - 1
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, textParaEnd),
    ))
    const cursorBefore = view.state.selection.head
    expect(cursorBefore).toBe(textParaEnd)

    // 点击删除
    const deleteBtn = view.dom.querySelector('.velo-toc-delete-btn') as HTMLButtonElement
    deleteBtn.click()
    expect(view.state.doc.textContent).not.toContain('[TOC]')

    // 删除后光标应在删除位置附近,不在文档开头(pos=1 之前)
    expect(view.state.selection.head).toBeGreaterThan(1)

    // undo
    undo(view.state, (tr) => view.dispatch(tr))

    // toc 节点应恢复
    expect(view.dom.querySelector('.velo-toc')).not.toBeNull()
    // 光标不应跳到文档开头(位置 0 或 1)
    expect(view.state.selection.head).toBeGreaterThan(1)

    view.destroy()
  })
})
