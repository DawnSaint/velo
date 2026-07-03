// 图片源码编辑态回归:点击选中 → 右上角 code-xml 按钮 → image 节点替换成
// `![alt](src "title")` 纯文本 → 光标进文本编辑 → 光标移出 commit(合法重建
// image / 残缺保留纯文本 / 空值删除)/ Escape 还原。
//
// 走 linkClick 同款 session 范式(imageEditPlugin),不是 NodeView textarea 浮层。
// 范式参照 mathBlockAutoEdit.test.ts:EditorState + EditorView + dispatch tr +
// 断言 view.state.doc。
//
// 编辑模拟用单 step(insertText / delete)—— session 的 mapping bias(+1/-1)
// 为"光标在范围内逐字符编辑"设计,复合 step(delete 整段 + insert 整段)会把
// editFrom/editTo 算反。单字符插入/删除时 mapping 正确,贴近真实用户输入。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Node as PMNode } from 'prosemirror-model'
import { EditorState, NodeSelection, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'

import { createImageNodeView } from '../editor/imageNodeView'
import { schema } from '../editor/schema'
import { imageEditKey, createImageEditPlugin, imageEditEscapeKeymap, triggerImageEdit } from '../image/imageEditPlugin'
import { parseImageSource, serializeImageSource } from '../image/imageSource'
import { SKIP_CONTENT_EMIT } from '../editor/transactionMeta'

const identityProxy = (u: string): string => u

const imageNodeViewPlugin = new Plugin({
  key: new PluginKey('test-image-nodeview'),
  props: { nodeViews: { image: createImageNodeView({ proxyDomURL: identityProxy }) } },
})

const imageEditPlugin = createImageEditPlugin({ proxyDomURL: identityProxy })

function makeView(imageNode: PMNode): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [schema.node('paragraph', null, [imageNode])]),
    plugins: [imageNodeViewPlugin, imageEditPlugin, imageEditEscapeKeymap],
  })
  return new EditorView(container, { state })
}

function imageNode(attrs: { src?: string; alt?: string; title?: string } = {}): PMNode {
  return schema.nodes.image.create({
    src: attrs.src ?? 'a.png',
    alt: attrs.alt ?? 'alt',
    title: attrs.title ?? 'title',
  })
}

function getImagePos(doc: PMNode): number {
  let pos = -1
  doc.descendants((n, p) => {
    if (n.type.name === 'image') {
      pos = p
      return false
    }
    return true
  })
  return pos
}

function getImageNode(doc: PMNode): PMNode | null {
  let found: PMNode | null = null
  doc.descendants((n) => {
    if (n.type.name === 'image') {
      found = n
      return false
    }
    return true
  })
  return found
}

function getTextContent(doc: PMNode): string {
  let text = ''
  doc.descendants((n) => {
    if (n.isText) text += n.text ?? ''
    return true
  })
  return text
}

/** 选中 image → 点编辑按钮 → image 节点已替换成源码纯文本,光标在文本内。 */
async function enterEdit(view: EditorView): Promise<void> {
  const pos = getImagePos(view.state.doc)
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
  await new Promise((r) => setTimeout(r, 10))

  const wrapper = view.dom.querySelector('.velo-image-inline') as HTMLElement
  expect(wrapper.classList.contains('selected')).toBe(true)

  const editBtn = wrapper.querySelector('.image-edit-btn') as HTMLButtonElement
  editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 10))

  // image 已被替换成纯文本,doc 里不再有 image 节点
  expect(getImageNode(view.state.doc)).toBeNull()
  expect(view.state.selection).toBeInstanceOf(TextSelection)
}

/** 光标移到 edit 范围之后一格,触发 apply outside → view.update → commit。 */
async function moveCursorOut(view: EditorView): Promise<void> {
  const session = imageEditKey.getState(view.state).session
  if (!session) return
  const target = Math.min(session.editTo + 1, view.state.doc.content.size)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)))
  await new Promise((r) => setTimeout(r, 10))
}

beforeEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    el.parentElement?.remove()
  })
})

afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    el.parentElement?.remove()
  })
})

describe('parseImageSource / serializeImageSource', () => {
  it('合法:基础形态', () => {
    expect(parseImageSource('![alt](src)')).toEqual({ alt: 'alt', src: 'src', title: '' })
    expect(parseImageSource('![alt](src "t")')).toEqual({ alt: 'alt', src: 'src', title: 't' })
    expect(parseImageSource('![](src)')).toEqual({ alt: '', src: 'src', title: '' })
    expect(parseImageSource('![](src "")')).toEqual({ alt: '', src: 'src', title: '' })
  })

  it('合法:alt 含空格 / 尾空格', () => {
    expect(parseImageSource('![alt text](src)')?.alt).toBe('alt text')
    expect(parseImageSource('![alt](src )')).toEqual({ alt: 'alt', src: 'src', title: '' })
    expect(parseImageSource('![alt](src "t" )')).toEqual({ alt: 'alt', src: 'src', title: 't' })
  })

  it('合法:src 含空格(本地路径 / 含空格锚点)', () => {
    // 旧 [^()\s]* 排空格 → 含空格 src 判残缺,展开编辑 commit 后被 toMarkdown 转义成
    // \![..]\(..)。与 syntax/inline/link.ts pattern 对齐放宽。
    expect(parseImageSource('![alt](path with space.png)')).toEqual({ alt: 'alt', src: 'path with space.png', title: '' })
    expect(parseImageSource('![alt](# Markdown 语法)')).toEqual({ alt: 'alt', src: '# Markdown 语法', title: '' })
    expect(parseImageSource('![alt](path with space "my title")')).toEqual({ alt: 'alt', src: 'path with space', title: 'my title' })
  })

  it('残缺:返回 null', () => {
    expect(parseImageSource('text ![alt](src)')).toBeNull() // 前缀
    expect(parseImageSource('![alt]src')).toBeNull() // 缺括号
    expect(parseImageSource('![alt](src')).toBeNull() // 缺 )
    expect(parseImageSource("![alt](src 't')")).toBeNull() // 单引号 title
    expect(parseImageSource('![a](a)b)')).toBeNull() // src 禁括号
    expect(parseImageSource('')).toBeNull() // 空串
  })

  it('serialize:title 为空时省略', () => {
    expect(serializeImageSource({ src: 's', alt: 'a', title: '' })).toBe('![a](s)')
    expect(serializeImageSource({ src: 's', alt: 'a', title: 't' })).toBe('![a](s "t")')
    expect(serializeImageSource({ src: 's', alt: '', title: '' })).toBe('![](s)')
  })

  it('round-trip:合法输入 serialize(parse(x)) 等价', () => {
    const cases = ['![alt](src)', '![alt](src "t")', '![](src)', '![alt text](src "a title")']
    for (const c of cases) {
      const parsed = parseImageSource(c)
      expect(parsed).not.toBeNull()
      expect(serializeImageSource(parsed!)).toBe(c)
    }
  })
})

describe('image 源码编辑 session', () => {
  it('选中后渲染悬浮 code-xml 按钮', async () => {
    const view = makeView(imageNode())
    const pos = getImagePos(view.state.doc)
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
    await new Promise((r) => setTimeout(r, 10))

    const wrapper = view.dom.querySelector('.velo-image-inline') as HTMLElement
    expect(wrapper.classList.contains('selected')).toBe(true)
    const btn = wrapper.querySelector('.image-edit-btn') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.querySelector('svg')).not.toBeNull() // code-xml SVG
    view.destroy()
  })

  it('点按钮把 image 节点替换成源码纯文本,光标落进文本', async () => {
    const view = makeView(imageNode({ src: 'a.png', alt: 'alt', title: 't' }))
    await enterEdit(view)

    expect(getTextContent(view.state.doc)).toBe('![alt](a.png "t")')
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    view.destroy()
  })

  it('合法 commit:未改文本光标移出 → 重建 image,attrs 保持', async () => {
    const view = makeView(imageNode({ src: 'a.png', alt: 'alt', title: 't' }))
    await enterEdit(view)
    await moveCursorOut(view)

    const img = getImageNode(view.state.doc)
    expect(img).not.toBeNull()
    expect(img!.attrs.src).toBe('a.png')
    expect(img!.attrs.alt).toBe('alt')
    expect(img!.attrs.title).toBe('t')
    view.destroy()
  })

  it('合法 commit:改 src 后光标移出 → 重建 image,src 写回', async () => {
    const view = makeView(imageNode({ src: 'a.png', alt: 'alt', title: 't' }))
    await enterEdit(view)
    // 默认选中 `()` 内的 src,光标在 src 起点,插 X → src 变 Xa.png(mapping 友好的单 step)
    view.dispatch(view.state.tr.insertText('X', view.state.selection.from))
    await new Promise((r) => setTimeout(r, 5))
    await moveCursorOut(view)

    const img = getImageNode(view.state.doc)
    expect(img).not.toBeNull()
    expect(img!.attrs.src).toBe('Xa.png')
    expect(img!.attrs.alt).toBe('alt')
    view.destroy()
  })

  it('默认选中 `()` 内的 src(无 title:整段 src;有 title:仅 src)', async () => {
    // 无 title:`![alt](a.png)` → 选中 a.png(正是 `()` 内全部内容)
    const v1 = makeView(imageNode({ src: 'a.png', alt: 'alt', title: '' }))
    await enterEdit(v1)
    const sel1 = v1.state.selection
    expect(v1.state.doc.textBetween(sel1.from, sel1.to, '\n', '\n')).toBe('a.png')
    v1.destroy()

    // 有 title:`![alt](a.png "t")` → 仍只选 a.png(title 保留)
    const v2 = makeView(imageNode({ src: 'a.png', alt: 'alt', title: 't' }))
    await enterEdit(v2)
    const sel2 = v2.state.selection
    expect(v2.state.doc.textBetween(sel2.from, sel2.to, '\n', '\n')).toBe('a.png')
    v2.destroy()
  })

  it('编辑态渲染图片预览 widget,src 合法时显示', async () => {
    const view = makeView(imageNode({ src: 'a.png', alt: 'alt', title: '' }))
    await enterEdit(view)

    const preview = view.dom.querySelector('.velo-image-source-preview') as HTMLImageElement
    expect(preview).not.toBeNull()
    expect(preview.tagName).toBe('IMG')
    expect(preview.src).toContain('a.png')
    view.destroy()
  })

  it('源码残缺(删 `!`)时预览 widget 消失', async () => {
    const view = makeView(imageNode({ src: 'a.png', alt: 'alt', title: '' }))
    await enterEdit(view)
    expect(view.dom.querySelector('.velo-image-source-preview')).not.toBeNull()

    const session = imageEditKey.getState(view.state).session!
    view.dispatch(view.state.tr.delete(session.editFrom, session.editFrom + 1)) // 删 `!`
    await new Promise((r) => setTimeout(r, 5))

    // `[alt](a.png)` 不匹配 `^!\[` → 残缺 → 预览不挂
    expect(view.dom.querySelector('.velo-image-source-preview')).toBeNull()
    view.destroy()
  })

  it('残缺源码 commit:删 `!` 后光标移出 → 保留为纯文本(Obsidian 降级)', async () => {
    const view = makeView(imageNode({ src: 'a.png', alt: 'alt', title: 't' }))
    await enterEdit(view)
    const session = imageEditKey.getState(view.state).session!
    // 删掉开头的 `!` → `[alt](a.png "t")` 不匹配 `^!\[` → 残缺(单 step,mapping 友好)
    view.dispatch(view.state.tr.delete(session.editFrom, session.editFrom + 1))
    await new Promise((r) => setTimeout(r, 5))
    await moveCursorOut(view)

    expect(getImageNode(view.state.doc)).toBeNull()
    expect(getTextContent(view.state.doc)).toBe('[alt](a.png "t")')
    view.destroy()
  })

  it('空值 commit:删空整段后光标移出 → 删除图片节点', async () => {
    const view = makeView(imageNode())
    await enterEdit(view)
    const session = imageEditKey.getState(view.state).session!
    // 删空整段 edit 范围
    view.dispatch(view.state.tr.delete(session.editFrom, session.editTo))
    await new Promise((r) => setTimeout(r, 5))
    await moveCursorOut(view)

    expect(getImageNode(view.state.doc)).toBeNull()
    expect(getTextContent(view.state.doc)).toBe('')
    view.destroy()
  })

  it('Escape 还原:改坏后 Escape → 重建原 image 节点,attrs 未变', async () => {
    const view = makeView(imageNode({ src: 'a.png', alt: 'alt', title: 't' }))
    const before = getImageNode(view.state.doc)!.attrs
    await enterEdit(view)
    const session = imageEditKey.getState(view.state).session!
    // 改坏:删掉 `!`
    view.dispatch(view.state.tr.delete(session.editFrom, session.editFrom + 1))
    await new Promise((r) => setTimeout(r, 5))

    // 按 Escape
    view.focus()
    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((r) => setTimeout(r, 10))

    // 还原成 image,attrs 与点击前一致
    const img = getImageNode(view.state.doc)
    expect(img).not.toBeNull()
    expect(img!.attrs).toEqual(before)
    view.destroy()
  })

  it('编辑态 doc 里有 .velo-image-source-edit decoration', async () => {
    const view = makeView(imageNode())
    await enterEdit(view)

    expect(view.dom.querySelector('.velo-image-source-edit')).not.toBeNull()
    view.destroy()
  })

  it('triggerImageEdit 程序化触发:不依赖 DOM click 也能进 session', () => {
    const view = makeView(imageNode())
    const pos = getImagePos(view.state.doc)

    triggerImageEdit(view, pos)

    expect(getImageNode(view.state.doc)).toBeNull()
    expect(getTextContent(view.state.doc)).toBe('![alt](a.png "title")')
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    view.destroy()
  })

  it('trigger 事务挂 SKIP_CONTENT_EMIT(进编辑态不触发内容回写,不误判 dirty)', () => {
    const view = makeView(imageNode())
    const pos = getImagePos(view.state.doc)

    // 拦截 view.dispatch,读 triggerImageEdit 派发的 tr 是否带 SKIP_CONTENT_EMIT。
    // 进入编辑态(image→源码文本)是瞬时视图切换,不该 emit 内容;否则纯文本里
    // `![...](` 被 toMarkdown 转义,与渲染态 image 序列化结果不同 → 误判 dirty。
    let captured: { tr: any } | null = null
    const origDispatch = view.dispatch
    view.dispatch = (tr: any) => {
      if (tr.getMeta(SKIP_CONTENT_EMIT) !== undefined) captured = { tr }
      origDispatch.call(view, tr)
    }
    triggerImageEdit(view, pos)
    view.dispatch = origDispatch

    expect(captured).not.toBeNull()
    expect(captured!.tr.getMeta(SKIP_CONTENT_EMIT)).toBe(true)
    view.destroy()
  })

  it('commit 事务不挂 SKIP_CONTENT_EMIT(需要回写把 content 同步到重建后的 image)', async () => {
    const view = makeView(imageNode({ src: 'a.png', alt: 'alt', title: 't' }))
    await enterEdit(view)

    let commitTr: any = null
    const origDispatch = view.dispatch
    view.dispatch = (tr: any) => {
      if (tr.getMeta(imageEditKey)?.type === 'commit') commitTr = tr
      origDispatch.call(view, tr)
    }
    await moveCursorOut(view)
    view.dispatch = origDispatch

    // commit 必须回写:把 content 从编辑期间的转义文本同步到重建后的 image 形态
    expect(commitTr).not.toBeNull()
    expect(commitTr.getMeta(SKIP_CONTENT_EMIT)).toBeUndefined()
    view.destroy()
  })
})

describe('选中图片时键入不生效(NodeSelection inert)', () => {
  function selectImage(view: EditorView): void {
    const pos = getImagePos(view.state.doc)
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
  }

  it('handleKeyDown:可打印字符返回 true(PM preventDefault,不 insert)', () => {
    const view = makeView(imageNode())
    selectImage(view)
    const swallowed = view.someProp('handleKeyDown', f => f(view, new KeyboardEvent('keydown', { key: 'a' })))
    expect(swallowed).toBe(true)
    view.destroy()
  })

  it('handleKeyDown:Backspace/Delete/方向键/Enter/Escape 不吞(PM 默认删图/移动)', () => {
    const view = makeView(imageNode())
    selectImage(view)
    for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape']) {
      expect(view.someProp('handleKeyDown', f => f(view, new KeyboardEvent('keydown', { key })))).toBeFalsy()
    }
    view.destroy()
  })

  it('handleKeyDown:ctrl/meta/alt 组合不吞(复制/剪切/保存等快捷键照常)', () => {
    const view = makeView(imageNode())
    selectImage(view)
    expect(view.someProp('handleKeyDown', f => f(view, new KeyboardEvent('keydown', { key: 'a', ctrlKey: true })))).toBeFalsy()
    expect(view.someProp('handleKeyDown', f => f(view, new KeyboardEvent('keydown', { key: 'a', metaKey: true })))).toBeFalsy()
    expect(view.someProp('handleKeyDown', f => f(view, new KeyboardEvent('keydown', { key: 'a', altKey: true })))).toBeFalsy()
    view.destroy()
  })

  it('handleTextInput:选中图片返回 true(吞掉 readDOMChange / keypress 路径的文本插入)', () => {
    const view = makeView(imageNode())
    selectImage(view)
    const sel = view.state.selection
    const swallowed = view.someProp('handleTextInput', f => f(view, sel.from, sel.to, 'x', () => view.state.tr.insertText('x')))
    expect(swallowed).toBe(true)
    expect(getImageNode(view.state.doc)).not.toBeNull() // 图片未被替换
    view.destroy()
  })

  it('未选中图片(TextSelection)时不吞,正常输入', () => {
    const view = makeView(imageNode())
    // 光标放在图片后(段落末),TextSelection 而非 NodeSelection
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)))
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    const sel = view.state.selection
    expect(view.someProp('handleTextInput', f => f(view, sel.from, sel.to, 'x', () => view.state.tr.insertText('x')))).toBeFalsy()
    expect(view.someProp('handleKeyDown', f => f(view, new KeyboardEvent('keydown', { key: 'a' })))).toBeFalsy()
    view.destroy()
  })
})
