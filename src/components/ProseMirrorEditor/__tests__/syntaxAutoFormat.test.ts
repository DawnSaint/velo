// 语法实时转换框架(syntaxAutoFormatPlugin + syntax registry)集成测试
//
// 覆盖:
//  - 块级语法:每条各 1 个 happy path + 段中输入不触发的反例
//  - inline 框架特有:[^xxx] 反向输入(先输 ] 再前面补 [^) 仍能触发
//  - inline 框架特有:粘贴含 [text](url) 的整段 → 自动加 link mark
//  - 黑名单:code_block 内字面量 `### ` 不被转
//  - 死循环防御:转换后再 dispatch 一个 noop tr,doc 不再变化

import { describe, expect, it, beforeAll } from 'vitest'
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { baseKeymap } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { schema } from '../editor/schema'
import { linkClickPlugin } from '../plugins/linkClick'
import { createImageEditPlugin, triggerImageEdit } from '../image/imageEditPlugin'
import { imageKeymapPlugin } from '../image/imageKeymap'
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
import { frontmatterSyntax } from '../syntax/block/frontmatter'
import { alertSyntax } from '../syntax/block/alert'
import { footnoteRefSyntax } from '../syntax/inline/footnoteRef'
import { linkSyntax } from '../syntax/inline/link'
import { emphasisUnderscoreSyntax } from '../syntax/inline/emphasis'
import { emphasisStarSyntax } from '../syntax/inline/emphasisStar'
import { strongSyntax } from '../syntax/inline/strong'
import { strikeSyntax } from '../syntax/inline/strike'
import { highlightSyntax } from '../syntax/inline/highlight'
import { inlineCodeSyntax } from '../syntax/inline/code'
import { inlineMathSyntax } from '../syntax/inline/inlineMath'
import { htmlTagSyntax } from '../syntax/inline/htmlTag'

beforeAll(() => {
  _resetSyntaxRegistry()
  registerBlockSyntax(headingSyntax)
  registerBlockSyntax(codeBlockSyntax)
  registerBlockSyntax(blockquoteSyntax)
  registerBlockSyntax(bulletListSyntax)
  registerBlockSyntax(orderedListSyntax)
  // frontmatter 必须在 hr 之前:两者 pattern 重叠(---),frontmatter 仅在文档首段
  // 触发,hr 在任意位置触发;注册顺序决定优先级(与 syntax/index.ts 对齐)。
  registerBlockSyntax(frontmatterSyntax)
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
  registerInlineSyntax(highlightSyntax)
  registerInlineSyntax(inlineCodeSyntax)
  registerInlineSyntax(htmlTagSyntax)
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

  // hr 在 frontmatter 之后匹配:首段 `--- ` 已被 frontmatter 抢占,故 hr 测试
  // 必须在非首段触发(第二段才是 hr 的管辖域)。
  it('"--- " 整段单独行 → 转 hr', () => {
    const { view, cleanup } = mountView([schema.node('paragraph'), schema.node('paragraph')])
    // 第二段起点:doc open(1) + 首段空 paragraph(nodeSize 2) = 3
    typeAt(view, 3, '--- ')
    expect(view.state.doc.child(1)!.type.name).toBe('hr')
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

  // frontmatterSyntax 是空格触发(同 hr 范式):裸 `---` 不触发,留给
  // frontmatterEnterCommand 的 Enter 通道接管;否则第三根 `-` 落下的瞬间
  // 就被立刻解析成 frontmatter,与"--- + Enter 才解析"的需求不符。
  it('"---" 不在第三个连字符处立即转 frontmatter,等待空格或 Enter 触发', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '---')
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('paragraph')
    expect(block.textContent).toBe('---')
    cleanup()
  })

  it('"--- " 空格触发 → 转 frontmatter(yaml)', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '--- ')
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('frontmatter')
    expect(block.attrs.lang).toBe('yaml')
    cleanup()
  })

  it('"+++ " 空格触发 → 转 frontmatter(toml)', () => {
    const { view, cleanup } = mountView()
    typeAt(view, 1, '+++ ')
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('frontmatter')
    expect(block.attrs.lang).toBe('toml')
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
      if (child.type.name === 'math_inline' && child.textContent === '$E=mc^2$') foundMath = true
    })
    expect(foundMath).toBe(true)
    cleanup()
  })

  it('"$x$" 键入完成后光标停在节点内末尾(不立即隐藏 $x$)', () => {
    // 用户主诉:打完最后一个 $ 立即变 Katex 形态隐藏了 $x$,希望光标还停在
    // 末尾 $ 之后,同时显示 $x$ + 渲染层;继续输入别的字符(光标移出)才隐藏。
    // 这里只断言 selection 位置(inlineMath.ts 改动核心);data-mode 的 edit 态
    // 保持由 isCursorInNode 保证(光标在节点内 → edit),mathInlineDualMode.test.ts
    // 已覆盖。
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '$x$')

    // 找到 math_inline 节点位置
    let nodePos = -1
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'math_inline') { nodePos = pos; return false }
      return true
    })
    expect(nodePos).toBeGreaterThanOrEqual(0)

    // content = `$x$`(3 字符),nodeSize = 5;节点内末尾(close tag 之前)= nodePos + 4
    // 光标在此位置 → isCursorInNode true → edit 态保持
    expect(view.state.selection.head).toBe(nodePos + 4)

    cleanup()
  })

  it('"$$x$$" 段中键入 → 转 math_inline,前后不留多余 $', () => {
    // 用户主诉:输入 $$x$$ 移开光标后,看到「$ 跟 katex 渲染的 x」——
    // 根因:旧正则 /\$([^$\n]+)\$/g 在 $$x$$ 上只匹配中间 3 字符 $x$,
    // 首尾两个 $ 留在段落里成普通文本 → 视觉上 "$ + math + $"。
    // 新正则 /(\$\$?)([^$\n]+)\1/g 用反向引用配对首尾 $ 数量,完整吞下 $$x$$。
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '$$x$$')

    const para = view.state.doc.firstChild!
    let mathText: string | null = null
    let mathCount = 0
    para.forEach((child) => {
      if (child.type.name === 'math_inline') {
        mathCount++
        mathText = child.textContent
      }
    })
    // 唯一 1 个 math 节点,content 含完整 $$x$$
    expect(mathCount).toBe(1)
    expect(mathText).toBe('$$x$$')

    // 段落中除 math 节点外不应残留任何 $ 字符(text 含 math content)
    // 实际就是 math 节点本身,外层 text "See " 不应被切碎
    const allText = para.textContent
    expect(allText).toBe('See $$x$$')
    cleanup()
  })

  it('"$$x$$" 逐字符键入(模拟真实输入)→ 不在 $$x$ 中间态误匹配', () => {
    // 用户主诉:逐字符输入 $$x$$ 时,打完 $$x$ 的瞬间 regex 从 index 1 匹配 $x$,
    // 把 $x$ 转成 math_inline 留下前导 $ → 用户看到 "$ + katex",序列化后变 \$$x$。
    // 修复:正则加 (?<!\$) 负向后行断言,$$x$ 中间态不匹配,等输完 $$x$$ 才完整转换。
    // typeAt 一次性插入掩盖了此问题,这里逐字符 dispatch 验证。
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    // 逐字符输入 $ $ x $ $
    for (const ch of ['$', '$', 'x', '$', '$']) {
      const pos = view.state.selection.head
      view.dispatch(view.state.tr.insertText(ch, pos))
    }

    const para = view.state.doc.firstChild!
    let mathText: string | null = null
    let mathCount = 0
    para.forEach((child) => {
      if (child.type.name === 'math_inline') {
        mathCount++
        mathText = child.textContent
      }
    })
    expect(mathCount).toBe(1)
    expect(mathText).toBe('$$x$$')
    expect(para.textContent).toBe('See $$x$$')
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

  it('"`code`" 段中键入 → 加 code mark(行内代码实时转换)', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '`fn`')
    const para = view.state.doc.firstChild!
    const code = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find(c => c.text === 'fn')
    expect(code?.marks.find(m => m.type.name === 'code')).toBeDefined()
    // 回写 round-trip:`fn` 仍可序列化为 `fn`
    expect(para.textContent).toBe('See fn')
    cleanup()
  })

  it('"``code``" 双 backtick 段中键入 → 加 code mark(backref 对称)', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, '``fn``')
    const para = view.state.doc.firstChild!
    const code = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find(c => c.text === 'fn')
    expect(code?.marks.find(m => m.type.name === 'code')).toBeDefined()
    cleanup()
  })

  it('code_block 内键入 `fn` 不转行内 code(黑名单容器)', () => {
    const { view, cleanup } = mountView([
      schema.node('code_block', null, [schema.text('see ')]),
    ])
    typeAt(view, 1 + 'see '.length, '`fn`')
    // 仍是 code_block,内部为字面量 `fn`(无 code mark)
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('code_block')
    expect(block.textContent).toBe('see `fn`')
    cleanup()
  })

  it('"<kbd>Mod</kbd>" 段中键入 → 转 html_inline', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('Press ')]),
    ])
    typeAt(view, 7, '<kbd>Mod</kbd>')
    const para = view.state.doc.firstChild!
    let found = false
    para.forEach((child) => {
      if (child.type.name === 'html_inline' && child.attrs.value === '<kbd>Mod</kbd>') found = true
    })
    expect(found).toBe(true)
    cleanup()
  })

  it('"<br/>" 自闭合标签 → 转 html_inline', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('Line 1')]),
    ])
    typeAt(view, 7, '<br/>')
    const para = view.state.doc.firstChild!
    let found = false
    para.forEach((child) => {
      if (child.type.name === 'html_inline' && child.attrs.value === '<br/>') found = true
    })
    expect(found).toBe(true)
    cleanup()
  })

  it('"<kbd class="key">Mod</kbd>" 带属性 → 转 html_inline', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('Press ')]),
    ])
    typeAt(view, 7, '<kbd class="key">Mod</kbd>')
    const para = view.state.doc.firstChild!
    let found = false
    para.forEach((child) => {
      if (child.type.name === 'html_inline' && child.attrs.value === '<kbd class="key">Mod</kbd>') found = true
    })
    expect(found).toBe(true)
    cleanup()
  })

  it('开/闭标签名不一致("<div>a</span>")→ 不触发', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, []),
    ])
    typeAt(view, 1, '<div>a</span>')
    const para = view.state.doc.firstChild!
    // 应该仍是 text,不是 html_inline
    let hasHtmlInline = false
    para.forEach((child) => {
      if (child.type.name === 'html_inline') hasHtmlInline = true
    })
    expect(hasHtmlInline).toBe(false)
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

describe('syntaxAutoFormat: image edit session 退避', () => {
  it('图片源码 ![alt](src) 不被 inline link 正则吃成 link mark', () => {
    // 回归:无 title 源码 `![alt](src)` 内层 `[alt](src)` 正好命中 link inline
    // 正则;imageEdit session 必须让 syntaxAutoFormat 退避,否则 `!` 成孤儿、
    // alt 被包成 link mark,用户看到的源码被即时转成渲染态 link。
    const imageNode = schema.nodes.image.create({ src: 'a.png', alt: 'alt', title: '' })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [imageNode])])
    const state = EditorState.create({
      schema,
      doc,
      plugins: [linkClickPlugin, createImageEditPlugin({ proxyDomURL: (u) => u }), syntaxAutoFormatPlugin],
    })
    const view = new EditorView(host, { state })

    let pos = -1
    view.state.doc.descendants((n, p) => {
      if (n.type.name === 'image') { pos = p; return false }
      return true
    })
    triggerImageEdit(view, pos)

    // 源码保留为纯文本,未被转成 link mark
    expect(view.state.doc.textContent).toBe('![alt](a.png)')
    let hasLink = false
    view.state.doc.descendants((n) => {
      if (n.isText && n.marks.some(m => m.type.name === 'link')) hasLink = true
    })
    expect(hasLink).toBe(false)

    view.destroy()
    host.remove()
  })
})

// =====================================================================
//  语法闭合后继续输入不继承 mark
// =====================================================================

describe('syntaxAutoFormat: 闭合后继续输入不继承 mark', () => {
  // 用户主诉:`**bold**` / `==hl==` / `*it*` 等闭合后继续输入仍是粗体/高亮/斜体。
  // 根因:apply 后光标停在 inner 末尾 = inclusive mark 右边界,storedMarks=null 时
  // ProseMirror 回退到 $from.marks()(含该 mark)→ 继续继承。
  // 修复:apply 末尾 removeStoredMark(markType) → storedMarks=[] 覆盖继承。
  // 不用 inclusive:false —— 会破坏 Ctrl+B 连续输入(storedMark 首字符消耗后靠
  // inclusive 边界继承);link 能用 inclusive:false 因它不靠 Ctrl+B 连续输入。

  /** 输入完整语法后继续输入 X,返回 X 是否带 markName(bug=true / 修复=false) */
  function continueTypingHasMark(input: string, markName: string): boolean {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('See ')]),
    ])
    typeAt(view, 5, input)
    // 闭合后继续输入 X(inner 不含 X,故 includes('X') 只命中继续输入的节点)
    view.dispatch(view.state.tr.insertText('X', view.state.selection.head))
    const para = view.state.doc.firstChild!
    const x = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find(c => (c.text || '').includes('X'))
    const has = x?.marks.some(m => m.type.name === markName) ?? false
    cleanup()
    return has
  }

  it('"**bold**" 闭合后继续输入不继承 strong', () => {
    expect(continueTypingHasMark('**bold**', 'strong')).toBe(false)
  })

  it('"__bold__" 闭合后继续输入不继承 strong', () => {
    expect(continueTypingHasMark('__bold__', 'strong')).toBe(false)
  })

  it('"*italic*" 闭合后继续输入不继承 emphasis', () => {
    expect(continueTypingHasMark('*italic*', 'emphasis')).toBe(false)
  })

  it('"_italic_" 闭合后继续输入不继承 emphasis', () => {
    expect(continueTypingHasMark('_italic_', 'emphasis')).toBe(false)
  })

  it('"~~strike~~" 闭合后继续输入不继承 strike_through', () => {
    expect(continueTypingHasMark('~~strike~~', 'strike_through')).toBe(false)
  })

  it('"==hl==" 闭合后继续输入不继承 highlight', () => {
    expect(continueTypingHasMark('==hl==', 'highlight')).toBe(false)
  })

  it('"`code`" 闭合后继续输入不继承 code', () => {
    expect(continueTypingHasMark('`code`', 'code')).toBe(false)
  })

  // hr 可选中 + select-then-delete 路径测试。
  // hr 是 block+atom 节点,点击后走 NodeSelection 选中(同 math_block 范式),
  // 再按 Backspace 由 baseKeymap 整块删除。
  // 需要 syntaxAutoFormatPlugin(--- 转 hr)+ imageKeymapPlugin(hr 在 ATOM_TYPES)
  // + baseKeymap(删 NodeSelection),单独建一个带 keymap 的 mount。
  describe('hr 可选中 + select-then-delete', () => {
    function mountViewWithKeymap(blocks: ReturnType<typeof schema.node>[] = [schema.node('paragraph')]) {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const doc = schema.node('doc', null, blocks)
      const state = EditorState.create({
        schema,
        doc,
        selection: TextSelection.atEnd(doc),
        plugins: [
          linkClickPlugin,
          syntaxAutoFormatPlugin,
          imageKeymapPlugin,
          keymap({ Backspace: baseKeymap['Backspace'] }),
          keymap({ Delete: baseKeymap['Delete'] }),
        ],
      })
      const view = new EditorView(host, { state })
      return { view, cleanup: () => { view.destroy(); host.remove() } }
    }

    // 模拟一次 Backspace 按键:调 imageKeymap 的 handleKeyDown handler。
    // prosemirror-keymap 1.2.x 不把命令暴露在 spec 上,需走 handleKeyDown prop。
    function pressBackspace(view: EditorView): boolean {
      const handler = (imageKeymapPlugin.spec as any).props
        ?.handleKeyDown
      if (!handler) throw new Error('imageKeymap.handleKeyDown not found')
      const event = {
        key: 'Backspace',
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        preventDefault() {},
      } as unknown as KeyboardEvent
      return handler(view, event)
    }

    it('"--- " 转 hr,点击选中 hr 后再按 Backspace → 删除 hr', () => {
      // 两段:首段空 paragraph 占位,第二段 `--- ` 转 hr(首段已被 frontmatter 抢占)。
      const { view, cleanup } = mountViewWithKeymap([schema.node('paragraph'), schema.node('paragraph')])
      // 第二段内容起点 = doc open(1) + 首段 nodeSize(2) = 3
      typeAt(view, 3, '--- ')
      expect(view.state.doc.child(1)!.type.name).toBe('hr')
      expect(view.state.doc.childCount).toBe(3) // 首段 + hr + 尾部段落

      // 模拟点击 hr → NodeSelection 选中 hr 块。
      // hr 是 block atom(nodeSize 1)。两段场景下 doc 结构为
      //   paragraph[0,2) | hr[2,3) | paragraph[3,6),
      // 故 hr 的 $before = 2(实测 NodeSelection 锚点落在 2 而非 3)。
      const hrBlockPos = 2
      view.dispatch(view.state.tr.setSelection(
        NodeSelection.create(view.state.doc, hrBlockPos),
      ))
      expect(view.state.selection instanceof NodeSelection).toBe(true)
      expect((view.state.selection as NodeSelection).node.type.name).toBe('hr')

      // imageKeymap 对已选中的 atom 返回 false,让 baseKeymap 删。
      const handled = pressBackspace(view)
      expect(handled).toBe(false)

      // 走 baseKeymap 删除:block NodeSelection 整块删掉(等价于用户按 Backspace)。
      baseKeymap['Backspace'](view.state, (t: any) => view.dispatch(t))
      // hr 应被删,doc 剩首段 + 尾部段落。
      expect(view.state.doc.childCount).toBe(2)
      expect(view.state.doc.child(1)!.type.name).toBe('paragraph')
      cleanup()
    })

    it('imageKeymap 把 hr 纳入 atom 保护( Delete 键从 hr 前删→先选中 )', () => {
      const { view, cleanup } = mountViewWithKeymap()
      // 构造 [paragraph("above"), hr],光标在 paragraph 末尾(紧贴 hr 前)。
      // paragraph nodeSize = 7(开+5text+闭),其 depth-0 结束位置 = 7(此时 na=hr)。
      const para = schema.node('paragraph', null, [schema.text('above')])
      const hr = schema.node('hr')
      const doc = schema.node('doc', null, [para, hr])
      const paraEnd = para.nodeSize // depth-0 上 paragraph 结束位置(na=hr)
      const state = EditorState.create({
        schema,
        doc,
        selection: TextSelection.create(doc, paraEnd),
        plugins: [imageKeymapPlugin],
      })
      view.updateState(state)
      expect(view.state.selection.empty).toBe(true)

      // Delete 键:imageKeymap 应消费并把选区设成 NodeSelection 指向 hr。
      const handler = (imageKeymapPlugin.spec as any).props?.handleKeyDown
      const ev = {
        key: 'Delete', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {},
      } as unknown as KeyboardEvent
      const handled = handler(view, ev)
      expect(handled).toBe(true)
      expect(view.state.selection instanceof NodeSelection).toBe(true)
      expect((view.state.selection as NodeSelection).node.type.name).toBe('hr')
      cleanup()
    })
  })

  it('回归:手动 addStoredMark 后连续输入仍继承 strong(确认 inclusive 未被破坏)', () => {
    // removeStoredMark 只影响语法 apply 那一笔的 storedMarks,不改 schema 的
    // inclusive(默认 true)。Ctrl+B 路径(addStoredMark 后连续输入)依赖 inclusive:
    // 首字符消耗 storedMark 后,后续字符靠 inclusive 边界继承。此用例锁定该约束,
    // 防止未来误把 strong 改成 inclusive:false 回退性地"解决"本 bug。
    const { view, cleanup } = mountView()
    const strongType = schema.marks.strong
    view.dispatch(view.state.tr.addStoredMark(strongType.create()))
    view.dispatch(view.state.tr.insertText('b'))
    view.dispatch(view.state.tr.insertText('o'))
    view.dispatch(view.state.tr.insertText('x'))
    const para = view.state.doc.firstChild!
    const box = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find(c => c.text === 'box')
    expect(box?.marks.some(m => m.type.name === 'strong')).toBe(true)
    cleanup()
  })
})
