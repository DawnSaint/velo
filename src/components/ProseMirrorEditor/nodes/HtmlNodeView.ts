// HTML 透传 + DOMPurify sanitize NodeView。
//
// schema 给 html_block / html_inline 两个 atom 节点各占一槽,attrs.value 存原始
// HTML 字符串。本文件提供 NodeView 把 value 渲染到真实 DOM。
//
// 设计要点:
// - **atom = true**:节点不可编辑,内容来自 attrs.value,用户改 HTML 走"删了重建"
//   的语义(后续可以加源码编辑模式,v0.4.1 不做)。
// - **DOMPurify sanitize**:CSP 已开 unsafe-inline + unsafe-eval,浏览器不挡 script,
//   必须 JS 端清洗。FORBID_TAGS / FORBID_ATTR 显式列出常见危险项,即使 dompurify
//   后续放宽默认也不会被绕过。
// - **stopEvent / ignoreMutation**:atom 节点要把内部 DOM 突变 / 事件与 ProseMirror
//   隔离,否则用户在 details 里点 summary 折叠会被 ProseMirror 当 selection 操作。
//
// 不在这里:
// - schema 节点定义(在 editor/schema.ts)
// - markdownIO 双向(在 editor/markdownIO.ts)

import DOMPurify from 'dompurify'
import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorView, NodeView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { createSelectionSync } from './selectionSync'

// dompurify v3:Config 通过 Parameters<typeof sanitize>[1] 拿,namespace 不再导出
type PurifyConfig = Parameters<typeof DOMPurify.sanitize>[1]

const PURIFY_CONFIG: PurifyConfig = {
  // 显式禁危险项;dompurify 默认就禁掉这些,显式更稳防默认放宽
  FORBID_TAGS: ['script', 'iframe', 'form', 'object', 'embed'],
  FORBID_ATTR: [
    'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur',
    'onchange', 'onsubmit', 'onkeydown', 'onkeyup', 'onkeypress',
  ],
  // 不允许 javascript: URL —— 默认就禁,显式更稳
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp|asset|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
}

/** 用 DOMPurify 清洗 HTML 字符串后写到目标元素。 */
function safeRender(target: HTMLElement, raw: string): void {
  // dompurify 默认返回 string;ts 类型有几种重载,这里强制为 string
  target.innerHTML = DOMPurify.sanitize(raw, PURIFY_CONFIG) as unknown as string
}

/** 块级 HTML NodeView。dom = <div class="velo-html-block">,内容 sanitize 后写入。 */
function createHtmlBlockView(node: PMNode, view: EditorView, getPos: () => number): NodeView {
  const dom = document.createElement('div')
  dom.className = 'velo-html-block'
  dom.setAttribute('data-type', 'html_block')
  safeRender(dom, node.attrs.value as string)

  // 选中态同步:与 image / hr / math_block 同范式,抽取到 selectionSync.ts 共用。
  const selectionSync = createSelectionSync({
    dom,
    view,
    getPos,
    getNode: () => node,
  })

  return {
    dom,
    // atom 节点不更新(value 不变就不重渲);value 变就让 ProseMirror destroy + 重建
    update: (newNode) => {
      if (newNode.type.name !== 'html_block') return false
      if (newNode.attrs.value === node.attrs.value) { node = newNode; return true }
      return false
    },
    selectNode() { selectionSync.syncSelected() },
    deselectNode() { selectionSync.syncSelected() },
    // 内部 DOM 变(details 折叠等)不让 ProseMirror 知道
    ignoreMutation: () => true,
    // 内部事件不让 ProseMirror 抢(用户点 summary 时正常折叠)
    stopEvent: () => true,
    destroy() {
      selectionSync.destroy()
    },
  }
}

/** 行内 HTML NodeView。dom = <span class="velo-html-inline">。 */
function createHtmlInlineView(node: PMNode): NodeView {
  const dom = document.createElement('span')
  dom.className = 'velo-html-inline'
  dom.setAttribute('data-type', 'html_inline')
  safeRender(dom, node.attrs.value as string)
  return {
    dom,
    update: (newNode) => {
      if (newNode.type.name !== 'html_inline') return false
      if (newNode.attrs.value === node.attrs.value) return true
      return false
    },
    ignoreMutation: () => true,
    stopEvent: () => true,
  }
}

export const htmlNodeViewPluginKey = new PluginKey('htmlNodeView')

export const htmlNodeViewPlugin = new Plugin({
  key: htmlNodeViewPluginKey,
  props: {
    nodeViews: {
      html_block: (node, view, getPos) => createHtmlBlockView(node, view, getPos as () => number),
      html_inline: (node) => createHtmlInlineView(node),
    },
  },
})

// 测试用导出 —— 让单测直接调 sanitize 不用挂 view
export const __test_safeRender = safeRender