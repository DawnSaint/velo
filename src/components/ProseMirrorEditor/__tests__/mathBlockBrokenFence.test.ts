// 用户主诉场景:end-to-end
//
//   ```
//   $$          ← 公式块
//   xxx \\
//   $$
//   ```
//   删掉末尾一个 `$` → 期望整块退回**普通文本段落**,内容逐字保留,
//   不出现 `\$\$` / 额外转义,且后续段落不被吞掉。
//
// 这套行为依赖解析层的自写 strictMath(plugins/strictMath):
//   - 未闭合的 `$$` 围栏当普通文本,不再贪婪吞并后文;
//   - 段落里的 `$` 不再被 remark-stringify 转义成 `\$`。
// 两者缺一,"退回段落"和"不产生转义"就会互相打架。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { mathEditPlugin } from '../nodes/MathNodeViews'
import { fromMarkdown, toMarkdown } from '../editor/markdownIO'

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

/** 公式块里的内容(两个字面反斜杠,LaTeX 换行)。 */
const CONTENT = '$$\nxxx \\\\\n$$'

/** 删掉 math_block 最后一个字符(即末尾的 `$`)。 */
function deleteLastDollar(view: EditorView) {
  let blockStart = -1
  view.state.doc.descendants((n, p) => {
    if (n.type.name === 'math_block') { blockStart = p; return false }
    return true
  })
  expect(blockStart).toBeGreaterThanOrEqual(0)
  const node = view.state.doc.nodeAt(blockStart)!
  const lastPos = blockStart + 1 + node.textContent.length - 1
  view.dispatch(view.state.tr.delete(lastPos, lastPos + 1))
}

function nodeTypes(doc: any): string[] {
  const out: string[] = []
  doc.descendants((n: any, _p: number) => {
    if (n.isTextblock) out.push(n.type.name)
    return true
  })
  return out
}

describe('删掉末尾 $ → 退回普通文本段落', () => {
  it('降级为 paragraph,文本逐字保留且不含转义', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const doc = schema.node('doc', null, [
      schema.node('math_block', null, [schema.text(CONTENT)]),
      schema.node('paragraph', null, [schema.text('next')]),
    ])
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, doc.child(0).nodeSize + 1),
      plugins: [mathEditPlugin],
    })
    const view = new EditorView(container, { state })
    await new Promise(r => setTimeout(r, 50))

    deleteLastDollar(view)
    await new Promise(r => setTimeout(r, 50))

    // 不再是 math_block
    expect(nodeTypes(view.state.doc)).toEqual(['paragraph', 'paragraph'])
    expect(view.state.doc.child(0).textContent).toBe('$$\nxxx \\\\\n$')
    // 逐字保留:没有出现 `\$` 转义
    expect(view.state.doc.child(0).textContent).not.toContain('\\$')

    view.destroy()
  })

  it('降级后就是普通段落:没有公式块 DOM、没有预览框,失焦也可见', async () => {
    // 之前的失败模式:破坏态要么被塞进预览框(视觉上仍是公式块),
    // 要么源码层与预览层同时隐藏(失焦后整块空白)。降级成段落两种问题都没有。
    const container = document.createElement('div')
    document.body.appendChild(container)
    const doc = schema.node('doc', null, [
      schema.node('math_block', null, [schema.text(CONTENT)]),
      schema.node('paragraph', null, [schema.text('next')]),
    ])
    const state = EditorState.create({
      schema,
      doc,
      // 光标放在后面的段落 → 前面的块处于"失焦"状态
      selection: TextSelection.create(doc, doc.child(0).nodeSize + 1),
      plugins: [mathEditPlugin],
    })
    const view = new EditorView(container, { state })
    await new Promise(r => setTimeout(r, 50))

    deleteLastDollar(view)
    await new Promise(r => setTimeout(r, 50))

    expect(view.dom.querySelector('.math-block-node')).toBeNull()
    expect(view.dom.querySelector('.math-block-display')).toBeNull()
    expect(view.dom.querySelector('.katex')).toBeNull()
    // 普通段落节点,文本直接可见
    expect(view.dom.querySelector('p')?.textContent).toBe('$$\nxxx \\\\\n$')

    view.destroy()
  })

  it('toMarkdown 不再产生 \\$ 转义', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const doc = schema.node('doc', null, [
      schema.node('math_block', null, [schema.text(CONTENT)]),
      schema.node('paragraph', null, [schema.text('next')]),
    ])
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, doc.child(0).nodeSize + 1),
      plugins: [mathEditPlugin],
    })
    const view = new EditorView(container, { state })
    await new Promise(r => setTimeout(r, 50))

    deleteLastDollar(view)
    await new Promise(r => setTimeout(r, 50))

    const md = toMarkdown(view.state.doc)
    // 关键:不再是 `\$\$`。严格解析下裸 `$$` 行不会吞并后文,转义已无必要。
    expect(md).not.toContain('\\$')
    expect(md).toContain('$$')
    // 后续段落仍在,没被吞进公式块
    expect(md).toContain('next')

    view.destroy()
  })

  it('round-trip:写回 markdown 再读回,后续段落不被吞', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const doc = schema.node('doc', null, [
      schema.node('math_block', null, [schema.text(CONTENT)]),
      schema.node('paragraph', null, [schema.text('next')]),
    ])
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, doc.child(0).nodeSize + 1),
      plugins: [mathEditPlugin],
    })
    const view = new EditorView(container, { state })
    await new Promise(r => setTimeout(r, 50))

    deleteLastDollar(view)
    await new Promise(r => setTimeout(r, 50))

    const md = toMarkdown(view.state.doc)
    const back = fromMarkdown(md, schema)

    // 两个段落都还在 —— 这正是 strictMath 防止的数据损坏
    expect(nodeTypes(back)).toEqual(['paragraph', 'paragraph'])
    expect(back.child(0).textContent).toBe('$$\nxxx \\\\\n$')
    expect(back.child(1).textContent).toBe('next')

    view.destroy()
  })

  it('整篇多公式块时,破坏的块不会吞掉其它块', () => {
    // 只做"EOF 失败"防不住这个:破坏的围栏会一直匹配到下一个公式块的闭合行,
    // 把中间的 text 一起吞掉。空行终止把搜索范围限制在单个段落内。
    //
    // 这里直接测"磁盘上的真实内容",模拟下次打开文件:
    const md = '$$\nA\n$\n\ntext\n\n$$\nB\n$$\n'
    const doc = fromMarkdown(md, schema)

    expect(nodeTypes(doc)).toEqual(['paragraph', 'paragraph', 'math_block'])
    expect(doc.child(0).textContent).toBe('$$\nA\n$')
    expect(doc.child(1).textContent).toBe('text')
    expect(doc.child(2).textContent).toBe('$$\nB\n$$')
    // 写回去不产生转义,结构保持
    expect(toMarkdown(doc)).not.toContain('\\$')
  })
})
