// imageUploadPlugin.handlePaste 行为测试。
//
// 覆盖:
//   - Excel / Sheets / 浏览器复制表格:剪贴板同时有 text/html(<table>) + 图片文件
//     → handlePaste 检测到 HTML 含表格,手动解析成规整的 table 节点插入
//     (而非插图)。不能走 ProseMirror 默认 HTML 路径:浏览器解析 <table> 时自动
//     插入 <tbody>,而 prosemirror-tables 的 table parseDOM 期望 <tr> 是
//     <table> 的直接子节点,导致 parseSlice 断裂成两个 table 节点(第一个空)。
//   - 纯图片粘贴(截图 / 浏览器复制图):无 text/html → handlePaste 拦截,return true。
//
// 通过 view.someProp('handlePaste', ...) 调用,与 ProseMirror doPaste 的调用方式
// 一致,避免手动 bind this。

import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import type { Slice } from 'prosemirror-model'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
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

