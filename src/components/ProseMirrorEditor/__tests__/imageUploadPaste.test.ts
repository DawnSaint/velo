// imageUploadPlugin.handlePaste 行为测试。
//
// 覆盖:
//   - Excel / Sheets / 浏览器复制表格:剪贴板同时有 text/html(<table>) + 图片文件
//     → handlePaste 检测到 HTML 含表格,手动解析成规整的 table 节点插入
//     (而非插图)。外部 HTML 表格结构不可控,统一按 textContent 重建。
//   - Velo 内部复制 / 剪切的多块内容(含表格,HTML 带 data-pm-slice)→ 放行给
//     ProseMirror 原生 HTML round-trip,段落 + 表格 + 段落都要完整还原。
//   - 纯图片粘贴(截图 / 浏览器复制图):无 text/html → handlePaste 拦截,return true。
//
// 通过 view.someProp('handlePaste', ...) 调用,与 ProseMirror doPaste 的调用方式
// 一致,避免手动 bind this。

import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { DOMParser as PMDOMParser, DOMSerializer, Slice } from 'prosemirror-model'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { fromMarkdown, toMarkdown } from '../editor/markdownIO'
import { imageUploadPlugin } from '../image/imageUploadPlugin'

// 构造一个模拟的 ClipboardEvent,注入 clipboardData 的 types / getData / files。
function makeClipEvent(opts: {
  html?: string
  plain?: string
  files?: File[]
}): ClipboardEvent {
  const types: string[] = []
  const dataMap: Record<string, string> = {}
  if (opts.html !== undefined) { types.push('text/html'); dataMap['text/html'] = opts.html }
  if (opts.plain !== undefined) { types.push('text/plain'); dataMap['text/plain'] = opts.plain }

  const dt = {
    types,
    getData: (mime: string) => dataMap[mime] ?? '',
    files: opts.files ?? [],
  } as unknown as DataTransfer

  return {
    clipboardData: dt,
    preventDefault: () => {},
  } as unknown as ClipboardEvent
}

// 构造一个最小 image/* File(MIME 以 image/ 开头,pickImageFile 只认 MIME)。
function makeImageFile(name = 'table.png'): File {
  return new File(['x'], name, { type: 'image/png' })
}

function mountView(): { view: EditorView; cleanup: () => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = schema.node('doc', null, [schema.node('paragraph')])
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.atEnd(doc),
    plugins: [imageUploadPlugin],
  })
  const view = new EditorView(host, { state })
  return { view, cleanup: () => { view.destroy(); host.remove() } }
}

// 调 imageUploadPlugin 的 handlePaste(经 someProp,与 doPaste 同路径)。
// 只判定"是否接管",不验证落盘副作用(slice 未用到,传空 slice)。
function handlePaste(view: EditorView, event: ClipboardEvent): boolean {
  let handled = false
  view.someProp('handlePaste', (f) => {
    handled = !!f(view, event, null as unknown as Slice)
    return handled
  })
  return handled
}

describe('imageUploadPlugin.handlePaste:Excel 表格粘贴不拦截', () => {
  it('HTML 含 <table> + 图片文件 → 接管,插入规整 table 节点(而非插图)', () => {
    const { view, cleanup } = mountView()
    const event = makeClipEvent({
      html: '<table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>',
      plain: 'Name\tValue\nA\t1',
      files: [makeImageFile()],
    })
    expect(handlePaste(view, event)).toBe(true)
    const doc = view.state.doc
    // doc 顶层:原 paragraph(被 split) + table。table 是规整的单节点。
    let foundTable: any = null
    doc.descendants((n) => { if (n.type.name === 'table') { foundTable = n; return false } return !foundTable })
    expect(foundTable).not.toBeNull()
    expect(foundTable.childCount).toBe(2) // header_row + body row
    expect(foundTable.child(0).type.name).toBe('table_header_row')
    expect(foundTable.child(0).child(0).type.name).toBe('table_header')
    expect(foundTable.child(0).child(0).textContent).toBe('Name')
    expect(foundTable.child(1).type.name).toBe('table_row')
    expect(foundTable.child(1).child(0).type.name).toBe('table_cell')
    expect(foundTable.child(1).child(0).textContent).toBe('A')
    cleanup()
  })

  it('HTML 含 <table 空格属性 + 图片文件 → 接管,插入 table', () => {
    const { view, cleanup } = mountView()
    const event = makeClipEvent({
      html: '<table border="1"><tr><td>X</td></tr></table>',
      files: [makeImageFile()],
    })
    expect(handlePaste(view, event)).toBe(true)
    let foundTable: any = null
    view.state.doc.descendants((n) => { if (n.type.name === 'table') { foundTable = n; return false } return !foundTable })
    expect(foundTable).not.toBeNull()
    expect(foundTable.childCount).toBe(1)
    expect(foundTable.child(0).child(0).textContent).toBe('X')
    cleanup()
  })

  it('HTML 含表格但无图片文件 → 接管,插入 table(无图可插)', () => {
    const { view, cleanup } = mountView()
    const event = makeClipEvent({
      html: '<table><tr><td>A</td></tr></table>',
      plain: 'A',
    })
    expect(handlePaste(view, event)).toBe(true)
    let foundTable: any = null
    view.state.doc.descendants((n) => { if (n.type.name === 'table') { foundTable = n; return false } return !foundTable })
    expect(foundTable).not.toBeNull()
    expect(foundTable.child(0).child(0).textContent).toBe('A')
    cleanup()
  })
})

describe('imageUploadPlugin.handlePaste:纯图片粘贴仍拦截', () => {
  it('无 text/html,只有图片文件 → return true(拦截,落盘插图)', () => {
    const { view, cleanup } = mountView()
    const event = makeClipEvent({
      files: [makeImageFile('screenshot.png')],
    })
    expect(handlePaste(view, event)).toBe(true)
    cleanup()
  })

  it('text/html 无表格 + 图片文件 → return true(拦截,插图)', () => {
    const { view, cleanup } = mountView()
    const event = makeClipEvent({
      html: '<p>some text</p>',
      files: [makeImageFile()],
    })
    expect(handlePaste(view, event)).toBe(true)
    cleanup()
  })

  it('空剪贴板(无 HTML 无图) → return false(不接管)', () => {
    const { view, cleanup } = mountView()
    const event = makeClipEvent({})
    expect(handlePaste(view, event)).toBe(false)
    cleanup()
  })
})

// ── Velo 内部复制 / 剪切:多块内容含表格 ────────────────────────────────
//
// 复现:拖拽选中「段落 + 表格 + 段落」→ Ctrl+C/X → Ctrl+V 只剩表格。
// PM 的 serializeForClipboard 写 text/html(含 <table>)并给首个元素加
// data-pm-slice;imageUploadPlugin 曾把这类 HTML 当成 Excel 表格,只提取
// 第一个 <table> 插入,表格外的段落全丢。

const MULTI_BLOCK_MD = `开头第一段文字

| 列1 | 列2 |
| --- | --- |
| A | B |

结尾最后一段文字
`

/** 模拟 PM serializeForClipboard 的产物(copy 与 cut 共用此路径)。 */
function serializeAsProseMirror(slice: Slice): { html: string; plain: string } {
  const detached = document.implementation.createHTMLDocument('title')
  const wrap = detached.createElement('div')
  wrap.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(slice.content, { document: detached }))
  const first = wrap.firstChild
  if (first && first.nodeType === 1) {
    (first as HTMLElement).setAttribute('data-pm-slice', `${slice.openStart} ${slice.openEnd} []`)
  }
  return {
    html: wrap.innerHTML,
    plain: slice.content.textBetween(0, slice.content.size, '\n\n'),
  }
}

describe('imageUploadPlugin.handlePaste:Velo 内部复制含表格的多块内容', () => {
  it('HTML 带 data-pm-slice → 放行,PM 默认 HTML 路径完整还原段落 + 表格 + 段落', () => {
    const srcDoc = fromMarkdown(MULTI_BLOCK_MD, schema)
    // 从首段文字中间拖到末段文字中间(openStart/openEnd = 1),贴近真实拖拽选区。
    const slice = TextSelection.create(srcDoc, 1, srcDoc.content.size - 1).content()
    const { html, plain } = serializeAsProseMirror(slice)
    expect(html).toContain('data-pm-slice')
    expect(html).toContain('<table')

    const { view, cleanup } = mountView()
    expect(handlePaste(view, makeClipEvent({ html, plain }))).toBe(false)

    // 模拟 doPaste 的 text/html 路径:readHTML → parseSlice → replaceSelection。
    const dom = document.createElement('div')
    dom.innerHTML = html
    const parsed = PMDOMParser.fromSchema(schema).parseSlice(dom, {
      preserveWhitespace: true,
      context: view.state.selection.$from,
    })
    view.dispatch(view.state.tr.replaceSelection(new Slice(parsed.content, 1, 1)))

    const doc = view.state.doc
    expect(doc.childCount).toBe(3)
    expect(doc.child(0).textContent).toBe('开头第一段文字')
    expect(doc.child(1).type.name).toBe('table')
    expect(doc.child(1).textContent).toBe('列1列2AB')
    expect(doc.child(2).textContent).toBe('结尾最后一段文字')
    const md = toMarkdown(doc)
    expect(md).toContain('开头第一段文字')
    expect(md).toContain('| 列1 | 列2 |')
    expect(md).toContain('| A')
    expect(md).toContain('结尾最后一段文字')
    cleanup()
  })

  it('schema HTML round-trip:header 行不被 table_row 的 tr 规则抢走', () => {
    const dom = document.createElement('div')
    dom.innerHTML = '<table><tbody><tr data-is-header="true"><th><p>H</p></th></tr><tr><td><p>D</p></td></tr></tbody></table>'
    const slice = PMDOMParser.fromSchema(schema).parseSlice(dom)
    expect(slice.content.childCount).toBe(1)
    const table = slice.content.child(0)
    expect(table.type.name).toBe('table')
    expect(table.childCount).toBe(2)
    expect(table.child(0).type.name).toBe('table_header_row')
    expect(table.child(0).textContent).toBe('H')
    expect(table.child(1).type.name).toBe('table_row')
    expect(table.child(1).textContent).toBe('D')
  })

  it('外部 markdown 文档(无 data-pm-slice)仍走 fromMarkdown', () => {
    const { view, cleanup } = mountView()
    const event = makeClipEvent({
      html: '<table><tr><td>A</td></tr></table>',
      plain: '# 标题\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n',
    })
    expect(handlePaste(view, event)).toBe(true)
    let hasHeading = false
    view.state.doc.descendants((n) => {
      if (n.type.name === 'heading') { hasHeading = true; return false }
      return true
    })
    expect(hasHeading).toBe(true)
    cleanup()
  })
})

