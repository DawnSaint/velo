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
import { foldDecoration, foldKey, isCodeBlockAncestorFolded } from '../nodes/FoldDecoration'
import { mermaidDecoration } from '../nodes/MermaidDecoration'
import { codeLineNumberPlugin, lineNumbersKey } from '../nodes/CodeLineNumberWidget'
import { tocDecoration } from '../nodes/TocDecoration'
import { codeHighlightPlugin } from '../nodes/CodeHighlightWidget'
import { syntaxAutoFormatPlugin } from '../plugins/syntaxAutoFormat'
import { history, undo } from 'prosemirror-history'
import { CANONICAL_PLUGIN_ORDER } from '../plugins/order'

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

function findCodeBlockPos(view: EditorView): number {
  let pos = -1
  view.state.doc.descendants((node, p) => {
    if (node.type.name === 'code_block' && pos < 0) { pos = p; return false }
    return true
  })
  return pos
}

function findPlaceholderPos(view: EditorView): number {
  let pos = -1
  view.state.doc.descendants((node, p) => {
    if (node.type.name === 'fold_placeholder' && pos < 0) { pos = p; return false }
    return true
  })
  return pos
}

/** 统计当前 DOM 里 code block header widget 数量(`.velo-code-header-widget`)。
 *  与 codeHighlight.test.ts 的断言口径一致(jsdom 下 header widget 正常挂载)。 */
function countCodeHeaderWidgets(view: EditorView): number {
  return view.dom.querySelectorAll('.velo-code-header-widget').length
}

/** 按 CANONICAL_PLUGIN_ORDER 的真实顺序返回给定 plugin(用于忠实复现
 *  生产路径的 apply 顺序)。revert order.ts(把 codeHighlight 排到
 *  foldDecoration 之前)会让这里返回 [codeHighlightPlugin, foldDecoration],
 *  从而让"祖先折叠时 code block header 抑制"用例失败 —— 这正是本文件要锁的
 *  不变量。plugin 的 spec.key.name 与 canonical id 一致
 *  (foldKey=PluginKey('foldDecoration') / codeHighlightKey=PluginKey('codeHighlight'))。 */
function canonicalOrderOf(...plugins: any[]): any[] {
  const order = CANONICAL_PLUGIN_ORDER as readonly string[]
  return plugins.slice().sort((a, b) => {
    const ia = order.indexOf((a.spec.key as { name: string }).name)
    const ib = order.indexOf((b.spec.key as { name: string }).name)
    return ia - ib
  })
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

// ============================================================
//  codeHighlight × fold —— 祖先折叠时 code block header 抑制
//
//  回归:heading 折叠区段内含 code_block,在其 `...`(fold_placeholder)前输入
//  内容时,下方不得孤悬出一个 code block header。
//
//  抑制真正门控是 `isCodeBlockAncestorFolded(pos)`(读 module-level
//  `ancestorFoldedCodeBlockPosSet`,在 `foldDecoPlugin.apply` 内由
//  `recomputeFoldedCodeBlockPos` 刷新),与 plugin apply 顺序无直接因果 ——
//  PM 先跑完全部 apply 再统一调 `decorations(state)`,consumer 读到的永远是
//  本帧最新集合。下方用例验证「折叠态 header 抑制」这一不变量本身,以及
//  「在 `...` 前输入后抑制仍成立」;另用 plugin-order 不变量用例锁定
//  `foldDecoration` 必须排在所有读取该集合的 consumer 之前(消除
//  consumer 在自身 apply 增量重建时读集合的窄路径时序风险)。
// ============================================================

describe('codeHighlight × fold:祖先折叠时 code block header 抑制', () => {
  it('plugin 顺序:foldDecoration 必须排在所有读取 ancestor-folded 集合的装饰 plugin 之前', () => {
    const order = CANONICAL_PLUGIN_ORDER as readonly string[]
    const foldIdx = order.indexOf('foldDecoration')
    expect(foldIdx).toBeGreaterThanOrEqual(0)
    for (const consumer of ['codeHighlight', 'codeLineNumber', 'mermaidDecoration', 'tocDecoration']) {
      const cIdx = order.indexOf(consumer)
      expect(cIdx).toBeGreaterThanOrEqual(0)
      expect(foldIdx).toBeLessThan(cIdx)
    }
  })

  it('展开态 header 渲染、折叠态 header 抑制(基本机制)', () => {
    const md = ['# A', '', '```js', 'const x = 1', '```', ''].join('\n')
    const view = makeView(md, canonicalOrderOf(foldDecoration, codeHighlightPlugin))
    // 展开态:code block header 应渲染
    expect(countCodeHeaderWidgets(view)).toBe(1)

    const h = findHeadingContentStart(view, 'A')
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h }))
    // 折叠态:祖先折叠 → header 必须被抑制
    expect(countCodeHeaderWidgets(view)).toBe(0)
    const cbPos = findCodeBlockPos(view)
    expect(isCodeBlockAncestorFolded(cbPos)).toBe(true)
    view.destroy()
  })

  it('折叠后在 `...` 前输入内容 → code block header 始终被抑制(下方不孤悬 header)', () => {
    const md = ['# A', '', '```js', 'const x = 1', '```', '', 'p'].join('\n')
    const view = makeView(md, canonicalOrderOf(foldDecoration, codeHighlightPlugin))

    const h = findHeadingContentStart(view, 'A')
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h }))
    // 折叠态初始:header 抑制
    expect(countCodeHeaderWidgets(view)).toBe(0)

    // 在 `...` 前输入一个字符(heading 内,placeholder 之前)
    const phPos = findPlaceholderPos(view)
    expect(phPos).toBeGreaterThanOrEqual(0)
    view.dispatch(view.state.tr.insertText('X', phPos, phPos))

    // 输入后 code block pos 平移,但祖先折叠判定必须仍为真,header 仍被抑制
    const cbPos = findCodeBlockPos(view)
    expect(isCodeBlockAncestorFolded(cbPos)).toBe(true)
    expect(countCodeHeaderWidgets(view)).toBe(0)
    view.destroy()
  })
})
