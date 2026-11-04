// 回归:mark 源码编辑会话与"整表 replaceWith"类命令的冲突。
//
// 症状(修前):在带 mark 的单元格里右键删行/删列,表格下方会多出一份"被修改过的表格";
//   行数一多(DOM 复杂)更容易命中;切源码模式会消失,Ctrl+Z 后反而固化。
//
// 成因:表格命令一律 replaceWith 整张表。若此刻 mark 会话正开着(右键把光标移进
//   带 mark 的单元格 → appendTransaction 把 `**bold**` 换成源码文本),那条 tr 会把会话
//   的 [editFrom, editTo] 整体覆盖;apply 里两端 bias 相反(+1 / -1),map 后区间翻转
//   (editFrom > editTo)→ view.update 触发 commit → tr.delete(from > to)。
//   ProseMirror 的 Fragment.replace 是 cut(0,from) + content + cut(to),不校验先后,
//   于是 [to, from) 整段被复制一遍 —— 模型里真的多出一张表(不是 DOM 孤儿)。
//
// 修法:① apply 里检测到反向区间直接丢弃会话(防线);② 表格命令 dispatch 前
//   flushMarkSourceEdit() 先 commit 会话并返回 mapping,调用方把锚点映射到新文档。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'

import { schema } from '../editor/schema'
import { buildShortcutKeymap } from '../editor/shortcuts'
import { flushMarkSourceEdit, markSourceEditKey, markSourceEditPlugin } from '../plugins/markSourceEdit'

const tick = (ms = 10): Promise<void> => new Promise(r => setTimeout(r, ms))

function bodyCell(children: PMNode[]): PMNode {
  return schema.nodes.table_cell.create(null, schema.nodes.paragraph.create(null, children))
}
function headerCell(text: string): PMNode {
  return schema.nodes.table_header.create(null, schema.nodes.paragraph.create(null, schema.text(text)))
}
function bodyRow(cells: PMNode[]): PMNode {
  return schema.nodes.table_row.create(null, cells)
}

/** doc: 1 张表(header + 2 body 行,首格 strong `bold`) + 尾部段落。 */
function makeTableDoc(): PMNode {
  const header = schema.nodes.table_header_row.create(null, [headerCell('A'), headerCell('B')])
  const r1 = bodyRow([bodyCell([schema.text('bold', [schema.marks.strong.create()])]), bodyCell([schema.text('b')])])
  const r2 = bodyRow([bodyCell([schema.text('c')]), bodyCell([schema.text('d')])])
  const table = schema.nodes.table.create(null, [header, r1, r2])
  return schema.node('doc', null, [table, schema.node('paragraph', null, [schema.text('tail')])])
}

function makeView(doc: PMNode): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({ schema, doc, plugins: [markSourceEditPlugin] })
  return new EditorView(container, { state })
}

function getText(doc: PMNode): string {
  let text = ''
  doc.descendants((n) => {
    if (n.isText) text += n.text ?? ''
    return true
  })
  return text
}

function countTables(doc: PMNode): number {
  let n = 0
  doc.descendants((node) => {
    if (node.type.name === 'table') n++
    return true
  })
  return n
}

function findTextPos(doc: PMNode, needle: string): number {
  let found = -1
  doc.descendants((n, pos) => {
    if (found < 0 && n.isText && (n.text ?? '').includes(needle)) found = pos
    return found < 0
  })
  return found
}

/** 光标移到 strong 文本内部 → appendTransaction 进 session(文档里变 `**bold**`)。 */
async function openSession(view: EditorView): Promise<void> {
  const pos = findTextPos(view.state.doc, 'bold')
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 2)))
  await tick()
}

beforeEach(() => {
  document.querySelectorAll('.ProseMirror').forEach(el => el.parentElement?.remove())
})
afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach(el => el.parentElement?.remove())
})

describe('mark 会话 × 整表 replaceWith', () => {
  it('会话开着时整表替换:不复制表格(反向区间防线)', async () => {
    const view = makeView(makeTableDoc())
    await openSession(view)
    expect(markSourceEditKey.getState(view.state)?.session).toBeTruthy()
    expect(getText(view.state.doc)).toContain('**bold**')

    // 模拟表格命令:整张表 replaceWith(删掉最后一行 body)
    const table = view.state.doc.firstChild!
    const newTable = table.type.create(table.attrs, [table.child(0), table.child(1)])
    view.dispatch(view.state.tr.replaceWith(0, table.nodeSize, newTable))
    await tick()

    // 修前:这里会是 2 张表 / 3 个顶级块(内容被 cut/append/cut 复制了一遍)
    expect(countTables(view.state.doc)).toBe(1)
    expect(view.state.doc.childCount).toBe(2)
    expect(getText(view.state.doc)).not.toContain('**bold**bold')
  })

  it('flushMarkSourceEdit:先 commit 会话并返回 mapping,整表替换后表格内容不丢', async () => {

    const view = makeView(makeTableDoc())
    await openSession(view)

    const anchorBefore = findTextPos(view.state.doc, '**bold**') // 源码文本起点
    const mapping = flushMarkSourceEdit(view)
    expect(mapping).toBeTruthy()
    // 会话已结束,源码文本还原成 strong
    expect(markSourceEditKey.getState(view.state)?.session).toBeNull()
    expect(getText(view.state.doc)).toBe('ABboldbcdtail')
    expect(getText(view.state.doc)).not.toContain('**')
    // 锚点可映射到新文档坐标,且仍落在 strong 文本内
    const anchorAfter = mapping!.map(anchorBefore)
    expect(anchorAfter).toBeGreaterThan(0)
    expect(anchorAfter).toBeLessThanOrEqual(view.state.doc.content.size)

    const table = view.state.doc.firstChild!
    const newTable = table.type.create(table.attrs, [table.child(0), table.child(1)])
    view.dispatch(view.state.tr.replaceWith(0, table.nodeSize, newTable))
    await tick()

    expect(countTables(view.state.doc)).toBe(1)
    expect(view.state.doc.childCount).toBe(2)
    // 首格仍是 strong `bold`(不是字面 `**bold**`)
    let strongText = ''
    view.state.doc.descendants((n) => {
      if (n.isText && n.marks.some(m => m.type.name === 'strong')) strongText += n.text ?? ''
      return true
    })
    expect(strongText).toBe('bold')
  })

  it('键盘路径(Mod-Backspace 删行):快捷键表在整表 replaceWith 前先 flush,不复制表格', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: makeTableDoc(),
      // buildShortcutKeymap 会给带 tableAction 的表格命令包一层 flushMarkSourceEdit
      plugins: [markSourceEditPlugin, buildShortcutKeymap()],
    })
    const view = new EditorView(container, { state })
    await openSession(view)
    expect(markSourceEditKey.getState(view.state)?.session).toBeTruthy()

    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', ctrlKey: true, bubbles: true, cancelable: true }),
    )
    await tick()

    expect(countTables(view.state.doc)).toBe(1)
    expect(view.state.doc.childCount).toBe(2)
    // 确实删掉了光标所在行:header + 1 body 行
    expect(view.state.doc.firstChild!.childCount).toBe(2)
    // 会话已被 flush(而不是靠 apply 的反向区间防线兜底丢弃)
    expect(markSourceEditKey.getState(view.state)?.session).toBeNull()
  })
})
