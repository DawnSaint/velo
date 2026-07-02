import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'

import { triggerImageEdit } from '../image/imageEditPlugin'
import { codeXmlSvg } from '@/components/icons/widgetIcons'

export interface ImageViewOptions {
  /** 把 markdown 里的 src(可能是相对路径 / 绝对路径)转成浏览器能展示的 url。 */
  proxyDomURL: (url: string) => string
}

// 图片 NodeView:atom inline 节点,渲染 <img> + 选中态常驻悬浮 code-xml 按钮。
//
// 编辑走 imageEditPlugin 的 session(走 linkClick 同款范式,详见 image/imageEditPlugin.ts):
//   点按钮 → triggerImageEdit 把 image 节点替换成 `![alt](src "title")` 纯文本,
//   光标进去编辑,光标移出 commit(合法重建 image / 残缺保留纯文本),Escape 还原。
//   本 NodeView 不持有编辑态 —— 替换成纯文本后本 NodeView 销毁,编辑期间是普通文本
//   + Decoration,commit 重建 image 后新 NodeView 创建、按钮重新出现。
export function createImageNodeView(opts: ImageViewOptions) {
  return function imageNodeViewFactory(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView {
    const wrapper = document.createElement('span')
    wrapper.className = 'velo-image-inline'

    // 常驻悬浮按钮:CSS 按 .selected 显隐。code-xml 图标,尺寸同代码块复制按钮。
    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'image-edit-btn'
    editBtn.title = '编辑图片源码'
    editBtn.innerHTML = codeXmlSvg(12)
    // capture 阶段拦 mousedown:stopPropagation → PM 不抢 selection(NodeSelection
    //   保持,否则点按钮瞬间图片取消选中、按钮消失);preventDefault → 不让按钮抢
    //   焦点(编辑态由 plugin 设 TextSelection 接管)
    editBtn.addEventListener(
      'mousedown',
      (e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        e.preventDefault()
      },
      true,
    )
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const pos = getPos()
      if (pos === undefined || pos < 0) return
      triggerImageEdit(view, pos)
    })

    function render(currentNode: PMNode) {
      wrapper.replaceChildren()
      const src = currentNode.attrs.src as string
      if (!src) {
        // 空态:占位 + 提示。imageUploadPlugin 会在 paste/drop 时直接把
        // 落盘后的 src 写回这个节点,所以这里不提供 input UI。
        const placeholder = document.createElement('span')
        placeholder.className = 'image-edit'
        placeholder.textContent = '粘贴或拖入图片'
        wrapper.appendChild(placeholder)
        wrapper.appendChild(editBtn)
        return
      }
      const img = document.createElement('img')
      img.className = 'image-inline'
      img.src = opts.proxyDomURL(src)
      img.alt = (currentNode.attrs.alt as string) || ''
      const title = currentNode.attrs.title as string
      if (title) img.title = title
      wrapper.appendChild(img)
      wrapper.appendChild(editBtn)
    }

    render(node)

    return {
      dom: wrapper,
      update(newNode: PMNode) {
        if (newNode.type !== node.type) return false
        node = newNode
        render(newNode)
        return true
      },
      selectNode() {
        wrapper.classList.add('selected')
      },
      deselectNode() {
        wrapper.classList.remove('selected')
      },
      // image 是 atom + isolating,内部无 ProseMirror 可观察的 mutation
      ignoreMutation() {
        return true
      },
    }
  }
}
