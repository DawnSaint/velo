import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'

// hr NodeView:block(atom) 节点包裹在 <div class="velo-hr"> 内,提供可选中视觉态。
//
// 与 image NodeView 同范式):
//   - selectNode / deselectNode 切换 .selected class,SCSS 用 &.selected hr 画 outline
//   - block atom 天然 inert(选中后键入不进 hr),无需 handleKeyDown 拦截(同 math_block)
//   - ignoreMutation:hr 无内部可观察 mutation,返回 true 隔离 PM DOMObserver
//
// hr 无 src/alt/title 属性,无需编辑按钮 / 源码编辑 session —— 比 image 简单。
export function createHrNodeView() {
  return function hrNodeViewFactory(
    _node: PMNode,
    _view: EditorView,
    _getPos: () => number | undefined,
  ): NodeView {
    const dom = document.createElement('div')
    dom.className = 'velo-hr'
    dom.contentEditable = 'false'
    const hr = document.createElement('hr')
    dom.appendChild(hr)

    return {
      dom,
      update(newNode: PMNode) {
        if (newNode.type.name !== 'hr') return false
        return true
      },
      selectNode() {
        dom.classList.add('selected')
      },
      deselectNode() {
        dom.classList.remove('selected')
      },
      ignoreMutation() {
        return true
      },
    }
  }
}
