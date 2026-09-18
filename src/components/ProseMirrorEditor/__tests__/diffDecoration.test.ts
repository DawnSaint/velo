import { describe, it, expect } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { DecorationSet } from 'prosemirror-view'
import { schema as veloSchema, type VeloSchema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import { buildDecorations, buildDiffPlan, diffDecorationKey, diffDecorationPlugin } from '../plugins/diffDecoration'
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

  it('滚动后粘性追加:新进视口的 block 补建,已建的保留', () => {
    let state = makeDiffState('a\n\nb\n\nc', 'A\n\nB\n\nc', { from: 0, to: 1 })
    const before = diffDecorationKey.getState(state)!.decoSet!.find().length

    // viewport 扩到全文 → 追加剩下两个修改段的装饰
    state = state.apply(state.tr.setMeta(viewportKey, { from: 0, to: state.doc.content.size }))
    const after = diffDecorationKey.getState(state)!.decoSet!.find().length
    expect(after).toBeGreaterThan(before)
  })
})
