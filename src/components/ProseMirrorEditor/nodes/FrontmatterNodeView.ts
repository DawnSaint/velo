// YAML Front Matter NodeView — Typora 风格 styled code block。
//
// schema 给 frontmatter 节点占一槽位(content:'text*', code:true, marks:''),
// 本文件提供 NodeView 渲染:
//   <div class="velo-frontmatter">
//     <div class="velo-frontmatter-header">Front Matter</div>
//     <pre><code>...YAML content...</code></pre>  ← contentDOM(PM 接管文本编辑)
//   </div>
//
// 设计要点:
// - **content:'text*' + 非 atom**:内容可直接在 WYSIWYG 编辑(同 code_block 范式),
//   contentDOM = <code>,PM 接管文本编辑,光标自然进入。
// - **header 不可编辑**:`contentEditable=false`,user-select:none。
// - **code:true**:选区不可"跨"frontmatter(同 code_block / math_inline)。
// - **ignoreMutation**:header 是静态 DOM,内容突变不关心;pre/code 的文本突变
//   由 PM 的 DOMObserver 正常处理(不能 ignore,否则用户输入不同步)。
//   实际上 contentDOM 子树的 mutation PM 会自动放行,这里 ignore 外层 div 的
//   非 contentDOM 突变(如 header 被外部脚本改动)。
// - **stopEvent**:header 不需要交互事件(无按钮),返回 true 隔离 PM 对 header
//   内 click/mousedown 的处理(防点 header 时光标跳到 contentDOM 首部)。

import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'

export function createFrontmatterNodeView() {
  return function frontmatterNodeViewFactory(
    _node: PMNode,
    _view: EditorView,
    _getPos: () => number | undefined,
  ): NodeView {
    const dom = document.createElement('div')
    dom.className = 'velo-frontmatter'
    dom.setAttribute('data-type', 'frontmatter')

    // header 标题栏 —— 不可编辑,纯视觉标识
    const header = document.createElement('div')
    header.className = 'velo-frontmatter-header'
    header.contentEditable = 'false'
    header.textContent = 'Front Matter'
    dom.appendChild(header)

    // contentDOM —— PM 接管文本编辑(同 code_block 的 <pre><code>)
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    pre.appendChild(code)
    dom.appendChild(pre)

    return {
      dom,
      contentDOM: code,
      update(newNode: PMNode) {
        if (newNode.type.name !== 'frontmatter') return false
        return true
      },
      // header 内事件隔离:点击 header 不产生 PM selection 操作
      stopEvent(event: Event) {
        return event.target instanceof Node && header.contains(event.target)
      },
      // header 是静态 DOM,其 mutation 不影响 PM state;contentDOM 内的
      // 文本 mutation 由 PM DOMObserver 自动处理(不经过 ignoreMutation)。
      ignoreMutation(mutation: ViewMutationRecord) {
        return mutation.target instanceof Node && header.contains(mutation.target)
      },
    }
  }
}

export const frontmatterNodeViewKey = new PluginKey('frontmatterNodeView')

export const frontmatterNodeViewPlugin = new Plugin({
  key: frontmatterNodeViewKey,
  props: {
    nodeViews: {
      frontmatter: createFrontmatterNodeView(),
    },
  },
})
