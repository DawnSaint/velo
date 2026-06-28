// 语法实时转换框架(syntaxAutoFormatPlugin + syntax registry)集成测试
//
// 覆盖:
//  - 块级语法:每条各 1 个 happy path + 段中输入不触发的反例
//  - inline 框架特有:[^xxx] 反向输入(先输 ] 再前面补 [^) 仍能触发
//  - inline 框架特有:粘贴含 [text](url) 的整段 → 自动加 link mark
//  - 黑名单:code_block 内字面量 `### ` 不被转
//  - 死循环防御:转换后再 dispatch 一个 noop tr,doc 不再变化

import { describe, expect, it, beforeAll } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { linkClickPlugin } from '../plugins/linkClick'
import { syntaxAutoFormatPlugin } from '../plugins/syntaxAutoFormat'
import { taskListPlugin } from '../nodes/TaskListNodeView'
import {
  registerBlockSyntax,
  registerInlineSyntax,
  _resetSyntaxRegistry,
} from '../editor/syntaxRegistry'
import { headingSyntax } from '../syntax/block/heading'
import { codeBlockEnterCommand, codeBlockSyntax } from '../syntax/block/codeBlock'
import { blockquoteSyntax } from '../syntax/block/blockquote'
import { bulletListSyntax } from '../syntax/block/bulletList'
import { orderedListSyntax } from '../syntax/block/orderedList'
import { hrEnterCommand, hrSyntax } from '../syntax/block/hr'
import { alertSyntax } from '../syntax/block/alert'
import { footnoteRefSyntax } from '../syntax/inline/footnoteRef'
import { linkSyntax } from '../syntax/inline/link'
import { emphasisUnderscoreSyntax } from '../syntax/inline/emphasis'
import { emphasisStarSyntax } from '../syntax/inline/emphasisStar'
import { strongSyntax } from '../syntax/inline/strong'
import { strikeSyntax } from '../syntax/inline/strike'
import { inlineMathSyntax } from '../syntax/inline/inlineMath'

beforeAll(() => {
  _resetSyntaxRegistry()
  registerBlockSyntax(headingSyntax)
  registerBlockSyntax(codeBlockSyntax)
  registerBlockSyntax(blockquoteSyntax)
  registerBlockSyntax(bulletListSyntax)
  registerBlockSyntax(orderedListSyntax)
  registerBlockSyntax(hrSyntax)
  registerBlockSyntax(alertSyntax)
  registerInlineSyntax(linkSyntax)
  registerInlineSyntax(footnoteRefSyntax)
  registerInlineSyntax(inlineMathSyntax)
  // 与 syntax/index.ts 注册顺序对齐:emphasisStar → strong → strike → emphasisUnderscore
  registerInlineSyntax(emphasisStarSyntax)
  registerInlineSyntax(strongSyntax)
  registerInlineSyntax(strikeSyntax)
  registerInlineSyntax(emphasisUnderscoreSyntax)
})

function mountView(blocks: ReturnType<typeof schema.node>[] = [schema.node('paragraph')]): {
  view: EditorView
  cleanup: () => void
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = schema.node('doc', null, blocks)
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.atEnd(doc),
    plugins: [linkClickPlugin, syntaxAutoFormatPlugin, taskListPlugin],
  })
  const view = new EditorView(host, { state })
  return { view, cleanup: () => { view.destroy(); host.remove() } }
}

// 在 pos 位置插入文本(模拟用户键入)。先把 selection 置到 pos,再 insertText
// —— 这样 ProseMirror / 后续 appendTransaction 修改 doc 时,selection 由
// tr.mapping 自动平移,不需要测试自己算最终位置(算了也不准:框架会在
// 同一笔 appendTransaction 内吃掉前缀,doc 长度比 pos+text.length 短)。
function typeAt(view: EditorView, pos: number, text: string) {
  const tr1 = view.state.tr.setSelection(
    TextSelection.create(view.state.doc, pos),
  )
  view.dispatch(tr1)
  view.dispatch(view.state.tr.insertText(text))
}

describe('syntaxAutoFormat: block syntaxes', () => {
  it('"### " 段首键入 → 转 heading 3', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '### ')
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('heading')
    expect(block.attrs.level).toBe(3)
    cleanup()
  })

  it('"# " ~ "###### " 各级 heading 都能触发', () => {
    for (let i = 1; i <= 6; i++) {
      const { view, cleanup } = mountView()
      typeAt(view, 1, '#'.repeat(i) + ' ')
      const block = view.state.doc.firstChild!
      expect(block.type.name).toBe('heading')
      expect(block.attrs.level).toBe(i)
      cleanup()
    }
  })

  it('段中(非段首)输入 "### " 不触发', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('foo ')]),
    ])
    // 在 "foo " 之后插 "### "
    typeAt(view, 5, '### ')
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('paragraph')
    expect(block.textContent).toBe('foo ### ')
    cleanup()
  })

  it('"> " 段首键入 → 转 blockquote', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '> ')
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('blockquote')
    expect(block.firstChild?.type.name).toBe('paragraph')
    cleanup()
  })

  it('"- " 段首键入 → 转 bullet_list', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '- ')
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('bullet_list')
    const item = block.firstChild!
    expect(item.type.name).toBe('list_item')
    expect(item.attrs.checked).toBeNull()
    cleanup()
  })

  it('"- [x] " 段首键入 → 转 task list_item', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '- [x] ')
    const item = view.state.doc.firstChild!.firstChild!
    expect(item.type.name).toBe('list_item')
    expect(item.attrs.checked).toBe(true)
    cleanup()
  })

  it('"- [ ] " 段首键入 → 转未勾选 task', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '- [ ] ')
    const item = view.state.doc.firstChild!.firstChild!
    expect(item.attrs.checked).toBe(false)
    cleanup()
  })

  it('先输入 "- " 生成列表,再输入 "[ ] " → 升级为未勾选 task item', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '- ')
    typeAt(view, 3, '[ ] ')
    const item = view.state.doc.firstChild!.firstChild!
    expect(item.attrs.checked).toBe(false)
    expect(item.firstChild!.textContent).toBe('')
    const li = view.dom.querySelector('li')!
    expect(li.getAttribute('data-item-type')).toBe('task')
    expect(li.querySelector('.task-checkbox')).not.toBeNull()
    cleanup()
  })

  it('先输入 "- " 生成列表,再输入 "[x] " → 升级为已勾选 task item', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '- ')
    typeAt(view, 3, '[x] ')
    const item = view.state.doc.firstChild!.firstChild!
    expect(item.attrs.checked).toBe(true)
    expect(item.firstChild!.textContent).toBe('')
    const li = view.dom.querySelector('li')!
    expect(li.getAttribute('data-item-type')).toBe('task')
    expect(li.getAttribute('data-checked')).toBe('true')
    expect(li.querySelector('.task-checkbox')).not.toBeNull()
    cleanup()
  })

  it('"1. " 段首键入 → 转 ordered_list,start=1', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '1. ')
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('ordered_list')
    expect(block.attrs.order).toBe(1)
    cleanup()
  })

  it('"42. " 段首键入 → 转 ordered_list,start=42', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '42. ')
    expect(view.state.doc.firstChild!.attrs.order).toBe(42)
    cleanup()
  })

  it('"```js " 段首键入不立即转 code_block,允许继续编辑 language', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '```js ')
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('paragraph')
    expect(block.textContent).toBe('```js ')
    cleanup()
  })

  it('"```js" + Enter → code_block,language=js', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '```js')
    expect(codeBlockEnterCommand(view.state, view.dispatch.bind(view))).toBe(true)
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('code_block')
    expect(block.attrs.language).toBe('js')
    cleanup()
  })

  it('"``` js" + Enter → code_block,language=js', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '``` js')
    expect(codeBlockEnterCommand(view.state, view.dispatch.bind(view))).toBe(true)
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('code_block')
    expect(block.attrs.language).toBe('js')
    cleanup()
  })

  it('"``` " + Enter(无 lang)→ code_block,language 为空', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '``` ')
    expect(codeBlockEnterCommand(view.state, view.dispatch.bind(view))).toBe(true)
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('code_block')
    expect(block.attrs.language).toBe('')
    cleanup()
  })

  it('"--- " 整段单独行 → 转 hr', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '--- ')
    expect(view.state.doc.firstChild!.type.name).toBe('hr')
    cleanup()
  })

  it('CommonMark thematic break 空格触发:*** / ___ / ---- / - - - 均转 hr', () => {
    for (const text of ['*** ', '___ ', '---- ', ' - - - ']) {
      const { view, cleanup } = mountView()
      typeAt(view, 1, text)
      expect(view.state.doc.firstChild!.type.name).toBe('hr')
      cleanup()
    }
  })

  it('"---" 不在第三个连字符处立即转 hr,等待空格或 Enter 触发', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '---')
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('paragraph')
    expect(block.textContent).toBe('---')
    cleanup()
  })

  it('"---" + Enter → 转 hr', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '---')
    expect(hrEnterCommand(view.state, view.dispatch.bind(view))).toBe(true)
    expect(view.state.doc.firstChild!.type.name).toBe('hr')
    cleanup()
  })

  it('非 thematic break 行 Enter 不转 hr', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, 'abc---')
    expect(hrEnterCommand(view.state, view.dispatch.bind(view))).toBe(false)
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
    cleanup()
  })

  it('4 个前导空格的 "---" 按 CommonMark 不作为 hr 自动转换', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '    --- ')
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
    expect(hrEnterCommand(view.state, view.dispatch.bind(view))).toBe(false)
    cleanup()
  })

  it('blockquote 内 "[!NOTE]" + Enter → 转 alert(变体小写)', () => {
    // 起始 doc:blockquote(paragraph("[!NOTE"))  —— 用户敲了一半
    // 模拟用户敲完最后的 ']' 然后按 Enter:这两步等价于在 marker 段尾插入
    // ']' + 调 splitBlock 切第二段。这两笔都让 marker 段 dirty,框架的
    // dirty-range 自然能扫到它(与生产路径一致)。
    const { view, cleanup } = mountView([
      schema.node('blockquote', null, [
        schema.node('paragraph', null, [schema.text('[!NOTE')]),
      ]),
    ])
    // 1. 在 marker 段尾追加 ']'
    const markerEnd = 1 + 1 + 6 // bq.open + p.open + 6 字
    view.dispatch(view.state.tr.insertText(']', markerEnd))
    // 2. 模拟 Enter:在 marker 段尾(']' 之后)splitBlock,分裂出第二段
    view.dispatch(view.state.tr.split(markerEnd + 1))

    const top = view.state.doc.firstChild!
    expect(top.type.name).toBe('alert')
    expect(top.attrs.variant).toBe('note')
    // alert 内剩 1 段(原 marker 段被剥掉,保留 split 出的空段)
    expect(top.childCount).toBe(1)
    expect(top.firstChild!.type.name).toBe('paragraph')
    cleanup()
  })

  it('blockquote 只有 1 段(用户还没按 Enter)→ 不触发', () => {
    const { view, cleanup } = mountView([
      schema.node('blockquote', null, [
        schema.node('paragraph', null, [schema.text('[!NOTE')]),
      ]),
    ])
    // 只补 ']',不 split,模拟用户敲完 marker 但没按 Enter
    const markerEnd = 1 + 1 + 6
    view.dispatch(view.state.tr.insertText(']', markerEnd))
    // 应仍是 blockquote
    expect(view.state.doc.firstChild!.type.name).toBe('blockquote')
    cleanup()
  })

  it('普通段落(不在 blockquote 内)输入 "[!NOTE]" 不触发 alert', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('[!NOTE')]),
    ])
    view.dispatch(view.state.tr.insertText(']', 1 + 6))
    // 顶层段落,不该转 alert
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
    cleanup()
  })

  it('alert 5 种 variant 都能识别', () => {
    for (const v of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
      const text = `[!${v}`
      const { view, cleanup } = mountView([
        schema.node('blockquote', null, [
          schema.node('paragraph', null, [schema.text(text)]),
        ]),
      ])
      const markerEnd = 1 + 1 + text.length
      view.dispatch(view.state.tr.insertText(']', markerEnd))
      view.dispatch(view.state.tr.split(markerEnd + 1))
      const top = view.state.doc.firstChild!
      expect(top.type.name).toBe('alert')
      expect(top.attrs.variant).toBe(v.toLowerCase())
      cleanup()
    }
  })

  it('alert variant 大小写不敏感(与 remarkAlert 对齐)', () => {
    for (const v of ['note', 'Tip', 'Important', 'warning', 'caUTION']) {
      const text = `[!${v}`
      const { view, cleanup } = mountView([
        schema.node('blockquote', null, [
          schema.node('paragraph', null, [schema.text(text)]),
        ]),
      ])
      const markerEnd = 1 + 1 + text.length
      view.dispatch(view.state.tr.insertText(']', markerEnd))
      view.dispatch(view.state.tr.split(markerEnd + 1))
      const top = view.state.doc.firstChild!
      expect(top.type.name).toBe('alert')
      expect(top.attrs.variant).toBe(v.toLowerCase())
      cleanup()
    }
  })

  it('alert 非法 variant "[!FOO]" 不被识别为 alert(防御 i flag 副作用)', () => {
    const text = '[!FOO'
    const { view, cleanup } = mountView([
      schema.node('blockquote', null, [
        schema.node('paragraph', null, [schema.text(text)]),
      ]),
    ])
    const markerEnd = 1 + 1 + text.length
    view.dispatch(view.state.tr.insertText(']', markerEnd))
    view.dispatch(view.state.tr.split(markerEnd + 1))
    // 仍是 blockquote,不是 alert
    expect(view.state.doc.firstChild!.type.name).toBe('blockquote')
    cleanup()
  })
})

describe('syntaxAutoFormat: inline syntaxes', () => {
  it('"[^xxx]" 紧贴光标(顺序输入)→ 转 footnote_reference', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '[^a]')
    const para = view.state.doc.firstChild!
    let foundRef = false
    para.forEach((child) => {
      if (child.type.name === 'footnote_reference' && child.textContent === 'a') foundRef = true
    })
    expect(foundRef).toBe(true)
    cleanup()
  })

  it('反向输入 "[^xxx]"(先 ] 后 [^xxx)→ 仍能触发(框架的关键改进)', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    // 先输 "]" 在末尾
    typeAt(view, 5, ']')
    expect(view.state.doc.textContent).toBe('See ]')
    // 再在 "]" 之前补 "[^a"(原 InputRule 在这里完全不会触发,因末尾不是 ])
    typeAt(view, 5, '[^a')
    // 现在框架应该把 "[^a]" 整体识别并转换
    const para = view.state.doc.firstChild!
    let foundRef = false
    para.forEach((child) => {
      if (child.type.name === 'footnote_reference' && child.textContent === 'a') foundRef = true
    })
    expect(foundRef).toBe(true)
    cleanup()
  })

  it('粘贴含 [text](url) → 自动加 link mark', () => {
    const { view, cleanup } = mountView()
    view.dispatch(view.state.tr.insertText('[Velo](https://github.com/velo)', 1))
    const para = view.state.doc.firstChild!
    const link = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find(c => c.text === 'Velo')
    expect(link?.marks.find(m => m.type.name === 'link')?.attrs.href).toBe('https://github.com/velo')
    cleanup()
  })

  it('已有 footnote_reference 的段落里再输入 [^c] → 位置不偏(回归 textBetween 位置错位)', () => {
    // footnote_reference 是 content:'text*' 的非 atom 节点,textBetween 会递进
    // 取 text content('xy',2 字符),但节点占 nodeSize=4(open+content+close)。
    // blockText 字符数 < doc 位置数,match.index 映射回 doc 偏前 2 → 删错位置。
    const fnRef = schema.nodes.footnote_reference.create(null, schema.text('xy'))
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [
        schema.text('ab'),
        fnRef,
        schema.text(' '),
      ]),
    ])
    // 光标放到空格后(pos = 1 + 2 + 4 + 1 = 8),输入 [^c]
    typeAt(view, 8, '[^c]')
    const para = view.state.doc.firstChild!
    // 期望:ab + footnote_reference('xy') + ' ' + footnote_reference('c')
    const children = Array.from({ length: para.childCount }, (_, i) => para.child(i))
    const refs = children.filter(c => c.type.name === 'footnote_reference')
    expect(refs.length).toBe(2)
    expect(refs[0].textContent).toBe('xy')
    expect(refs[1].textContent).toBe('c')
    // 'ab' 和 ' ' 不能被删
    expect(para.textContent).toBe('abxy c')
    cleanup()
  })

  it('"$x$" 段中键入 → 转 math_inline', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '$E=mc^2$')
    const para = view.state.doc.firstChild!
    let foundMath = false
    para.forEach((child) => {
      if (child.type.name === 'math_inline' && child.textContent === 'E=mc^2') foundMath = true
    })
    expect(foundMath).toBe(true)
    cleanup()
  })

  it('"_italic_" 段中键入 → 加 emphasis mark', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '_italic_')
    const para = view.state.doc.firstChild!
    const italic = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find(c => c.text === 'italic')
    expect(italic?.marks.find(m => m.type.name === 'emphasis')).toBeDefined()
    cleanup()
  })

  it('"~~strike~~" 段中键入 → 加 strike mark', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '~~bad~~')
    const para = view.state.doc.firstChild!
    const struck = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find(c => c.text === 'bad')
    expect(struck?.marks.find(m => m.type.name === 'strike_through')).toBeDefined()
    cleanup()
  })
})

// =====================================================================
//  v0.4.4 — strong / emphasisStar / strike 互锁矩阵
// =====================================================================

describe('syntaxAutoFormat: v0.4.4 强-弱 mark 互锁', () => {
  // 查 strong mark 的辅助函数
  function findMark(para: any, markName: string, text: string): { text: string, mark: any } | null {
    let found: { text: string, mark: any } | null = null
    para.forEach((child: any) => {
      if (found) return
      const m = child.marks.find((mk: any) => mk.type.name === markName)
      if (m && child.text === text) found = { text: child.text, mark: m }
    })
    return found
  }

  it('"**bold**" 段中键入 → 加 strong mark', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '**bold**')
    const para = view.state.doc.firstChild!
    const r = findMark(para, 'strong', 'bold')
    expect(r).not.toBeNull()
    expect(r!.mark.attrs.marker).toBe('*')
    cleanup()
  })

  it('"__bold__" 段中键入 → 加 strong mark(marker=`_`)', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '__bold__')
    const para = view.state.doc.firstChild!
    const r = findMark(para, 'strong', 'bold')
    expect(r).not.toBeNull()
    expect(r!.mark.attrs.marker).toBe('_')
    cleanup()
  })

  it('"*italic*" 段中键入 → 加 emphasis mark(marker=`*`)', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '*italic*')
    const para = view.state.doc.firstChild!
    const r = findMark(para, 'emphasis', 'italic')
    expect(r).not.toBeNull()
    expect(r!.mark.attrs.marker).toBe('*')
    cleanup()
  })

  it('"**33**" → strong(emphasisStar 不抢,** 前缀被 `(?<!\\*)` 拒)', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '**33**')
    const para = view.state.doc.firstChild!
    const r = findMark(para, 'strong', '33')
    expect(r).not.toBeNull()
    // 不应该残留裸 `*`
    const paraText = view.state.doc.textBetween(0, view.state.doc.content.size, ' ', ' ')
    expect(paraText).not.toMatch(/\*/)
    cleanup()
  })

  it('"**bold** and *italic*" → 两种 mark 各自正确转', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '**bold** and *italic*')
    const para = view.state.doc.firstChild!
    expect(findMark(para, 'strong', 'bold')).not.toBeNull()
    expect(findMark(para, 'emphasis', 'italic')).not.toBeNull()
    cleanup()
  })

  it('"*not*italic*" → 只 `*italic*` 命中(首 `*not*` 因尾后是 word 字符被拒)', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '*not*italic*')
    const para = view.state.doc.firstChild!
    expect(findMark(para, 'emphasis', 'italic')).not.toBeNull()
    // "not" 不应有 emphasis mark
    const notSpan = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find((c: any) => c.text === 'not')
    expect(notSpan?.marks.some((m: any) => m.type.name === 'emphasis') ?? false).toBe(false)
    cleanup()
  })

  it('"** not bold **"(内含前后空格)→ 不转(开头 `**` 后是空格被 `(?\\s)` 拒)', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '** not bold **')
    const para = view.state.doc.firstChild!
    expect(findMark(para, 'strong', 'not bold')).toBeNull()
    cleanup()
  })

  it('"a**b**c" → strong 仍命中(无 word 边界限制,跨段也行)', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, 'a**b**c')
    const para = view.state.doc.firstChild!
    expect(findMark(para, 'strong', 'b')).not.toBeNull()
    cleanup()
  })

  it('"**33** ~~sfd~~" 混合段 → strong + strike 各自命中(用户报的 `~~sfd~~` bug 验证)', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '**33** ~~sfd~~')
    const para = view.state.doc.firstChild!
    expect(findMark(para, 'strong', '33')).not.toBeNull()
    expect(findMark(para, 'strike_through', 'sfd')).not.toBeNull()
    cleanup()
  })
})

describe('syntaxAutoFormat: 黑名单 / 防死循环', () => {
  it('code_block 内字面量 "### " 不被转 heading', () => {
    const { view, cleanup } = mountView([
      schema.node('code_block', { language: '' }, [schema.text('### foo\nbar')]),
    ])
    // doc 起点是 code_block,无 paragraph 在前;触发一个 noop transaction
    view.dispatch(view.state.tr.insertText(' ', view.state.doc.content.size))
    expect(view.state.doc.firstChild!.type.name).toBe('code_block')
    expect(view.state.doc.firstChild!.textContent.startsWith('### foo')).toBe(true)
    cleanup()
  })

  it('已转 heading 后再 dispatch noop selection → doc 不再变化', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '## ')
    expect(view.state.doc.firstChild!.type.name).toBe('heading')
    const docBefore = view.state.doc.toString()

    // noop selection 变更:不应再次触发任何转换
    view.dispatch(view.state.tr.setSelection(TextSelection.atStart(view.state.doc)))
    expect(view.state.doc.toString()).toBe(docBefore)
    cleanup()
  })

  it('转换后产生的 footnote_reference 不会被自身正则再次抓回', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '[^a]')
    // 触发额外 transaction:再补一个无关字符,应该正常插入,不应让现有 footnote_ref 被再处理
    typeAt(view, view.state.doc.content.size - 1, 'x')
    let refCount = 0
    view.state.doc.descendants((n) => {
      if (n.type.name === 'footnote_reference') refCount++
    })
    expect(refCount).toBe(1)
    cleanup()
  })
})
