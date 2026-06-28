import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
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
    // footnote_reference 的 label 是 text content(schema 里 content:'text*'),
    // footnote_definition 的 label 是 attrs.label(labelSpan 编辑写回 attrs)
    const label = name === 'footnote_reference'
      ? (n.textContent || '')
      : ((n.attrs.label as string) || '')
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

function createFootnoteReferenceView(node: PMNode, view: EditorView, _getPos: () => number) {
  const sup = document.createElement('sup')
  sup.className = 'footnote-ref-node'

  function currentLabel(): string {
    // label 是 text content(schema 里 content:'text*'),不是 attrs
    return node.textContent || ''
  }

  function isOrphan(): boolean {
    const defs = footnoteNumberKey.getState(view.state)?.defs
    return !defs?.has(currentLabel())
  }

  function updateStyle() {
    sup.classList.toggle('footnote-orphan', isOrphan())
  }

  // Cmd/Ctrl + mousedown:capture 阶段拦,防 PM selectClickedNode 抢成 NodeSelection。
  // 普通点击不拦 —— reference 不是 atom(content:'text*'),PM 把 TextSelection
  // 放进 sup 内的 text,用户逐字符编辑 label(Typora 式,无 input / 无 contentEditable
  // 嵌套)。之前的 atom + contentEditable sup 方案在 PM 的 contentEditable(view.dom)
  // 内拿不到独立 focus,selection 实际停在 sup 外,Backspace 删的是 sup 前的内容。
  sup.addEventListener('mousedown', (e: MouseEvent) => {
    if (IS_MAC ? e.metaKey : e.ctrlKey) {
      e.preventDefault()
      e.stopPropagation()
    }
  }, true)

  // Cmd/Ctrl + click → 跳转到 definition
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

  updateStyle()

  return {
    dom: sup,
    // contentDOM = sup:PM 接管 sup 内的 text 编辑。selection 自然进入 sup,
    // Backspace/Delete 由 PM 按 sup 内的 selection 处理(不再"删错位置")。
    // 不需要 contentEditable / input 事件 / keydown 隔离 —— PM 全部接管。
    contentDOM: sup,
    update(newNode: PMNode) {
      if (newNode.type !== node.type) return false
      node = newNode
      updateStyle()
      return true
    },
    destroy() { /* nothing */ },
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
//  历史:输入规则 `[^id]` → footnote_reference
//
//  v0.4.0 ~ v0.4.1 这里有 footnoteReferenceInputRule;v0.4.1.x 起迁到
//  syntax/inline/footnoteRef.ts,由 syntaxAutoFormatPlugin 调度。
//  关键改进:不再依赖"键入紧贴匹配末尾",先输 `]` 再前面补 `[^xxx` 也能触发。
// ============================================================



export { footnoteEditPlugin, footnoteNumberPlugin }
