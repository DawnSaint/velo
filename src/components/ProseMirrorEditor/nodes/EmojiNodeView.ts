import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import { get as emojiGet, has as emojiHas } from 'node-emoji'

import { createSelectionSync } from './selectionSync'

// emoji NodeView:inline atom 节点,查 node-emoji 表把 shortcode 转 Unicode emoji
// char 渲染到 <span>。
//
// 与 image / hr NodeView 同范式:
//   - selectNode / deselectNode 切换 .selected class,SCSS 用 &.selected 画 outline
//   - inline atom 天然 inert,无需 handleKeyDown 拦截
//   - ignoreMutation:emoji span 无内部可观察 mutation,返回 true 隔离 PM DOMObserver
//
// emoji 无编辑按钮 / 源码编辑 session —— 比 image 更简单。用户要换 emoji 只需
// 删除后重新键入短码(syntax 自动转换)。
export function createEmojiNodeView() {
  return function emojiNodeViewFactory(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView {
    const dom = document.createElement('span')
    dom.className = 'velo-emoji'
    dom.contentEditable = 'false'

    function render(currentNode: PMNode) {
      const shortcode = currentNode.attrs.shortcode as string
      dom.dataset.shortcode = shortcode
      // 查 node-emoji 表;_shortcode 不在表中时回退显示短码文本本身
      if (shortcode && emojiHas(shortcode)) {
        dom.textContent = emojiGet(shortcode) ?? shortcode
      } else {
        dom.textContent = `:${shortcode}:`
      }
    }

    render(node)

    const selectionSync = createSelectionSync({
      dom,
      view,
      getPos,
      getNode: () => node,
    })

    return {
      dom,
      update(newNode: PMNode) {
        if (newNode.type.name !== 'emoji') return false
        node = newNode
        render(newNode)
        return true
      },
      selectNode() {
        selectionSync.syncSelected()
      },
      deselectNode() {
        selectionSync.syncSelected()
      },
      ignoreMutation() {
        return true
      },
      destroy() {
        selectionSync.destroy()
      },
    }
  }
}
