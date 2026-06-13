import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { InputRule } from 'prosemirror-inputrules'
import type { EditorState } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'

// ============================================================
//  1. 编号核心
// ============================================================

/**
 * 扫一遍 doc 树,收集 footnote_reference / footnote_definition 的位置:
 * - refs:label → 所有 footnote_reference 的位置(供 backref 跳转)
 * - defs:label → footnote_definition 的位置(供 orphan 检测和正反向跳转)
 */
export function computeNumbering(doc: PMNode): {
  refs: Map<string, number[]> // label → ref 位置列表
  defs: Map<string, number> // label → def 位置
} {
  const refs = new Map<string, number[]>()
  const defs = new Map<string, number>()

  doc.descendants((n, pos) => {
    const name = n.type.name
    if (name !== 'footnote_reference' && name !== 'footnote_definition') return
    const label = (n.attrs.label as string) || ''
    if (name === 'footnote_reference') {
      if (!refs.has(label)) {
        refs.set(label, [])
      }
      refs.get(label)!.push(pos)
    }
    else {
      defs.set(label, pos)
    }
  })

  return { refs, defs }
}

// ============================================================
//  2. ProseMirror Plugin state(给 NodeView 拿编号用)
// ============================================================

interface FootnoteNumberState {
  refs: Map<string, number[]>
  defs: Map<string, number>
}

function makeFootnoteNumberState(state: EditorState): FootnoteNumberState {
  return computeNumbering(state.doc)
}

const footnoteNumberKey = new PluginKey<FootnoteNumberState>('footnoteNumber')

function makeFootnoteNumberStateFromDoc(doc: PMNode): FootnoteNumberState {
  return computeNumbering(doc)
}

// 是不是 macOS —— 用来决定 Cmd 还是 Ctrl 触发跳转
const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')

// ============================================================
//  3. reference NodeView
// ============================================================

function slug(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, '_') || 'fn'
}

function createFootnoteReferenceView(node: PMNode, view: EditorView, getPos: () => number) {
  const sup = document.createElement('sup')
  sup.className = 'footnote-ref-node'
  sup.contentEditable = 'true'
  sup.spellcheck = false

  function currentLabel(): string {
    return (node.attrs.label as string) || ''
  }

  function isOrphan(): boolean {
    const defs = footnoteNumberKey.getState(view.state)?.defs
    return !defs?.has(currentLabel())
  }

  function showDisplay() {
    // 编辑中(光标在 sup 里)不同步文本,避免打断用户键入
    if (sup === document.activeElement) return
    sup.textContent = currentLabel() || '?'
    sup.classList.toggle('footnote-orphan', isOrphan())
  }

  // mousedown:capture 阶段(与 mermaid/math 一致)
  // 理由:ProseMirror 的 mousedown 是 bubble 阶段挂 view.dom 上,如果只用 bubble
  // 阶段 stopPropagation,某些浏览器对 contentEditable 元素的默认行为(contentEditable
  // focus、IME、辅助技术)会先于 ProseMirror 触发,让 ProseMirror 后续在 mouseup
  // 调 selectClickedNode(event.ctrlKey=true) 抢走 selection。
  // capture 阶段跑在所有 bubble 之前,先把事件路锁死。
  //
  // - 带修饰键(Cmd/Ctrl):preventDefault 阻止 focus/contentEditable 默认行为 +
  //   stopPropagation 拦截
  // - 无修饰键:只 stopPropagation,保留默认 focus,让用户能点击 sup 进入编辑态改 label
  sup.addEventListener('mousedown', (e: MouseEvent) => {
    if (IS_MAC ? e.metaKey : e.ctrlKey) {
      e.preventDefault()
    }
    e.stopPropagation()
  }, true)

  // click:Cmd/Ctrl + 单击 → 跳转到 definition
  // 注:这里无条件 preventDefault 是兜底 —— 万一 capture 阶段 mousedown 的
  // preventDefault 因浏览器怪异行为没生效(比如某些扩展吞了事件、IME 介入),
  // click 这里再挡一次,避免 ProseMirror 在 mouseup 链上抢 selection。
  sup.addEventListener('click', (e: MouseEvent) => {
    if (!(IS_MAC ? e.metaKey : e.ctrlKey)) return
    e.preventDefault()
    e.stopPropagation()
    const label = currentLabel()
    const defPos = footnoteNumberKey.getState(view.state)?.defs.get(label)
    if (defPos == null) {
      sup.classList.add('footnote-flash')
      setTimeout(() => sup.classList.remove('footnote-flash'), 400)
      return
    }
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, defPos + 1))
        .scrollIntoView(),
    )
  })

  // input:每个键击同步到 node.label
  sup.addEventListener('input', () => {
    const newLabel = (sup.textContent || '').trim()
    const pos = getPos()
    if (pos == null || pos < 0) return
    if (newLabel !== currentLabel()) {
      view.dispatch(view.state.tr.setNodeAttribute(pos, 'label', newLabel))
    }
  })

  // Enter / Esc 退出编辑(回到段落正文里)
  sup.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault()
      sup.blur()
    }
  })

  showDisplay()

  return {
    dom: sup,
    update(newNode: PMNode) {
      if (newNode.type !== node.type) return false
      const oldLabel = node.attrs.label as string
      const newLabel = newNode.attrs.label as string
      node = newNode
      if (oldLabel !== newLabel) showDisplay()
      return true
    },
    destroy() { /* nothing */ },
    ignoreMutation() { return true },
  }
}

// ============================================================
//  4. definition NodeView
// ============================================================

function createFootnoteDefinitionView(node: PMNode, view: EditorView, getPos: () => number) {
  const root = document.createElement('dl')
  root.className = 'footnote-definition'

  const labelSpan = document.createElement('div')
  labelSpan.className = 'footnote-label'

  const body = document.createElement('div')
  body.className = 'footnote-content'

  const backref = document.createElement('a')
  backref.className = 'footnote-backref'
  backref.textContent = '↩'
  backref.draggable = false

  root.appendChild(labelSpan)
  root.appendChild(body)
  root.appendChild(backref)

  function currentLabel(): string {
    return (node.attrs.label as string) || ''
  }

  function commitLabel() {
    const newLabel = (labelSpan.textContent || '').trim()
    const pos = getPos()
    if (pos == null || pos < 0) return
    if (newLabel !== currentLabel()) {
      view.dispatch(view.state.tr.setNodeAttribute(pos, 'label', newLabel))
    }
  }

  function showDisplay() {
    // 编辑中(光标在 labelSpan 里)不同步文本
    if (labelSpan === document.activeElement) return

    const label = currentLabel()
    const numState = footnoteNumberKey.getState(view.state)

    root.id = `velo-fn-${slug(label)}`
    labelSpan.textContent = label

    // 回链:回第一条 reference
    const firstRef = numState?.refs.get(label)?.[0]
    if (firstRef != null) {
      backref.href = `#velo-fnref-${slug(label)}`
      backref.classList.remove('footnote-backref-disabled')
      backref.onclick = (e) => {
        e.preventDefault()
        e.stopPropagation()
        view.dispatch(
          view.state.tr
            .setSelection(TextSelection.create(view.state.doc, firstRef))
            .scrollIntoView(),
        )
      }
    }
    else {
      backref.removeAttribute('href')
      backref.classList.add('footnote-backref-disabled')
      backref.onclick = (e) => { e.preventDefault(); e.stopPropagation() }
    }
  }

  // input:每个键击同步到 node.label
  labelSpan.addEventListener('input', () => {
    commitLabel()
  })
  // Enter / Esc 退出编辑
  labelSpan.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault()
      labelSpan.blur()
    }
  })

  // backref 的 mousedown / click:capture 阶段(与 mermaid/math 一致)
  // 理由同 sup —— 比 ProseMirror bubble mousedown 先跑,提前 preventDefault
  // 阻止 <a> 默认导航 + 阻止 ProseMirror 在 mouseup 调 selectClickedLeaf
  // 用 NodeSelection 抢走我们 setSelection 的目标位置。
  // click 这里再加一次 preventDefault 兜底,跟 onclick property handler 行为对齐。
  backref.addEventListener('mousedown', (e: Event) => {
    e.stopPropagation()
    e.preventDefault()
  }, true)
  backref.addEventListener('click', (e: Event) => {
    e.stopPropagation()
    e.preventDefault()
  })

  showDisplay()

  return {
    dom: root,
    contentDOM: body,
    update(newNode: PMNode) {
      if (newNode.type !== node.type) return false
      const oldLabel = node.attrs.label as string
      const newLabel = newNode.attrs.label as string
      node = newNode
      if (oldLabel !== newLabel) showDisplay()
      // 编号可能因外部交易变化(其它 ref 增删),每次都重画
      showDisplay()
      return true
    },
    destroy() {
      backref.onclick = null
    },
  }
}

// ============================================================
//  5. Plugin 装配
// ============================================================

// 抽成模块级常量,raw ProseMirror Plugin 直接导出,
// 单元测试也能拿到 plugin 实例真实地走 NodeView 路径。
const footnoteNumberPlugin = new Plugin({
  key: footnoteNumberKey,
  state: {
    init: (_, state) => makeFootnoteNumberState(state),
    apply: (tr, _old) => {
      if (tr.docChanged) return makeFootnoteNumberStateFromDoc(tr.doc)
      return _old
    },
  },
  props: {
    nodeViews: {
      footnote_reference: (node, view, getPos) =>
        createFootnoteReferenceView(node, view, getPos as () => number),
      footnote_definition: (node, view, getPos) =>
        createFootnoteDefinitionView(node, view, getPos as () => number),
    },
  },
})

const footnoteEditPlugin = footnoteNumberPlugin

// ============================================================
//  6. 输入规则:输入 `[^id]` → 自动转 footnote_reference
// ============================================================
//
//  @milkdown/preset-gfm 自带 schema 但不带 inputRule,用户手动敲 `[^id]`
//  不会自动转成节点。这里补一条:在 paragraph/heading 等 inline 容器里,
//  文本末尾出现 `[^id]` 时,光标紧跟 `]` 触发,替换为 footnote_reference 节点。
//
//  注意:
//  - 用 $ 锚定到光标位置(ProseMirror inputRule 的标准做法)
//  - id 不允许含空白 / `]`
//  - 不与已有 emphasis/strikethrough 冲突(它们的开头是 `*_~`)

export const footnoteReferenceInputRule = new InputRule(
  /\[\^([^\s\]]+)\]$/,
  (state, match, start, end) => {
    const $start = state.doc.resolve(start)
    if ($start.parentOffset === 0) return null
    const label = match[1]
    if (!label) return null
    const type = state.schema.nodes.footnote_reference
    if (!type) return null
    return state.tr.replaceRangeWith(start, end, type.create({ label }))
  },
)



export { footnoteEditPlugin, footnoteNumberPlugin }
