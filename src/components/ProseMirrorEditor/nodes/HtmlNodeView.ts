// HTML 透传 + DOMPurify sanitize NodeView。
//
// schema 给 html_block / html_inline 两个 atom 节点各占一槽,attrs.value 存原始
// HTML 字符串。本文件提供 NodeView 把 value 渲染到真实 DOM。
//
// 设计要点:
// - **atom = true**:节点不可编辑,内容来自 attrs.value。块级 HTML 走右上角按钮
//   切换源码编辑:点击按钮 → dispatch 把 html_block 替换成 code_block { language:
//   'html' }(普通可编辑节点),用户在 code_block 里正常编辑;光标移出 code_block
//   时 htmlSourceEdit 插件自动 commit(把 code_block 替换回 html_block)。行内 HTML
//   走点击展开源码(htmlSourceEdit.ts,同 imageEdit 范式)。
// - **不用 NodeView 内 textarea(math_block 范式)**:PM 对 atom 节点自动设
//   contentEditable=false,textarea 嵌在 contentEditable=false 的 dom 内,点击
//   textarea 时浏览器原生 contenteditable 行为会抢焦点 → textarea blur → 误退出
//   编辑。改用 code_block(普通可编辑 PM 节点,有 contentDOM)彻底绕开此问题。
// - **DOMPurify sanitize**:CSP 已开 unsafe-inline + unsafe-eval,浏览器不挡 script,
//   必须 JS 端清洗。FORBID_TAGS / FORBID_ATTR 显式列出常见危险项,即使 dompurify
//   后续放宽默认也不会被绕过。
// - **stopEvent / ignoreMutation**:atom 节点要把内部 DOM 突变 / 事件与 ProseMirror
//   隔离,否则用户在 details 里点 summary 折叠会被 ProseMirror 当 selection 操作。
// - **img src 代理**:sanitize 后扫描内部 <img>,src 走 proxyDomURL(与 image NodeView
//   同款 resolveImageSrc → Tauri asset:// 代理),让 HTML 块内的相对 / 绝对路径图片
//   在编辑器内正确显示。只接管渲染层 —— HTML 源码与 round-trip 都不变。
//
// 不在这里:
// - schema 节点定义(在 editor/schema.ts)
// - markdownIO 双向(在 editor/markdownIO.ts)
// - 块级源码编辑 session 管理(在 plugins/htmlSourceEdit.ts)

import DOMPurify from 'dompurify'
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { EditorView, NodeView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { codeXmlSvg } from '@/components/icons/widgetIcons'
import { SKIP_CONTENT_EMIT } from '../editor/transactionMeta'
import { htmlSourceEditKey } from '../plugins/htmlSourceEdit'

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

/** 把 HTML 块内的 <img> src 转成浏览器可展示 url —— 与 image NodeView 同款
 *  resolveImageSrc(Tauri asset:// 代理)。sanitize 后再代理:DOMPurify 已过滤
 *  危险 URI,这里只把本地相对 / 绝对路径转成 asset:// 协议。 */
function proxyImageSrcs(target: HTMLElement, proxyDomURL: (url: string) => string): void {
  target.querySelectorAll<HTMLImageElement>('img[src]').forEach((img) => {
    const original = img.getAttribute('src')
    if (original) img.src = proxyDomURL(original)
  })
}

/** 用 DOMPurify 清洗 HTML 字符串后写到目标元素;有 proxyDomURL 时代理内部 img src。 */
function safeRender(
  target: HTMLElement,
  raw: string,
  proxyDomURL?: (url: string) => string,
): void {
  // dompurify 默认返回 string;ts 类型有几种重载,这里强制为 string
  target.innerHTML = DOMPurify.sanitize(raw, PURIFY_CONFIG) as unknown as string
  if (proxyDomURL) proxyImageSrcs(target, proxyDomURL)
}

/** 块级 HTML NodeView。dom = <div class="velo-html-block">,内容 sanitize 后写入。
 *  右上角 hover 显现 code-xml 按钮,点击 → dispatch 把 html_block 替换成 code_block
 *  进入源码编辑(由 htmlSourceEdit 插件管理 session,光标移出时自动 commit)。 */
function createHtmlBlockView(
  node: PMNode,
  view: EditorView,
  getPos: () => number,
  proxyDomURL: (url: string) => string,
): NodeView {
  const dom = document.createElement('div')
  dom.className = 'velo-html-block'
  dom.setAttribute('data-type', 'html_block')

  // 源码切换按钮(code-xml 图标,同 image 编辑按钮),hover 显现。capture 阶段
  // stopPropagation + preventDefault:不让 PM 抢 selection / 不让按钮抢焦点。
  const toggleBtn = document.createElement('button')
  toggleBtn.type = 'button'
  toggleBtn.className = 'velo-icon-btn velo-icon-btn--hidden html-source-toggle-btn'
  toggleBtn.title = '编辑 HTML 源码'
  toggleBtn.innerHTML = codeXmlSvg(12)
  toggleBtn.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
  }, true)
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    startBlockEdit()
  })

  function showDisplay() {
    dom.innerHTML = ''
    safeRender(dom, node.attrs.value as string, proxyDomURL)
    if (view.editable) dom.appendChild(toggleBtn)
  }

  /** 把 html_block 替换成 code_block,由 htmlSourceEdit 插件接管 session。
   *  code_block 是普通可编辑 PM 节点(有 contentDOM),用户可正常点击/编辑,
   *  不存在 textarea 在 contentEditable=false 容器内的焦点问题。 */
  function startBlockEdit() {
    if (!view.editable) return
    const pos = getPos()
    if (pos < 0) return
    const source = node.attrs.value || ''
    const codeBlock = view.state.schema.nodes.code_block.create(
      { language: 'html' },
      source ? view.state.schema.text(source) : [],
    )
    let tr = view.state.tr.replaceWith(pos, pos + node.nodeSize, codeBlock)
    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)))
    // 瞬时视图切换(html_block → code_block),不是内容编辑 —— 跳过内容回写
    tr = tr.setMeta(SKIP_CONTENT_EMIT, true)
    tr = tr.setMeta(htmlSourceEditKey, {
      type: 'startBlock' as const,
      session: { blockPos: pos, originalSource: source },
    })
    view.dispatch(tr)
  }

  showDisplay()

  return {
    dom,
    update: (newNode) => {
      if (newNode.type.name !== 'html_block') return false
      const valueChanged = newNode.attrs.value !== node.attrs.value
      node = newNode
      if (valueChanged) showDisplay()
      return true
    },
    selectNode() { dom.classList.add('selected') },
    deselectNode() { dom.classList.remove('selected') },
    // 内部 DOM 变(details 折叠)不让 ProseMirror 知道
    ignoreMutation: () => true,
    // 内部事件不让 ProseMirror 抢(用户点 summary 时正常折叠)
    stopEvent: () => true,
    destroy() {},
  }
}

/** 行内 HTML NodeView。dom = <span class="velo-html-inline">。 */
function createHtmlInlineView(
  node: PMNode,
  proxyDomURL: (url: string) => string,
): NodeView {
  const dom = document.createElement('span')
  dom.className = 'velo-html-inline'
  dom.setAttribute('data-type', 'html_inline')
  safeRender(dom, node.attrs.value as string, proxyDomURL)
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

export interface HtmlNodeViewOptions {
  /** 把 markdown 里的 img src(可能是相对 / 绝对路径)转成浏览器能展示的 url。
   *  与 image NodeView 同款 resolveImageSrc(Tauri asset:// 代理)。 */
  proxyDomURL: (url: string) => string
}

const htmlNodeViewPluginKey = new PluginKey('htmlNodeView')

export function createHtmlNodeViewPlugin(opts: HtmlNodeViewOptions): Plugin {
  return new Plugin({
    key: htmlNodeViewPluginKey,
    props: {
      nodeViews: {
        html_block: (node, view, getPos) => createHtmlBlockView(node, view, getPos as () => number, opts.proxyDomURL),
        html_inline: (node) => createHtmlInlineView(node, opts.proxyDomURL),
      },
    },
  })
}

// 测试用导出 —— 让单测直接调 sanitize 不用挂 view
export const __test_safeRender = safeRender
