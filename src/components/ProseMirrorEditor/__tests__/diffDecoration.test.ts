import { describe, it, expect } from 'vitest'
import { EditorState, Plugin } from 'prosemirror-state'
import { DecorationSet, EditorView } from 'prosemirror-view'
import { schema as veloSchema, type VeloSchema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import { buildDecorations, buildDiffPlan, diffDecorationKey, diffDecorationPlugin, getDiffGroups } from '../plugins/diffDecoration'
import { viewportPlugin, setInitialViewportHint, viewportKey } from '../nodes/viewportPlugin'

function makeDoc(md: string) {
  return fromMarkdown(md, veloSchema as VeloSchema)
}

function getDecoSet(oldMd: string, newMd: string): DecorationSet {
  const oldDoc = makeDoc(oldMd)
  const newDoc = makeDoc(newMd)
  const state = EditorState.create({ schema: veloSchema, doc: newDoc })
  const decos = buildDecorations(newDoc, oldDoc)
  return DecorationSet.create(state.doc, decos)
}

/** 检查是否有带 velo-diff-added class 的 node decoration */
function hasAddedDeco(decoSet: DecorationSet): boolean {
  const decos = decoSet.find()
  return decos.some(d => {
    const type = (d as any).type
    return type && type.attrs && type.attrs.class === 'velo-diff-added'
  })
}

/** 检查是否有带 velo-diff-added-inline class 的 inline decoration */
function hasAddedInlineDeco(decoSet: DecorationSet): boolean {
  const decos = decoSet.find()
  return decos.some(d => {
    const type = (d as any).type
    return type && type.attrs && type.attrs.class === 'velo-diff-added-inline'
  })
}

describe('buildDecorations', () => {
  it('完全相同 → 无装饰', () => {
    const md = '# Title\n\nHello world.'
    const decoSet = getDecoSet(md, md)
    expect(decoSet.find().length).toBe(0)
  })

  it('纯新增文本 → 绿色背景装饰', () => {
    const decoSet = getDecoSet('Hello.', 'Hello world.')
    expect(hasAddedInlineDeco(decoSet)).toBe(true)
  })

  it('纯删除文本 → 红色背景 widget', () => {
    const decoSet = getDecoSet('Hello world.', 'Hello.')
    const decos = decoSet.find()
    expect(decos.length).toBeGreaterThan(0)
  })

  it('修改一行 → 既有 added inline 又有 removed widget', () => {
    const decoSet = getDecoSet('Hello old world.', 'Hello new world.')
    expect(hasAddedInlineDeco(decoSet)).toBe(true)
  })

  it('修改一行 → 只标记变化的字符,不标记整行', () => {
    const decoSet = getDecoSet('Hello old world.', 'Hello new world.')
    // 应该有 inline decoration(字符级),而不是 node decoration(整行)
    expect(hasAddedInlineDeco(decoSet)).toBe(true)
    expect(hasAddedDeco(decoSet)).toBe(false)
  })

  it('标题变更 → 装饰正确', () => {
    const decoSet = getDecoSet('# Old Title\n\nSome content.', '# New Title\n\nSome content.')
    const decos = decoSet.find()
    expect(decos.length).toBeGreaterThan(0)
    expect(hasAddedInlineDeco(decoSet)).toBe(true)
  })

  it('多段落新增 → 多段都有装饰', () => {
    const decoSet = getDecoSet('First paragraph.', 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.')
    expect(hasAddedDeco(decoSet)).toBe(true)
  })

  it('代码块内容变更 → 装饰正确', () => {
    const decoSet = getDecoSet('```js\nconst x = 1\n```', '```js\nconst x = 2\n```')
    const decos = decoSet.find()
    expect(decos.length).toBeGreaterThan(0)
    expect(hasAddedInlineDeco(decoSet)).toBe(true)
  })

  it('空旧版本 → 全文 added', () => {
    const decoSet = getDecoSet('', 'Hello world.')
    expect(hasAddedDeco(decoSet)).toBe(true)
  })

  it('空新版本 → 全文 removed widget', () => {
    const decoSet = getDecoSet('Hello world.', '')
    const decos = decoSet.find()
    expect(decos.length).toBeGreaterThan(0)
  })

  it('两版本都为空 → 无装饰', () => {
    const decoSet = getDecoSet('', '')
    expect(decoSet.find().length).toBe(0)
  })

  it('配对修改 → 删除字符的 widget 位于被删位置(原地),而非行首', () => {
    const decoSet = getDecoSet('Hello old world.', 'Hello new world.')
    const decos = decoSet.find()
    // widget decoration 的 from === to
    const widgets = decos.filter(d => d.from === d.to)
    expect(widgets.length).toBeGreaterThan(0)
    // 新文档 "Hello new world." 中 'new' 起始于 doc pos 7
    // (段落 text 从 pos 1 开始,偏移 6),被删的 'old' 应原位显示在这里
    expect(widgets.some(d => d.from === 7)).toBe(true)
    // 不应出现在行首(pos 1)
    expect(widgets.every(d => d.from !== 1)).toBe(true)
  })

  it('行尾追加字符 → 无删除 widget,只有新增字符高亮', () => {
    const decoSet = getDecoSet('Hello.', 'Hello world.')
    const decos = decoSet.find()
    expect(decos.every(d => d.from !== d.to)).toBe(true)
    expect(hasAddedInlineDeco(decoSet)).toBe(true)
  })

  it('仅格式变更(加粗)→ 变化区间 inline 标记(旧实现完全不可见)', () => {
    const oldDoc = makeDoc('Hello world.')
    const newDoc = makeDoc('Hello **world**.')
    const decos = buildDecorations(newDoc, oldDoc)
    const fmt = decos.filter(d => (d as any).type?.attrs?.class === 'velo-diff-format-changed')
    expect(fmt.length).toBe(1)
    // 'world' 在新文档中的范围:段落 text 从 pos 1 开始,offset 6..11 → pos 7..12
    expect(fmt[0].from).toBe(7)
    expect(fmt[0].to).toBe(12)
    expect((fmt[0] as any).type.attrs.title).toBe('格式变更')
    // 不再用整块 changed 兜底
    expect(decos.some(d => (d as any).type?.attrs?.class === 'velo-diff-changed')).toBe(false)
  })

  it('节点类型变更(段落 → 标题,文本不变)→ 左侧条 + tooltip', () => {
    const oldDoc = makeDoc('Hello')
    const newDoc = makeDoc('# Hello')
    const decos = buildDecorations(newDoc, oldDoc)
    const typeChanged = decos.filter(d =>
      ((d as any).type?.attrs?.class ?? '').includes('velo-diff-type-changed'))
    expect(typeChanged.length).toBe(1)
    expect((typeChanged[0] as any).type.attrs.title).toBe('段落 → 标题 1')
  })

  it('标题级别变更(标题 1 → 标题 2,文本不变)→ tooltip 区分级别', () => {
    const oldDoc = makeDoc('# Hello')
    const newDoc = makeDoc('## Hello')
    const decos = buildDecorations(newDoc, oldDoc)
    const typeChanged = decos.filter(d =>
      ((d as any).type?.attrs?.class ?? '').includes('velo-diff-type-changed'))
    expect(typeChanged.length).toBe(1)
    expect((typeChanged[0] as any).type.attrs.title).toBe('标题 1 → 标题 2')
  })

  it('图片删除 → 带样式只读片段 widget(保留 <img> 结构)', () => {
    const oldDoc = makeDoc('![截图](a.png)')
    const newDoc = makeDoc('')
    const decos = buildDecorations(newDoc, oldDoc)
    const widgets = decos.filter(d => d.from === d.to)
    expect(widgets.length).toBeGreaterThan(0)
    // widget 的 toDOM 即构造时传入的函数,可直接调用取 DOM
    const dom = (widgets[0] as any).type.toDOM() as HTMLElement
    expect(dom.className).toBe('velo-diff-deleted-block')
    const img = dom.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('alt')).toBe('截图')
  })

  it('整 block 删除(标题)→ 片段保留标题标签与字号结构', () => {
    const oldDoc = makeDoc('# 标题\n\nbody')
    const newDoc = makeDoc('body')
    const decos = buildDecorations(newDoc, oldDoc)
    const widgets = decos.filter(d => d.from === d.to)
    expect(widgets.length).toBe(1)
    const dom = (widgets[0] as any).type.toDOM() as HTMLElement
    expect(dom.className).toBe('velo-diff-deleted-block')
    const h1 = dom.querySelector('h1')
    expect(h1).not.toBeNull()
    expect(h1!.textContent).toBe('标题')
  })

  it('段落拆分 → 边界提示 widget,不标增删', () => {
    const oldDoc = makeDoc('hello world')
    const newDoc = makeDoc('hello\n\nworld')
    const decos = buildDecorations(newDoc, oldDoc)
    // 只有 1 个边界提示 widget(第 2 段前),无绿色新增 / 红色删除
    expect(decos.length).toBe(1)
    const dom = (decos[0] as any).type.toDOM() as HTMLElement
    expect(dom.className).toBe('velo-diff-boundary-hint')
    expect(dom.textContent).toBe('段落在此拆分')
    // 提示插在第 2 个 block 前(= 第 1 个 block 的末尾 pos)
    expect(decos[0].from).toBe(newDoc.child(0).nodeSize)
  })

  it('段落合并 → 边界提示 widget(带合并数量)', () => {
    const oldDoc = makeDoc('hello\n\nworld')
    const newDoc = makeDoc('hello world')
    const decos = buildDecorations(newDoc, oldDoc)
    expect(decos.length).toBe(1)
    const dom = (decos[0] as any).type.toDOM() as HTMLElement
    expect(dom.className).toBe('velo-diff-boundary-hint')
    expect(dom.textContent).toBe('2 个段落已合并')
  })
})

// ========== 表格结构化 diff ==========
// 回归:旧实现把整张表拍平成一个字符串做字符级 diff,删除整列时红色删除
// widget 会落进留存单元格,呈现「一格内前半红、后半正常」。现在按二维网格
// 比对,被删列渲染成独立的幽灵 <td>/<th>。

const TABLE_3COL = '| A | B | C |\n| --- | --- | --- |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |'
const TABLE_DEL_MID = '| A | C |\n| --- | --- |\n| a1 | c1 |\n| a2 | c2 |'

/** 取出所有 widget 装饰构造出的 DOM */
function widgetDoms(decos: ReturnType<typeof buildDecorations>): HTMLElement[] {
  return decos
    .filter(d => d.from === d.to)
    .map(d => (d as any).type.toDOM?.() as HTMLElement | undefined)
    .filter((d): d is HTMLElement => !!d)
}

/** 用真实 EditorView 渲染装饰,拿到可断言的 DOM 结构 */
function renderDiff(oldMd: string, newMd: string): HTMLElement {
  const oldDoc = makeDoc(oldMd)
  const newDoc = makeDoc(newMd)
  const decos = buildDecorations(newDoc, oldDoc)
  const plugin = new Plugin({
    props: { decorations: (state: EditorState) => DecorationSet.create(state.doc, decos) },
  })
  const view = new EditorView(document.createElement('div'), {
    state: EditorState.create({ schema: veloSchema, doc: newDoc, plugins: [plugin] }),
  })
  const dom = view.dom.cloneNode(true) as HTMLElement
  view.destroy()
  return dom
}

describe('表格结构化 diff(整列 / 整行删除)', () => {
  it('删除中间列 → 每行一个独立幽灵单元格,内容与旧列一致', () => {
    const decos = buildDecorations(makeDoc(TABLE_DEL_MID), makeDoc(TABLE_3COL))
    const ghosts = widgetDoms(decos).filter(d =>
      d.classList.contains('velo-diff-removed-cell'))
    expect(ghosts.length).toBe(3) // 表头行 + 2 个 body 行
    expect(ghosts.map(d => d.tagName)).toEqual(['TH', 'TD', 'TD'])
    expect(ghosts.map(d => d.textContent)).toEqual(['B', 'b1', 'b2'])
    // 关键:不再有 inline 删除 widget(旧实现正是它把 B/b1/b2 塞进留存格)
    expect(widgetDoms(decos).some(d => d.classList.contains('velo-diff-removed'))).toBe(false)
  })

  it('删除中间列 → 真实 DOM 里是单独一列标红,不与留存单元格混排', () => {
    const dom = renderDiff(TABLE_3COL, TABLE_DEL_MID)
    const rows = Array.from(dom.querySelectorAll('tr'))
    expect(rows.length).toBe(3)
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td, th'))
      expect(cells.length).toBe(3) // 2 个留存列 + 1 个幽灵列
      expect(cells[1].classList.contains('velo-diff-removed-cell')).toBe(true)
      expect(cells[1].textContent).not.toMatch(/[ACac]\d?/)
    }
    expect(dom.querySelectorAll('.velo-diff-removed').length).toBe(0)
  })

  it('删除首列 / 末列 → 幽灵列分别落在行首 / 行尾', () => {
    const delFirst = '| B | C |\n| --- | --- |\n| b1 | c1 |\n| b2 | c2 |'
    const delLast = '| A | B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |'
    const first = renderDiff(TABLE_3COL, delFirst)
    const last = renderDiff(TABLE_3COL, delLast)
    for (const dom of [first, last]) {
      expect(dom.querySelectorAll('.velo-diff-removed-cell').length).toBe(3)
    }
    const firstCells = Array.from(first.querySelectorAll('tr')[1].querySelectorAll('td, th'))
    const lastCells = Array.from(last.querySelectorAll('tr')[1].querySelectorAll('td, th'))
    // 删首列 → 幽灵列是被删的 A 列,落在行首;删末列 → 幽灵列是 C 列,落在行尾
    expect(firstCells[0].textContent).toBe('a1')
    expect(firstCells[0].classList.contains('velo-diff-removed-cell')).toBe(true)
    expect(lastCells[2].textContent).toBe('c1')
    expect(lastCells[2].classList.contains('velo-diff-removed-cell')).toBe(true)
  })

  it('删除整行 → 独立幽灵 <tr>,列数与新表对齐', () => {
    const oldMd = '| A | B | C |\n| --- | --- | --- |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n| a3 | b3 | c3 |'
    const newMd = '| A | B | C |\n| --- | --- | --- |\n| a1 | b1 | c1 |\n| a3 | b3 | c3 |'
    const dom = renderDiff(oldMd, newMd)
    const ghostRows = Array.from(dom.querySelectorAll('tr.velo-diff-removed-row'))
    expect(ghostRows.length).toBe(1)
    expect(Array.from(ghostRows[0].querySelectorAll('td, th')).map(c => c.textContent))
      .toEqual(['a2', 'b2', 'c2'])
    expect(dom.querySelectorAll('tr').length).toBe(4)
  })

  it('单元格内文本修改 → 字符级高亮限定在该单元格内', () => {
    const oldMd = '| A | B |\n| --- | --- |\n| a1 | b1 |'
    const newMd = '| A | B |\n| --- | --- |\n| a1 | b1! |'
    const decos = buildDecorations(makeDoc(newMd), makeDoc(oldMd))
    const added = decos.filter(d =>
      (d as any).type?.attrs?.class === 'velo-diff-added-inline')
    expect(added.length).toBe(1)
    // '!' 落在 b1 单元格的段落内,而不是跨单元格的整表区间
    expect(added[0].to - added[0].from).toBe(1)
    expect(widgetDoms(decos).length).toBe(0)
  })

  it('新增整列 → 每行该列绿底,无删除标记', () => {
    const oldMd = '| A |\n| --- |\n| a1 |'
    const newMd = '| A | B |\n| --- | --- |\n| a1 | b1 |'
    const decos = buildDecorations(makeDoc(newMd), makeDoc(oldMd))
    const addedCells = decos.filter(d =>
      (d as any).type?.attrs?.class === 'velo-diff-added-cell')
    expect(addedCells.length).toBe(2)
    expect(widgetDoms(decos).length).toBe(0)
  })

  it('删除空列(整表文本不变)→ 仍渲染幽灵列,不退化成「格式变更」', () => {
    const oldMd = '| A |  | C |\n| --- | --- | --- |\n| a1 |  | c1 |'
    const newMd = '| A | C |\n| --- | --- |\n| a1 | c1 |'
    const decos = buildDecorations(makeDoc(newMd), makeDoc(oldMd))
    const ghosts = widgetDoms(decos).filter(d =>
      d.classList.contains('velo-diff-removed-cell'))
    expect(ghosts.length).toBe(2)
    expect(decos.some(d => (d as any).type?.attrs?.class === 'velo-diff-changed')).toBe(false)
  })

  it('表格内仅格式变更 → 仍走同文异 key 逻辑,格式标记不丢失', () => {
    const oldMd = '| A | B |\n| --- | --- |\n| a1 | b1 |'
    const newMd = '| A | **B** |\n| --- | --- |\n| a1 | b1 |'
    const decos = buildDecorations(makeDoc(newMd), makeDoc(oldMd))
    const fmt = decos.filter(d =>
      (d as any).type?.attrs?.class === 'velo-diff-format-changed')
    expect(fmt.length).toBe(1)
  })

  it('同页多张表格同时删列 → 各表幽灵列内容正确(widget key 不冲突)', () => {
    const oldMd = `${TABLE_3COL}\n\n| X | Y | Z |\n| --- | --- | --- |\n| x1 | y1 | z1 |`
    const newMd = `${TABLE_DEL_MID}\n\n| X | Z |\n| --- | --- |\n| x1 | z1 |`
    const decos = buildDecorations(makeDoc(newMd), makeDoc(oldMd))
    const keys = decos.filter(d => d.from === d.to)
      .map(d => (d as any).type?.key as string | undefined)
      .filter((k): k is string => !!k)
    expect(new Set(keys).size).toBe(keys.length) // 全局唯一,PM 不会复用错 DOM

    const dom = renderDiff(oldMd, newMd)
    const tables = Array.from(dom.querySelectorAll('table'))
    expect(tables.length).toBe(2)
    const ghostsOf = (t: Element) => Array.from(t.querySelectorAll('.velo-diff-removed-cell'))
      .map(c => c.textContent)
    expect(ghostsOf(tables[0])).toEqual(['B', 'b1', 'b2'])
    expect(ghostsOf(tables[1])).toEqual(['Y', 'y1'])
  })

  it('同时删列 + 删行 → 幽灵列与幽灵行共存,列数对齐', () => {
    const oldMd = '| A | B | C |\n| --- | --- | --- |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |'
    const newMd = '| A | C |\n| --- | --- |\n| a1 | c1 |'
    const dom = renderDiff(oldMd, newMd)
    const rows = Array.from(dom.querySelectorAll('tr'))
    expect(rows.length).toBe(3)
    // 删的是尾行 → 幽灵行必须在表尾,不能跑到表头前面
    expect(rows[rows.length - 1].classList.contains('velo-diff-removed-row')).toBe(true)
    expect(Array.from(rows[rows.length - 1].querySelectorAll('td, th'))
      .map(c => c.textContent)).toEqual(['a2', 'b2', 'c2'])
    for (const row of rows) {
      expect(row.querySelectorAll('td, th').length).toBe(3)
    }
    // 列对齐不能错配成「把旧列文本塞进留存单元格」
    expect(dom.querySelectorAll('.velo-diff-removed').length).toBe(0)
  })
})

describe('其他自定义节点:多文本容器不混排', () => {
  it('列表删中间项 → 独立红色 <li>,删除文本不落进留存项', () => {
    const decos = buildDecorations(makeDoc('- one\n- three'), makeDoc('- one\n- two\n- three'))
    const widgets = widgetDoms(decos)
    expect(widgets.length).toBe(1)
    expect(widgets[0].tagName).toBe('LI')
    expect(widgets[0].classList.contains('velo-diff-deleted-group')).toBe(true)
    expect(widgets[0].textContent).toBe('two')
    // 旧实现会把 'two' 作为 inline 红色片段插进 'three' 的段落
    expect(widgets.some(d => d.classList.contains('velo-diff-removed'))).toBe(false)
  })

  it('引用内删一段 → 独立红色 <p>,不混进留存段落', () => {
    const oldMd = '> first\n>\n> second\n>\n> third'
    const newMd = '> first\n>\n> third'
    const decos = buildDecorations(makeDoc(newMd), makeDoc(oldMd))
    const widgets = widgetDoms(decos)
    expect(widgets.length).toBe(1)
    expect(widgets[0].tagName).toBe('P')
    expect(widgets[0].textContent).toBe('second')
    expect(widgets[0].classList.contains('velo-diff-deleted-group')).toBe(true)
  })

  it('列表项内文本修改 → 只在被改的项内做字符级 diff', () => {
    const decos = buildDecorations(makeDoc('- one\n- two!'), makeDoc('- one\n- two'))
    const added = decos.filter(d =>
      (d as any).type?.attrs?.class === 'velo-diff-added-inline')
    expect(added.length).toBe(1)
    expect(added[0].to - added[0].from).toBe(1)
  })
})

// ========== 增量渲染(#diff-incremental)==========
// 未变更区折叠 + hunk 导航(#diff-autoscroll)已回退,相关用例一并移除。

/** 带 diff 装饰插件的 state(不需要 EditorView) */
function makeDiffState(oldMd: string, newMd: string, viewportHint: { from: number; to: number } | null) {
  const oldDoc = makeDoc(oldMd)
  const newDoc = makeDoc(newMd)
  if (viewportHint) setInitialViewportHint(viewportHint)
  else setInitialViewportHint(null)
  let state = EditorState.create({
    schema: veloSchema,
    doc: newDoc,
    plugins: [viewportPlugin, diffDecorationPlugin],
  })
  state = state.apply(state.tr.setMeta(diffDecorationKey, { oldDoc }))
  return state
}

describe('buildDiffPlan', () => {
  it('一段修改 → 1 个 changed entry', () => {
    const plan = buildDiffPlan(makeDoc('hello'), makeDoc('hello!'))
    expect(plan.entries.length).toBe(1)
    expect(plan.entries[0].changed).toBe(true)
  })

  it('相邻多段修改 → 各自成为独立 changed entry', () => {
    const plan = buildDiffPlan(makeDoc('a\n\nb\n\nc'), makeDoc('A\n\nB\n\nc'))
    expect(plan.entries.filter(e => e.changed).length).toBe(2)
  })

  it('内容完全一致 → 全部是未变更 entry', () => {
    const plan = buildDiffPlan(makeDoc('a\n\nb\n\nc'), makeDoc('a\n\nb\n\nc'))
    expect(plan.entries.every(e => !e.changed)).toBe(true)
  })
})

describe('diffDecorationPlugin 增量构建', () => {
  it('窄 viewport → 只为可见 block 建装饰', () => {
    const narrow = makeDiffState('a\n\nb\n\nc', 'A\n\nB\n\nc', { from: 0, to: 1 })
    const full = makeDiffState('a\n\nb\n\nc', 'A\n\nB\n\nc', null)
    expect(narrow && diffDecorationKey.getState(narrow)!.decoSet!.find().length)
      .toBeLessThan(diffDecorationKey.getState(full)!.decoSet!.find().length)
  })

  it('删除文档首块:零长 widget entry 在视口 from=0 时仍构建(回归)', () => {
    // 旧判定 pos + nodeSize > viewport.from 对 nodeSize=0 且 pos=0 恒为 false,
    // 导致删除首段的红色片段永远不渲染(滚动也救不回来)。
    const state = makeDiffState('第一段\n\n第二段', '第二段', { from: 0, to: 5000 })
    const s = diffDecorationKey.getState(state)!
    // plan 里有一个 delete entry(零长)
    expect(s.plan!.entries.some(e => e.from === e.to)).toBe(true)
    const decos = s.decoSet!.find()
    expect(decos.length).toBeGreaterThan(0)
    // 确实建出了删除片段 widget(widget 的 toDOM 返回 .velo-diff-deleted-block)
    const classes = decos.map(d => ((d as any).type.toDOM?.() as HTMLElement | undefined)?.className)
    expect(classes).toContain('velo-diff-deleted-block')
  })

  it('零长 entry 在视口外时仍跳过(不退化回全量)', () => {
    // 删除首段 + 文档很长,视口落在尾部 → 首块的 delete widget 不应建
    const longTail = Array.from({ length: 40 }, (_, i) => `段落 ${i}`).join('\n\n')
    const state = makeDiffState(`第一段\n\n${longTail}`, longTail, { from: 500, to: 900 })
    const s = diffDecorationKey.getState(state)!
    const zeroLen = s.plan!.entries.filter(e => e.from === e.to)
    expect(zeroLen.length).toBeGreaterThan(0)
    expect(zeroLen.every(e => e.from < 500)).toBe(true)
    expect(s.decoSet!.find().length).toBe(0)
  })

  it('滚动后粘性追加:新进视口的 block 补建,已建的保留', () => {
    let state = makeDiffState('a\n\nb\n\nc', 'A\n\nB\n\nc', { from: 0, to: 1 })
    const before = diffDecorationKey.getState(state)!.decoSet!.find().length

    // viewport 扩到全文 → 追加剩下两个修改段的装饰
    state = state.apply(state.tr.setMeta(viewportKey, { from: 0, to: state.doc.content.size }))
    const after = diffDecorationKey.getState(state)!.decoSet!.find().length
    expect(after).toBeGreaterThan(before)
  })

  it('滚动扩展视口后,已建 entry 的装饰不会重复添加', () => {
    // 3 段修改,窄视口只覆盖第 1 段;扩到全文后应恰好等于全量构建数量
    let state = makeDiffState('a\n\nb\n\nc', 'A\n\nB\n\nc', { from: 0, to: 1 })
    const before = diffDecorationKey.getState(state)!.decoSet!.find().length

    state = state.apply(state.tr.setMeta(viewportKey, { from: 0, to: state.doc.content.size }))
    const after = diffDecorationKey.getState(state)!.decoSet!.find().length

    const full = makeDiffState('a\n\nb\n\nc', 'A\n\nB\n\nc', null)
    const fullCount = diffDecorationKey.getState(full)!.decoSet!.find().length
    // 不重复:增量最终数量 = 全量数量
    expect(after).toBe(fullCount)
    // 且大于初始(确实追加了新的)
    expect(after).toBeGreaterThan(before)
  })
})

// ========== 整框分组(DiffGroup)==========
// 组边界来自 diff 计划,不依赖渲染后的 DOM 相邻关系

describe('DiffGroup 整框分组', () => {
  /** 收集所有 node decoration 上的 data-diff-group-id */
  function groupIdsIn(plan: ReturnType<typeof buildDiffPlan>): string[] {
    return plan.entries.flatMap(e => e.decos)
      .map(d => (d as any).type?.attrs?.['data-diff-group-id'])
      .filter((id: unknown): id is string => typeof id === 'string')
  }

  it('连续多段新增 → 合成一个 added group,组内 id 一致', () => {
    const plan = buildDiffPlan(
      makeDoc('旧内容.\n\n新段一\n\n新段二\n\n新段三'),
      makeDoc('旧内容.'),
    )
    const added = plan.groups.filter(g => g.kind === 'added')
    expect(added.length).toBe(1)
    expect(added[0].entries.length).toBe(3)
    const ids = groupIdsIn(plan)
    expect(ids.length).toBe(3)
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toBe(added[0].id)
  })

  it('被未变更段隔开的新增 → 两个独立 group', () => {
    const plan = buildDiffPlan(
      makeDoc('新段一\n\nkeep\n\n新段二'),
      makeDoc('keep'),
    )
    const added = plan.groups.filter(g => g.kind === 'added')
    expect(added.length).toBe(2)
    expect(added[0].id).not.toBe(added[1].id)
    expect(added.every(g => g.entries.length === 1)).toBe(true)
  })

  it('单个新增块 → group 的 from/to 与该 entry 一致', () => {
    const plan = buildDiffPlan(makeDoc('旧内容.\n\n新段.'), makeDoc('旧内容.'))
    const added = plan.groups.filter(g => g.kind === 'added')
    expect(added.length).toBe(1)
    const entry = plan.entries[added[0].entries[0]]
    expect(added[0].from).toBe(entry.from)
    expect(added[0].to).toBe(entry.to)
    expect(entry.groupId).toBe(added[0].id)
  })

  it('连续删除 → 合成 deleted group(渲染层不画绿框)', () => {
    const plan = buildDiffPlan(
      makeDoc('keep'),
      makeDoc('第一段\n\n第二段\n\nkeep'),
    )
    const deleted = plan.groups.filter(g => g.kind === 'deleted')
    expect(deleted.length).toBe(1)
    expect(deleted[0].entries.length).toBe(2)
  })

  it('字符级修改(pair)不产生整框组', () => {
    const plan = buildDiffPlan(makeDoc('hello'), makeDoc('hello!'))
    expect(plan.groups.length).toBe(0)
  })

  it('组是全量 plan 的一部分,窄视口下不随增量构建变化', () => {
    const narrow = makeDiffState('旧内容.', '旧内容.\n\n新段一\n\n新段二', { from: 0, to: 1 })
    const full = makeDiffState('旧内容.', '旧内容.\n\n新段一\n\n新段二', null)
    expect(getDiffGroups(narrow)).toEqual(getDiffGroups(full))
    expect(getDiffGroups(narrow).length).toBe(1)
  })
})

// ========== 删除片段里的图片 src ==========
// widget DOM 由 DOMSerializer 生成,不经过 image NodeView;必须把 markdown 里的
// 相对路径也交给视图注入的 resolver,否则预览模式里删除版本的图片全部裂图。

describe('删除片段图片 src 代理', () => {
  // 单段落内两张图:分成两段会被判成 merge op(只有边界提示,没有删除片段)
  const OLD_MD = '![图解](assets/x.png) ![另一张](assets/y.png)'

  function deletedDom(srcResolver?: (s: string) => string): HTMLElement {
    const plan = buildDiffPlan(makeDoc(''), makeDoc(OLD_MD), srcResolver)
    const widgets = plan.entries.flatMap(e => e.decos).filter(d => d.from === d.to)
    expect(widgets.length).toBeGreaterThan(0)
    const dom = document.createElement('div')
    for (const w of widgets) dom.appendChild((w as any).type.toDOM() as HTMLElement)
    return dom
  }

  it('注入 resolver → 片段内所有 <img> 的 src 被改写', () => {
    const dom = deletedDom(src => `asset://localhost/${src}`)
    expect(Array.from(dom.querySelectorAll('img')).map(i => i.getAttribute('src')))
      .toEqual(['asset://localhost/assets/x.png', 'asset://localhost/assets/y.png'])
  })

  it('未注入 resolver → 保持原始 src(纯逻辑 / 测试路径不回归)', () => {
    const dom = deletedDom()
    expect(Array.from(dom.querySelectorAll('img')).map(i => i.getAttribute('src')))
      .toEqual(['assets/x.png', 'assets/y.png'])
  })
})
