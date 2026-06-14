// 回归测试:linkAutoFormatPlugin —— [text](url) 变化后自动加 link mark
//
// InputRule 只对单字键入紧贴匹配末尾响应;粘贴 / 中间删除补回都不触发。
// 这个 plugin 走 appendTransaction,在每次 docChanged 后扫整个 doc。
//
// 覆盖场景:
//  1. 粘贴整段 markdown 含 [text](url) → 自动转
//  2. 删除链接的 [ 再补回 → 重新转
//  3. 已转换链接末尾输入新字符 → 不被吸进 link mark
//  4. 编辑态 session 范围内的源码不被抢

import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../../editor/schema'
import { linkClickPlugin, linkAutoFormatPlugin } from '../linkClick'

function mountView(docText: string): { view: EditorView, cleanup: () => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, docText ? [schema.text(docText)] : []),
  ])
  const state = EditorState.create({
    schema,
    doc,
    plugins: [linkClickPlugin, linkAutoFormatPlugin],
  })
  const view = new EditorView(host, { state })
  return { view, cleanup: () => { view.destroy(); host.remove() } }
}

describe('linkAutoFormatPlugin', () => {
  it('粘贴整段含 [text](url) → 自动转换为 link mark', () => {
    const { view, cleanup } = mountView('')
    // 模拟粘贴:在 doc 起始位置插入纯文本
    const tr = view.state.tr.insertText('See [CommonMark](https://commonmark.org).', 1)
    view.dispatch(tr)

    const para = view.state.doc.firstChild!
    // appendTransaction 把 [CommonMark](...) 替换为 text+link mark
    // 段落子节点应该是: text("See ") + text("CommonMark", linkMark) + text(".")
    const linkText = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find(c => c.text === 'CommonMark')
    expect(linkText).toBeDefined()
    expect(linkText!.marks.find(m => m.type.name === 'link')?.attrs.href).toBe('https://commonmark.org')

    // 链接源码 [...](...)  不再出现在 textContent 里
    expect(view.state.doc.textContent).toBe('See CommonMark.')
    cleanup()
  })

  it('删除链接末尾的 ) 再补回 → 自动重新转换', () => {
    const { view, cleanup } = mountView('')
    // 先粘贴成完整链接 → 自动转换
    view.dispatch(view.state.tr.insertText('[X](https://x.com)', 1))
    expect(view.state.doc.textContent).toBe('X')

    // 模拟用户把渲染好的链接改成纯文本(整段替换为源码)
    // 实际场景:点击进入编辑态后退出 / 直接选中替换。这里直接替换段落内容模拟
    const para = view.state.doc.firstChild!
    const paraStart = 1
    const paraEnd = paraStart + para.content.size
    view.dispatch(view.state.tr.replaceWith(paraStart, paraEnd, schema.text('[Y](https://y.com')))
    // 此时不是合法 link 语法(缺右括号),不该转
    expect(view.state.doc.textContent).toBe('[Y](https://y.com')

    // 用户补上 )
    const insertPos = view.state.doc.firstChild!.content.size + 1
    view.dispatch(view.state.tr.insertText(')', insertPos))

    // 现在应该转成链接
    expect(view.state.doc.textContent).toBe('Y')
    const newPara = view.state.doc.firstChild!
    const linkChild = newPara.firstChild!
    expect(linkChild.text).toBe('Y')
    expect(linkChild.marks.find(m => m.type.name === 'link')?.attrs.href).toBe('https://y.com')
    cleanup()
  })

  it('链接末尾输入 → 新字符不带 link mark', () => {
    const { view, cleanup } = mountView('')
    view.dispatch(view.state.tr.insertText('[X](https://x.com)', 1))
    expect(view.state.doc.textContent).toBe('X')

    // 把光标放在链接末尾(text "X" 之后)
    const para = view.state.doc.firstChild!
    const linkEnd = 1 + para.content.size
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, linkEnd)))

    // 输入新字符
    view.dispatch(view.state.tr.insertText('Z'))

    // 文本是 "XZ" 但 Z 不带 link mark(因 link inclusive: false)
    expect(view.state.doc.textContent).toBe('XZ')
    const newPara = view.state.doc.firstChild!
    expect(newPara.childCount).toBe(2)
    const link = Array.from({ length: newPara.childCount }, (_, i) => newPara.child(i))
      .find(c => c.text === 'X')
    const tail = Array.from({ length: newPara.childCount }, (_, i) => newPara.child(i))
      .find(c => c.text === 'Z')
    expect(link?.marks.find(m => m.type.name === 'link')).toBeDefined()
    expect(tail?.marks.find(m => m.type.name === 'link')).toBeUndefined()
    cleanup()
  })

  it('已带 link mark 的文本不被重复转换', () => {
    const { view, cleanup } = mountView('')
    view.dispatch(view.state.tr.insertText('[X](https://x.com)', 1))
    const docBefore = view.state.doc.toString()

    // 触发一次空 transaction(改 selection 即可)
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)))

    // doc 不变(text 节点已经带 link mark,被跳过)
    expect(view.state.doc.toString()).toBe(docBefore)
    cleanup()
  })
})