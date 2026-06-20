// v0.4.6 mermaid 走 code_block + Decoration.widget 后的回归测试。
//
// 关注路径:
//  1. 删除按钮:点击 widget toolbar 上的删除按钮,整段 code_block 删除,
//     后续 paragraph 内容**不**被吞进残留的 code_block open token
//     (修 bug:原 `tr.delete(pos, pos+nodeSize)` 收的是 absolutePos
//     = descendant pos + 1,范围越界 1 位,跨过 close token 把下一个
//     paragraph 的 open token + 内容合并进残留 code_block open token,
//     表现:点删除后 code_block 清空 + 后续段落被吞进去,mermaid 删不掉)。
//  2. toggle 按钮:派发 toggleEditAt → editNodeSet 加入对应 pos →
//     pre 切到 data-mermaid-source="visible"(展开源码)。
//  3. 删除时同步清 editNodeSet(toggleEditAt: -1 触发 set 清空)。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import {
  mermaidDecoration,
  mermaidDecoKey,
} from '../nodes/MermaidDecoration'

function makeView(initialMd: string): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(initialMd, schema),
    plugins: [mermaidDecoration],
  })
  const view = new EditorView(container, { state })
  return view
}

function findMermaidCodeBlockPos(view: EditorView): number {
  let pos = -1
  view.state.doc.descendants((node, p) => {
    if (
      node.type.name === 'code_block'
      && (node.attrs.language as string) === 'mermaid'
      && pos === -1
    ) {
      pos = p
      return false
    }
    return true
  })
  return pos
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    const parent = el.parentElement
    if (parent) parent.remove()
  })
})

// ============================================================
//  删除按钮
// ============================================================

describe('mermaidDecoration 删除按钮', () => {
  it('1. 模拟 toolbar 删除按钮的 tr.delete 范围:整段 code_block 被删,后续 paragraph 保留', () => {
    // doc:paragraph("intro") + code_block(lang=mermaid, "graph TD\nA-->B")
    //     + paragraph("after")
    const md = [
      'intro',
      '',
      '```mermaid',
      'graph TD',
      '  A-->B',
      '```',
      '',
      'after',
    ].join('\n')
    const view = makeView(md)

    const codeBlockPos = findMermaidCodeBlockPos(view)
    expect(codeBlockPos).toBeGreaterThanOrEqual(0)

    const codeBlock = view.state.doc.nodeAt(codeBlockPos)!
    expect(codeBlock.type.name).toBe('code_block')
    expect(codeBlock.attrs.language).toBe('mermaid')

    // 模拟 widget toolbar 删除按钮的 tr.delete(用修正后的范围):
    //   blockStart = absolutePos - 1(回到 open token 之前)
    //   blockEnd = blockStart + node.nodeSize(close token 之后)
    //   absolutePos = codeBlockPos + 1 (widget 工厂实际收的坐标)
    const absolutePos = codeBlockPos + 1
    const blockStart = absolutePos - 1
    const blockEnd = blockStart + codeBlock.nodeSize
    const tr = view.state.tr.delete(blockStart, blockEnd)
    tr.setMeta(mermaidDecoKey, { toggleEditAt: -1 })
    view.dispatch(tr)

    // 验证:doc 里不再有 mermaid code_block
    let mermaidCount = 0
    view.state.doc.descendants((node) => {
      if (
        node.type.name === 'code_block'
        && (node.attrs.language as string) === 'mermaid'
      ) {
        mermaidCount++
      }
      return true
    })
    expect(mermaidCount).toBe(0)

    // 验证:paragraph("intro") 和 paragraph("after") 都还在,
    // 它们的 content 完整保留,没被吞进任何残留 code_block
    const text = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
    expect(text).toContain('intro')
    expect(text).toContain('after')

    // 验证:doc 只剩两个 block-level children(2 个 paragraph),没有"残留的
    // 空 code_block open token"这种异常状态
    expect(view.state.doc.childCount).toBe(2)
    expect(view.state.doc.child(0).type.name).toBe('paragraph')
    expect(view.state.doc.child(1).type.name).toBe('paragraph')

    // 验证:editNodeSet 已清空(避免悬挂状态)
    const deco = mermaidDecoKey.getState(view.state)!
    expect(deco.editNodeSet.size).toBe(0)
    expect(deco.pendingFocusSet.size).toBe(0)

    view.destroy()
  })

  it('2. 反向断言:用 buggy 范围 (pos, pos + nodeSize) 会把后续 paragraph 吞进 code_block', () => {
    // 这是 1 的反面证据:旧实现 tr.delete(absolutePos, absolutePos + nodeSize)
    // 范围越界 1 位,跨过 close token 进入下一个 paragraph 的 open token。
    // ProseMirror 会把后续 paragraph 的内容合并进残留的 code_block open token,
    // 表现为"清空 code block + 把后面段落移进去,mermaid 删不掉"。
    const md = [
      'intro',
      '',
      '```mermaid',
      'graph TD',
      '  A-->B',
      '```',
      '',
      'after',
    ].join('\n')
    const view = makeView(md)

    const codeBlockPos = findMermaidCodeBlockPos(view)
    const codeBlock = view.state.doc.nodeAt(codeBlockPos)!
    const absolutePos = codeBlockPos + 1

    // 旧 buggy 范围(绝对不要在生产代码里用,这里仅作回归证据)
    const buggyTr = view.state.tr.delete(absolutePos, absolutePos + codeBlock.nodeSize)
    view.dispatch(buggyTr)

    // 反向断言:用 buggy 范围后,mermaid 节点**没有**被干净删除
    let mermaidCount = 0
    view.state.doc.descendants((node) => {
      if (
        node.type.name === 'code_block'
        && (node.attrs.language as string) === 'mermaid'
      ) {
        mermaidCount++
      }
      return true
    })
    // buggy 路径下:残留的 code_block open token 把"after"吞进去,mermaid
    // 节点 count 仍然是 1,内容 = "after",且 doc child 数仍 = 2 但其中
    // 第二个是混了 after 的 code_block。这条断言锁死这个 buggy 行为,
    // 防止有人将来"重构"时把范围改回去。
    expect(mermaidCount).toBe(1)
    const survivingCodeBlock = (() => {
      let n: any = null
      view.state.doc.descendants((node) => {
        if (
          node.type.name === 'code_block'
          && (node.attrs.language as string) === 'mermaid'
        ) {
          n = node
        }
        return true
      })
      return n
    })()
    expect(survivingCodeBlock.textContent).toContain('after')

    view.destroy()
  })
})

// ============================================================
//  Toggle 按钮(展开 / 收起源码)
// ============================================================

describe('mermaidDecoration toggle 按钮', () => {
  it('toggle 后 editNodeSet 包含对应 pos,pre data-mermaid-source="visible"', () => {
    const md = '```mermaid\ngraph TD\n  A-->B\n```'
    const view = makeView(md)

    const codeBlockPos = findMermaidCodeBlockPos(view)
    const absolutePos = codeBlockPos + 1

    // 初始:editNodeSet 空
    const deco0 = mermaidDecoKey.getState(view.state)!
    expect(deco0.editNodeSet.has(absolutePos)).toBe(false)

    // 点 toggle → editNodeSet 加入 absolutePos
    const tr = view.state.tr.setMeta(mermaidDecoKey, { toggleEditAt: absolutePos })
    view.dispatch(tr)

    const deco1 = mermaidDecoKey.getState(view.state)!
    expect(deco1.editNodeSet.has(absolutePos)).toBe(true)

    // 验证 DOM:pre data-mermaid-source="visible"
    const pre = view.dom.querySelector('pre[data-mermaid-source]') as HTMLElement | null
    expect(pre).not.toBeNull()
    expect(pre!.dataset.mermaidSource).toBe('visible')

    // 再点 → 退出
    const tr2 = view.state.tr.setMeta(mermaidDecoKey, { toggleEditAt: absolutePos })
    view.dispatch(tr2)
    const deco2 = mermaidDecoKey.getState(view.state)!
    expect(deco2.editNodeSet.has(absolutePos)).toBe(false)

    view.destroy()
  })
})

// ============================================================
//  pre 必须保持展开 —— 防止以后误改加入"错误时自动收起"逻辑
// ============================================================
//
// 用户在 v0.4.6 反馈:空 mermaid code_block + 输入乱码 → SVG 显示错误,
// 期望 pre 保持展开让用户立即在源码区修错;valid → invalid 转换同理。
// 这条契约必须由测试锁死 —— 未来谁加 "SVG error 时自动收起 pre" 之类的
// UX 决策会立即触发红测。

describe('mermaidDecoration pre 必须保持展开', () => {
  it('场景 A:空 code_block → toggle 展开 → 输入乱码 → pre 仍 visible', () => {
    // 空 code_block,placeholder 默认显示,pre 隐藏
    const view = makeView('```mermaid\n```')

    const codeBlockPos = findMermaidCodeBlockPos(view)
    const absolutePos = codeBlockPos + 1

    // 初始:pre 隐藏(默认状态)
    let pre = view.dom.querySelector('pre[data-mermaid-source]') as HTMLElement | null
    expect(pre).not.toBeNull()
    expect(pre!.dataset.mermaidSource).toBe('hidden')

    // 用户点 chevron-up 展开 → pre visible
    view.dispatch(view.state.tr.setMeta(mermaidDecoKey, { toggleEditAt: absolutePos }))

    pre = view.dom.querySelector('pre[data-mermaid-source]') as HTMLElement | null
    expect(pre).not.toBeNull()
    expect(pre!.dataset.mermaidSource).toBe('visible')

    // 用户在 code_block content 起点输入乱码(invalid mermaid)。
    // 这是真实用户操作的还原:鼠标点击 chevron-up,光标进 pre,然后键入。
    view.dispatch(view.state.tr.insertText('xxx invalid mermaid xxx', absolutePos))

    // 核心断言:即使 SVG 即将显示 error,pre 必须保持 visible。
    // 历史上的坑:tr.mapping.map(absolutePos) 默认 assoc=+1(关联"变更之后"),
    // 在 insertText(absolutePos) 之后把 content 起点映射到"插入文本末尾",
    // 下次 buildDecorations 用 descendants 重新算的 absolutePos 还是 content
    // 起点,跟 set 对不上 → pre 被误判 hidden。apply 必须用 mapping.map(pos, -1)。
    const deco = mermaidDecoKey.getState(view.state)!
    expect(deco.editNodeSet.size).toBe(1)
    pre = view.dom.querySelector('pre[data-mermaid-source]') as HTMLElement | null
    expect(pre).not.toBeNull()
    expect(pre!.dataset.mermaidSource).toBe('visible')

    view.destroy()
  })

  it('场景 B:valid mermaid → 改 invalid → pre 仍 visible', () => {
    // 先 valid mermaid + toggle 展开(模拟用户已在编辑)
    const view = makeView('```mermaid\ngraph TD\n  A-->B\n```')
    const codeBlockPos = findMermaidCodeBlockPos(view)
    const absolutePos = codeBlockPos + 1

    // 展开
    view.dispatch(view.state.tr.setMeta(mermaidDecoKey, { toggleEditAt: absolutePos }))

    // 把 code_block 内容全部替换为乱码(走 replace,确保 mapping 不为空)
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'code_block' && pos === codeBlockPos) {
        // 用绝对 pos 替换内容:从 absolutePos 到 absolutePos + contentSize
        const replaceFrom = absolutePos
        const replaceTo = absolutePos + node.content.size
        view.dispatch(view.state.tr.replaceWith(replaceFrom, replaceTo, view.state.schema.text('xxx invalid mermaid')))
        return false
      }
      return true
    })

    // 核心断言:editNodeSet 仍包含(映射后的)pos,pre 仍 visible
    const deco = mermaidDecoKey.getState(view.state)!
    expect(deco.editNodeSet.size).toBe(1)
    const pre = view.dom.querySelector('pre[data-mermaid-source]') as HTMLElement | null
    expect(pre).not.toBeNull()
    expect(pre!.dataset.mermaidSource).toBe('visible')

    view.destroy()
  })
})

// ============================================================
//  占位符文案
// ============================================================

describe('mermaidDecoration placeholder 文案', () => {
  it('空 mermaid code_block SVG 区显示 "暂无内容"', () => {
    // v0.4.6+:code_block 默认隐藏,展开入口是 toolbar chevron-up。
    // 占位符仅作为"这里有一个 mermaid 块"的视觉提示,简洁即可。
    const view = makeView('```mermaid\n```')

    // 让 mermaid render 走完:空 source 不调 mermaid.parse,直接走 placeholder
    // 路径,所以同步可见
    const placeholder = view.dom.querySelector('.mermaid-placeholder')
    expect(placeholder).not.toBeNull()
    expect(placeholder!.textContent).toBe('暂无内容')

    view.destroy()
  })
})