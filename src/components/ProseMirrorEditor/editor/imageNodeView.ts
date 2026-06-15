import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'

export interface ImageViewOptions {
  /** 把 markdown 里的 src(可能是相对路径 / 绝对路径)转成浏览器能展示的 url。 */
  proxyDomURL: (url: string) => string
}

export function createImageNodeView(opts: ImageViewOptions) {
  return function imageNodeViewFactory(
    node: PMNode,
    _view: EditorView,
    _getPos: () => number | undefined,
  ): NodeView {
    const wrapper = document.createElement('span')
    wrapper.className = 'velo-image-inline'

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
        return
      }
      const img = document.createElement('img')
      img.className = 'image-inline'
      img.src = opts.proxyDomURL(src)
      img.alt = (currentNode.attrs.alt as string) || ''
      const title = currentNode.attrs.title as string
      if (title) img.title = title
      wrapper.appendChild(img)
    }

    render(node)

    return {
      dom: wrapper,
      update(newNode) {
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
      ignoreMutation() { return true },
    }
  }
}
