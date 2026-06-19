import { Plugin, PluginKey } from 'prosemirror-state'

/**
 * 任务列表 NodeView
 *
 *   - null  = 普通列表项
 *   - true  = `[x]` 已勾选
 *   - false = `[ ]` 未勾选
 *
 * schema 的 toDOM 只输出 `<li data-item-type="task" data-checked="...">`,
 * 没有可点的 checkbox。这里统一接管 `list_item` 的渲染:
 *   - 普通项:沿用默认结构,children 直接渲染进 `<li>`
 *   - 任务项:在 li 最前面塞一个 `<span class="task-checkbox">`,children
 *     改渲到 `<li>` 内的 `<div class="task-content">` 里
 *
 * 关键点:
 * - checkbox 是真实 DOM,event.target 清晰
 * - `contenteditable="false"` 防止 ProseMirror 把光标放到 checkbox 上
 * - `mousedown` preventDefault 阻止 ProseMirror 在 click 前先把光标塞进
 *   li 内(否则 toggle 后再编辑光标会跳到奇怪位置)
 * - 切换走 `tr.setNodeAttribute(pos, 'checked', !current)`,自动进入
 *   history 栈,Ctrl+Z 可撤销
 */
function createListItemView(node: any, view: any, getPos: () => number) {
  const isTask = node.attrs.checked != null

  // ========== 普通列表项:透传结构 ==========
  if (!isTask) {
    const li = document.createElement('li')
    return {
      dom: li,
      contentDOM: li, // children 直接渲进 li
      update(newNode: any) {
        if (newNode.type !== node.type) return false
        // 关键:checked 从 null 升级到 true/false(`- ` 后续追打 `[ ] ` / `[x] `
        // 走 bulletListSyntax 的两段式分支)时,DOM 结构必须从「裸 li」切到
        // 「li > checkbox + task-content」。这里返回 false,让 ProseMirror 销毁
        // 当前 NodeView 并重新调用工厂函数走到下面的「任务项」分支。否则
        // attrs.checked 虽已变更,视觉上仍是普通项,看似自动转换没生效。
        if (newNode.attrs.checked != null) return false
        node = newNode
        return true
      },
    }
  }

  // ========== 任务项:注入 checkbox ==========
  const li = document.createElement('li')
  li.setAttribute('data-item-type', 'task')
  li.setAttribute('data-checked', String(node.attrs.checked))
  li.setAttribute('data-list-type', node.attrs.listType ?? 'bullet')
  li.setAttribute('data-spread', String(node.attrs.spread ?? true))
  if (node.attrs.label != null) li.setAttribute('data-label', node.attrs.label)

  const checkbox = document.createElement('span')
  checkbox.className = 'task-checkbox'
  checkbox.contentEditable = 'false'
  li.appendChild(checkbox)

  const content = document.createElement('div')
  content.className = 'task-content'
  li.appendChild(content)

  checkbox.addEventListener('mousedown', (e: Event) => {
    e.preventDefault()
  })
  checkbox.addEventListener('click', (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
    const pos = getPos()
    if (pos == null || pos < 0) return
    const tr = view.state.tr.setNodeAttribute(pos, 'checked', !node.attrs.checked)
    view.dispatch(tr)
  })

  return {
    dom: li,
    contentDOM: content,
    update(newNode: any) {
      if (newNode.type !== node.type) return false
      const next = newNode.attrs.checked
      if (next == null) return false
      li.setAttribute('data-checked', String(next))
      node = newNode
      return true
    },
  }
}

export const taskListPlugin = new Plugin({
  key: new PluginKey('taskList'),
  props: {
    nodeViews: {
      list_item: (node, view, getPos) =>
        createListItemView(node, view, getPos as () => number),
    },
  },
})
