import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import { get as emojiGet, has as emojiHas } from 'node-emoji'

// emoji NodeView:inline atom 节点,查 node-emoji 表把 shortcode 转 Unicode emoji
// char 渲染到 <span>。
//
// 无选中态外框线 —— 选中/光标靠近时由 emojiSourceEditPlugin 把 emoji 替换为
// `:shortcode:` 源码文本(Obsidian Live Preview 风格),不需要 NodeView 画 outline。
//
//   - inline atom 天然 inert,无需 handleKeyDown 拦截
//   - ignoreMutation:emoji span 无内部可观察 mutation,返回 true 隔离 PM DOMObserver
//   - 无 selectNode / deselectNode / selectionSync —— 不需要选中态视觉
export function createEmojiNodeView() {
  return function emojiNodeViewFactory(
    node: PMNode,
    _view: EditorView,
    _getPos: () => number | undefined,
  ): NodeView {
    const dom = document.createElement('span')
    dom.className = 'velo-emoji'
    dom.contentEditable = 'false'

    function render(currentNode: PMNode) {
      const shortcode = currentNode.attrs.shortcode as string
      dom.dataset.shortcode = shortcode
      // 查 node-emoji 表;shortcode 不在表中时回退显示短码文本本身
      if (shortcode && emojiHas(shortcode)) {
        dom.textContent = emojiGet(shortcode) ?? shortcode
      } else {
        dom.textContent = `:${shortcode}:`
      }
    }

    render(node)

    return {
      dom,
      update(newNode: PMNode) {
        if (newNode.type.name !== 'emoji') return false
        node = newNode
        render(newNode)
        return true
      },
      ignoreMutation() {
        return true
      },
    }
  }
}
