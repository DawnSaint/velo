// mark 源码编辑 session 回归:光标进入 **bold** 等 mark 范围 → 整段换源码字符 →
// 编辑 → 光标移出 commit(fromMarkdown 还原)/ Escape 还原。
//
// 走 linkClick / imageEdit 同款 session 范式(markSourceEditPlugin),触发改成
// appendTransaction(光标进入即触发)。编辑模拟用单 step(insertText / delete)——
// session 的 mapping bias(+1/-1)为逐字符编辑设计,复合 step 会把 editFrom/editTo 算反。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'

import { schema } from '../editor/schema'
import { markSourceEditPlugin, markSourceEditKey, markSourceEditEscapeKeymap } from '../plugins/markSourceEdit'
import { syntaxAutoFormatPlugin } from '../plugins/syntaxAutoFormat'
import { SKIP_CONTENT_EMIT } from '../editor/transactionMeta'
import { toggleMarkWithWrap } from '../editor/shortcuts/commands/markCommands'

const tick = (ms = 10): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 构造 doc:paragraph 包给定 inline 节点序列,挂 mark 源码编辑 + syntaxAutoFormat(验证退避)。 */
function makeView(children: PMNode[]): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [schema.node('paragraph', null, children)]),
    plugins: [markSourceEditPlugin, markSourceEditEscapeKeymap, syntaxAutoFormatPlugin],
  })
  return new EditorView(container, { state })
}

/** 光标移到 pos(纯选区变化)→ 触发 appendTransaction 进 session。 */
async function enterAt(view: EditorView, pos: number): Promise<void> {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
  await tick()
}

/** 光标移到 edit 范围之后一格,触发 apply outside → view.update → commit。 */
async function moveCursorOut(view: EditorView): Promise<void> {
  const session = markSourceEditKey.getState(view.state)?.session
  if (!session) return
  const target = Math.min(session.editTo + 1, view.state.doc.content.size)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)))
  await tick()
}

function getTextContent(doc: PMNode): string {
  let text = ''
  doc.descendants((n) => {
    if (n.isText) text += n.text ?? ''
    return true
  })
  return text
}

/** 找第一个 name 类 mark 的 (node, pos);返回 null 表示无。 */
function findMarkNode(doc: PMNode, name: string): { node: PMNode, pos: number } | null {
  let found: { node: PMNode, pos: number } | null = null
  doc.descendants((n, p) => {
    if (n.isText && n.marks.some(m => m.type.name === name)) {
      found = { node: n, pos: p }
      return false
    }
    return true
  })
  return found
}

beforeEach(() => {
  document.querySelectorAll('.ProseMirror').forEach(el => el.parentElement?.remove())
})
afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach(el => el.parentElement?.remove())
})

describe('mark 源码编辑 session', () => {
  it('光标进入 bold 末尾 → 整段换成 **bold** 源码,session 活跃', async () => {
    const view = makeView([
      schema.text('See '),
      schema.text('bold', [schema.marks.strong.create({ marker: '*' })]),
      schema.text(' tail'),
    ])
    await enterAt(view, 9) // bold 末尾边界
    expect(getTextContent(view.state.doc)).toBe('See **bold** tail')
    expect(markSourceEditKey.getState(view.state)?.session).not.toBeNull()
    view.destroy()
  })

  it('改分隔符 **→* 移出 → 还原成 emphasis(非 strong)', async () => {
    const view = makeView([
      schema.text('See '),
      schema.text('bold', [schema.marks.strong.create({ marker: '*' })]),
      schema.text(' tail'),
    ])
    await enterAt(view, 9)
    let s = markSourceEditKey.getState(view.state)?.session!
    // 删源码首位 *(单 step)→ `*bold**`
    view.dispatch(view.state.tr.delete(s.editFrom, s.editFrom + 1))
    await tick(5)
    s = markSourceEditKey.getState(view.state)?.session!
    // 删源码末位 * → `*bold*`
    view.dispatch(view.state.tr.delete(s.editTo - 1, s.editTo))
    await tick(5)
    await moveCursorOut(view)

    expect(findMarkNode(view.state.doc, 'emphasis')).not.toBeNull()
    expect(findMarkNode(view.state.doc, 'strong')).toBeNull()
    view.destroy()
  })

  it('不改移出 → strong 保留 + marker 保真(*)', async () => {
    const view = makeView([
      schema.text('See '),
      schema.text('bold', [schema.marks.strong.create({ marker: '*' })]),
      schema.text(' tail'),
    ])
    await enterAt(view, 9)
    await moveCursorOut(view)

    const found = findMarkNode(view.state.doc, 'strong')
    expect(found).not.toBeNull()
    expect(found!.node.marks.find(m => m.type.name === 'strong')!.attrs.marker).toBe('*')
    view.destroy()
  })

  it('破源码(删闭 **)移出 → fromMarkdown 降级纯文本,不崩不重进', async () => {
    const view = makeView([
      schema.text('See '),
      schema.text('bold', [schema.marks.strong.create({ marker: '*' })]),
      schema.text(' tail'),
    ])
    await enterAt(view, 9)
    const s = markSourceEditKey.getState(view.state)?.session!
    // 删闭 ** 两字符 → `**bold`
    view.dispatch(view.state.tr.delete(s.editTo - 2, s.editTo))
    await tick(5)
    await moveCursorOut(view)

    expect(findMarkNode(view.state.doc, 'strong')).toBeNull()
    expect(getTextContent(view.state.doc)).toContain('bold')
    expect(markSourceEditKey.getState(view.state)?.session).toBeNull()
    view.destroy()
  })

  it('Escape 还原:改坏后 Escape → 还原原 **bold** strong,光标在 editFrom', async () => {
    const view = makeView([
      schema.text('See '),
      schema.text('bold', [schema.marks.strong.create({ marker: '*' })]),
      schema.text(' tail'),
    ])
    await enterAt(view, 9)
    const s = markSourceEditKey.getState(view.state)?.session!
    view.dispatch(view.state.tr.insertText('XX', s.editFrom))
    await tick(5)

    view.focus()
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()

    expect(findMarkNode(view.state.doc, 'strong')).not.toBeNull()
    expect(markSourceEditKey.getState(view.state)?.session).toBeNull()
    view.destroy()
  })

  it('session 内 doc 有 .velo-mark-source-edit decoration', async () => {
    const view = makeView([
      schema.text('See '),
      schema.text('bold', [schema.marks.strong.create({ marker: '*' })]),
      schema.text(' tail'),
    ])
    await enterAt(view, 9)
    expect(view.dom.querySelector('.velo-mark-source-edit')).not.toBeNull()
    view.destroy()
  })

  it('marker 保真:*italic* 与 _italic_ 各自进+移出 marker 不变', async () => {
    const v1 = makeView([
      schema.text('See '),
      schema.text('it', [schema.marks.emphasis.create({ marker: '*' })]),
      schema.text(' tail'),
    ])
    await enterAt(v1, 7) // 'it' 末尾(markStart=5,markEnd=7)
    await moveCursorOut(v1)
    const f1 = findMarkNode(v1.state.doc, 'emphasis')
    expect(f1!.node.marks.find(m => m.type.name === 'emphasis')!.attrs.marker).toBe('*')
    v1.destroy()

    const v2 = makeView([
      schema.text('See '),
      schema.text('it', [schema.marks.emphasis.create({ marker: '_' })]),
      schema.text(' tail'),
    ])
    await enterAt(v2, 7)
    expect(getTextContent(v2.state.doc)).toBe('See _it_ tail') // 源码用 _
    await moveCursorOut(v2)
    const f2 = findMarkNode(v2.state.doc, 'emphasis')
    expect(f2!.node.marks.find(m => m.type.name === 'emphasis')!.attrs.marker).toBe('_')
    v2.destroy()
  })

  it('嵌套 **bold *italic*** 进 → 源码全显;移出 → 两层 mark 都还原', async () => {
    const view = makeView([
      schema.text('See '),
      schema.text('bold ', [schema.marks.strong.create({ marker: '*' })]),
      schema.text('italic', [
        schema.marks.strong.create({ marker: '*' }),
        schema.marks.emphasis.create({ marker: '*' }),
      ]),
      schema.text(' tail'),
    ])
    // italic 末尾 = strong 末尾(markEnd=5+4+1+6=16)
    await enterAt(view, 16)
    expect(getTextContent(view.state.doc)).toBe('See **bold *italic*** tail')
    await moveCursorOut(view)

    expect(findMarkNode(view.state.doc, 'strong')).not.toBeNull()
    expect(findMarkNode(view.state.doc, 'emphasis')).not.toBeNull()
    view.destroy()
  })

  it('退避:session 内键入 → syntaxAutoFormat 不把源码转回 mark', async () => {
    const view = makeView([
      schema.text('See '),
      schema.text('bold', [schema.marks.strong.create({ marker: '*' })]),
      schema.text(' tail'),
    ])
    await enterAt(view, 9)
    // 在源码内部插一个字符(过开 `**` 之后)→ 光标仍在 session 内,不触发 commit
    const s = markSourceEditKey.getState(view.state)?.session!
    view.dispatch(view.state.tr.insertText('X', s.editFrom + 3))
    await tick(5)
    // session 仍活(没被 commit / 没被转成 mark)
    expect(markSourceEditKey.getState(view.state)?.session).not.toBeNull()
    // doc 仍是含字面 `**` 的源码态(未被 syntaxAutoFormat 转成 strong mark)
    expect(getTextContent(view.state.doc)).toContain('**')
    expect(findMarkNode(view.state.doc, 'strong')).toBeNull()
    view.destroy()
  })

  it('session 内 Ctrl-B 不插 ****(forceStoredMarkOnly)', async () => {
    const view = makeView([
      schema.text('See '),
      schema.text('bold', [schema.marks.strong.create({ marker: '*' })]),
      schema.text(' tail'),
    ])
    await enterAt(view, 9)
    const before = getTextContent(view.state.doc)
    // 空选区 + session 内 → 只 setStoredMark,不插包裹符
    toggleMarkWithWrap(schema.marks.strong, '**', '**')(
      view.state,
      (tr) => view.dispatch(tr),
    )
    expect(getTextContent(view.state.doc)).toBe(before) // 无 `****` 插入
    expect(view.state.storedMarks?.some(m => m.type.name === 'strong')).toBe(true)
    view.destroy()
  })

  it('commit 事务不挂 SKIP_CONTENT_EMIT(需回写把 content 同步到还原后的 mark)', async () => {
    // 注:enter 事务由 appendTransaction 派发,PM 内部 apply,不经 view.dispatch ——
    // 无法在单测里拦截它的 meta。SKIP_CONTENT_EMIT 的"进编辑态不回写"语义在真实
    // useProseMirror 里消费,单测只能验证 commit(经 view().update → view.dispatch)
    // 不挂该 meta(commit 必须回写,否则 content 停在源码态与 doc 脱节)。
    const view = makeView([
      schema.text('See '),
      schema.text('bold', [schema.marks.strong.create({ marker: '*' })]),
      schema.text(' tail'),
    ])
    await enterAt(view, 9)
    expect(getTextContent(view.state.doc)).toBe('See **bold** tail') // enter 已生效

    let commitTr: any = null
    const orig = view.dispatch
    view.dispatch = (tr: any) => {
      if (tr.getMeta(markSourceEditKey)?.type === 'commit') commitTr = tr
      orig.call(view, tr)
    }
    await moveCursorOut(view)
    view.dispatch = orig
    expect(commitTr).not.toBeNull()
    expect(commitTr.getMeta(SKIP_CONTENT_EMIT)).toBeUndefined()
    view.destroy()
  })

  it('commit 后不重进:进+移出 → session null 且二次 await 不重进', async () => {
    const view = makeView([
      schema.text('See '),
      schema.text('bold', [schema.marks.strong.create({ marker: '*' })]),
      schema.text(' tail'),
    ])
    await enterAt(view, 9)
    await moveCursorOut(view)
    expect(markSourceEditKey.getState(view.state)?.session).toBeNull()
    await tick(20) // 二次等待,确保 view.update 不会又进 session
    expect(markSourceEditKey.getState(view.state)?.session).toBeNull()
    view.destroy()
  })

  it('Ctrl+B 连续 typing 不触发 enter(docChanged):仍继承 strong', async () => {
    const view = makeView([schema.text(' ')])
    // Mod-b 路径:addStoredMark 后连续键入靠 inclusive 边界继承,enter 不该打断
    view.dispatch(view.state.tr.addStoredMark(schema.marks.strong.create()))
    view.dispatch(view.state.tr.insertText('b'))
    view.dispatch(view.state.tr.insertText('o'))
    // docChanged → enter 未触发,无 session
    expect(markSourceEditKey.getState(view.state)?.session).toBeNull()
    const box = findMarkNode(view.state.doc, 'strong')
    expect(box).not.toBeNull() // 'b' 带 strong(连续输入继承)
    view.destroy()
  })

  it('左边界排除:光标在 markStart(位集无 mark)+ 纯选区变化 → 不进 session', async () => {
    const view = makeView([
      schema.text('See '),
      schema.text('bold', [schema.marks.strong.create({ marker: '*' })]),
      schema.text(' tail'),
    ])
    // markStart=5(inclusive 左边界,resolve(5).marks() 不含 strong)→ 不触发 enter
    await enterAt(view, 5)
    expect(markSourceEditKey.getState(view.state)?.session).toBeNull()
    expect(getTextContent(view.state.doc)).toBe('See bold tail') // 未换源码
    view.destroy()
  })

  it('行首 bold(bold 为段首内容)进入 → **bold** 不碎裂无散落 *', async () => {
    // 回归:mark 在块首时 findMarkRange 左扫曾越过块开 token 落到 pos 0,
    // delete(0, markEnd) 跨块边界 → 结构碎裂成 `**bold*` + 散落 `*`(commit 后变独立行 *)。
    const view = makeView([
      schema.text('bold', [schema.marks.strong.create({ marker: '*' })]),
    ])
    await enterAt(view, 3) // bold 内部
    expect(getTextContent(view.state.doc)).toBe('**bold**') // 整段源码,无散落 *
    expect(markSourceEditKey.getState(view.state)?.session).not.toBeNull()
    let paraCount = 0
    view.state.doc.descendants(n => { if (n.type.name === 'paragraph') paraCount++; return true })
    expect(paraCount).toBe(1) // 未碎成多段
    await moveCursorOut(view)
    expect(findMarkNode(view.state.doc, 'strong')).not.toBeNull()
    expect(getTextContent(view.state.doc)).toBe('bold')
    view.destroy()
  })

  it('行首 emphasis(_A_ 为段首内容)进入 → _A_ 不碎裂,移出还原 marker 保真(_)', async () => {
    const view = makeView([
      schema.text('A', [schema.marks.emphasis.create({ marker: '_' })]),
    ])
    await enterAt(view, 2) // A 末尾边界
    expect(getTextContent(view.state.doc)).toBe('_A_') // 无散落 _
    let paraCount = 0
    view.state.doc.descendants(n => { if (n.type.name === 'paragraph') paraCount++; return true })
    expect(paraCount).toBe(1)
    await moveCursorOut(view)
    const found = findMarkNode(view.state.doc, 'emphasis')
    expect(found).not.toBeNull()
    expect(found!.node.marks.find(m => m.type.name === 'emphasis')!.attrs.marker).toBe('_')
    expect(getTextContent(view.state.doc)).toBe('A')
    view.destroy()
  })
})
