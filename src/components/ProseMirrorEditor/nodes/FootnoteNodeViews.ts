import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { scanDoc } from './docScanCache'

// ============================================================
//  1. 编号核心
// ============================================================

/**
 * 收集 footnote_reference / footnote_definition 的位置:
 * - refs:label → 所有 footnote_reference 的位置(供 backref 跳转)
 * - defs:label → footnote_definition 的位置(供 orphan 检测和正反向跳转)
 *
 * C2: 改用 scanDoc 缓存替代独立 doc.descendants() 遍历。
 * footnoteEditPlugin.init 与 decoration 插件共享同一次遍历,大文档打开时
 * 省去一次全量 doc 扫描。
 */
export function computeNumbering(doc: PMNode): {
  refs: Map<string, number[]> // label → ref 位置列表
  defs: Map<string, number> // label → def 位置
} {
  const refs = new Map<string, number[]>()
  const defs = new Map<string, number>()

  const scan = scanDoc(doc)
  // footnote_reference 的 label 是 text content(schema 里 content:'text*');
  // footnote_definition 的 label 是 firstChild(footnote_label 节点)的 text content
  // —— schema 不再用 attrs.label(label 是 PM 节点 text content,与 reference 同范式)。
  for (const { node, pos } of scan.footnoteReferences) {
    const label = node.textContent || ''
    if (!refs.has(label)) refs.set(label, [])
    refs.get(label)!.push(pos)
  }
  for (const { node, pos } of scan.footnoteDefinitions) {
    const label = (node.firstChild?.textContent ?? '') || ''
    defs.set(label, pos)
  }

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
    // 跳到 def 内 footnote_label 文本起始位置:defPos(def open) + 1(footnote_label open)
    // + 1(text node open) = defPos+2 落在 inline text content 起点,
    // TextSelection 要求 endpoint 在 inline content 节点内。
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, defPos + 2))
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

// label 现在是 footnote_label 节点(text content)而非 NodeView 自管 DOM。
// dom = <dl>,contentDOM = <div.body>,PM 渲染 [footnote_label, paragraph, ...]
// 进 body 内部 —— label 节点自带 <dt> 标签与 .footnote-label 视觉 class(走
// _footnote.scss 选择器),不再需要 labelSpan 自管。
// 之前方案(label 在 attrs.label + NodeView 自造 <div.footnote-label> 不在
// contentDOM 内)导致 PM 看不到 labelSpan,点击时 PM 默认推进光标到最近的
// content = 描述段前,Backspace/Delete 删错位置。改后与 footnote_reference
// 同范式(都是 content:'text*' 节点由 PM 接管文本编辑)。
function createFootnoteDefinitionView(node: PMNode, view: EditorView, _getPos: () => number) {
  const root = document.createElement('dl')
  root.className = 'footnote-definition'

  const body = document.createElement('div')
  body.className = 'footnote-content'

  const backref = document.createElement('a')
  backref.className = 'footnote-backref'
  backref.textContent = '↩'
  backref.draggable = false

  root.appendChild(body)
  root.appendChild(backref)

  function currentLabel(): string {
    // label 住在 firstChild(footnote_label 节点)text content 内
    return node.firstChild?.textContent ?? ''
  }

  function showDisplay() {
    const label = currentLabel()
    const numState = footnoteNumberKey.getState(view.state)

    root.id = `velo-fn-${slug(label)}`
    // data-label 由 schema toDOM 从 firstChild.textContent 算出,这里只更新 root.id

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
      const oldLabel = node.firstChild?.textContent ?? ''
      const newLabel = newNode.firstChild?.textContent ?? ''
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

export { footnoteEditPlugin, footnoteNumberPlugin }
