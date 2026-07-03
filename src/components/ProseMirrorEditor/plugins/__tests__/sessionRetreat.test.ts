// link / image / markSourceEdit session 并存时,syntaxAutoFormat 必须对**全部**活跃
// session 退避(getActiveEditRanges 返回数组,任一相交即跳过)。否则 link session 活跃
// 期间 markSourceEdit enter strong 产生的 `**bold**` 源码会被 strongSyntax 立即转回
// mark,markSourceEdit session 经 mapping 倒置 → commit 范围错乱 → strong 文本翻倍
// (每次操作 ×2)。
//
// jsdom 无法用 posAtCoords 真实 click link(link mark inclusive:false,text node 起点
// resolve 不含 mark,fallback 判定失败),故手动模拟 startLinkEdit 的 tr。

import { describe, it, expect, beforeAll } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../../editor/schema'
import { fromMarkdown } from '../../editor/markdownIO'
import { linkClickPlugin, linkClickPluginKey } from '../linkClick'
import { markSourceEditPlugin } from '../markSourceEdit'
import { syntaxAutoFormatPlugin } from '../syntaxAutoFormat'
import { registerBlockSyntax, registerInlineSyntax, _resetSyntaxRegistry } from '../../editor/syntaxRegistry'
import { headingSyntax } from '../../syntax/block/heading'
import { codeBlockSyntax } from '../../syntax/block/codeBlock'
import { blockquoteSyntax } from '../../syntax/block/blockquote'
import { bulletListSyntax } from '../../syntax/block/bulletList'
import { orderedListSyntax } from '../../syntax/block/orderedList'
import { hrSyntax } from '../../syntax/block/hr'
import { alertSyntax } from '../../syntax/block/alert'
import { footnoteRefSyntax } from '../../syntax/inline/footnoteRef'
import { linkSyntax } from '../../syntax/inline/link'
import { emphasisUnderscoreSyntax } from '../../syntax/inline/emphasis'
import { emphasisStarSyntax } from '../../syntax/inline/emphasisStar'
import { strongSyntax } from '../../syntax/inline/strong'
import { strikeSyntax } from '../../syntax/inline/strike'
import { highlightSyntax } from '../../syntax/inline/highlight'
import { inlineMathSyntax } from '../../syntax/inline/inlineMath'
import { htmlTagSyntax } from '../../syntax/inline/htmlTag'

beforeAll(() => {
  _resetSyntaxRegistry()
  registerBlockSyntax(headingSyntax); registerBlockSyntax(codeBlockSyntax); registerBlockSyntax(blockquoteSyntax)
  registerBlockSyntax(bulletListSyntax); registerBlockSyntax(orderedListSyntax); registerBlockSyntax(hrSyntax); registerBlockSyntax(alertSyntax)
  registerInlineSyntax(linkSyntax); registerInlineSyntax(footnoteRefSyntax); registerInlineSyntax(inlineMathSyntax)
  registerInlineSyntax(emphasisStarSyntax); registerInlineSyntax(strongSyntax); registerInlineSyntax(strikeSyntax)
  registerInlineSyntax(emphasisUnderscoreSyntax); registerInlineSyntax(highlightSyntax); registerInlineSyntax(htmlTagSyntax)
})

describe('session 退避:link + markSourceEdit 并存', () => {
  it('link 编辑态期间 enter strong,strongSyntax 不转回 mark,strong 不翻倍', () => {
    const md = `- **链接**：用方括号和圆括号创建链接 \`[显示文本](链接地址)\`。链接跳转（**Ctrl/Cmd + 单击**）：外部 [CommonMark 规范](https://commonmark.org)、[GFM 文档](https://github.github.com/gfm/)， [回到开头](<# Markdown 语法>)。`
    const doc = fromMarkdown(md, schema)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const state = EditorState.create({ doc, schema, plugins: [linkClickPlugin, markSourceEditPlugin, syntaxAutoFormatPlugin] })
    const view = new EditorView(host, { state })

    let strongPos = -1
    doc.descendants((n: any, p: number) => { if (strongPos === -1 && n.isText && n.marks.some((m: any) => m.type.name === 'strong')) strongPos = p + 1; return true })

    // 模拟:click "回到开头" 展开 link 源码 → click strong "链接" 触发 markSourceEdit enter。
    // 重复 3 轮,旧 bug 会 2→4→8 翻倍。
    for (let i = 0; i < 3; i++) {
      let lf = -1, lt = -1, lh = ''
      view.state.doc.descendants((n: any, p: number) => { if (n.isText && n.marks.some((m: any) => m.type.name === 'link')) { lf = p; lt = p + n.nodeSize; lh = n.marks.find((m: any) => m.type.name === 'link')!.attrs.href } return true })
      if (lf === -1) break
      const source = `[回到开头](${lh})`
      let tr = view.state.tr.delete(lf, lt).insertText(source, lf)
      tr = tr.setSelection(TextSelection.create(tr.doc, lf + 1))
      tr = tr.setMeta(linkClickPluginKey, { type: 'start', session: { editFrom: lf, editTo: lf + source.length, href: lh, originalSource: source } })
      view.dispatch(tr)
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, strongPos)))
    }

    // strong "链接" 不应翻倍成 "链接链接..."
    expect(view.state.doc.textContent).not.toContain('链接链接')
    // 仍是一个 strong text node "链接"
    let strongText: string | null = null
    view.state.doc.descendants(n => { if (n.isText && n.marks.some(m => m.type.name === 'strong') && n.text === '链接') strongText = n.text ?? null; return true })
    expect(strongText).toBe('链接')

    view.destroy(); host.remove()
  })
})
