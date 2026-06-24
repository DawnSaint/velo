// TOC (Table of Contents) 渲染插件 —— 跟 MermaidDecoration 同范式：
// schema 只占槽位，真实渲染由 Decoration.widget 接管。
//
// 行为：
//  1. 扫描 doc 内所有 toc 节点，为每个生成一个 widget
//  2. widget 内用 doc.descendants 收集 headings，构建嵌套树
//  3. 渲染为 <ul>/<li> 嵌套列表，每项 click → scrollIntoView 到对应 heading
//  4. headings 变化时 widget key 变 → ProseMirror 自动重建
//  5. hover 显示 X 按钮，点击还原为 [TOC] 段落（保留撤销）

import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorState } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { trace } from '@/utils/perfTrace'

// ============================================================
//  SVG 图标(lucide 风格,跟 CodeHighlightWidget 对齐)
// ============================================================

const TRASH_SVG
  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" width="16" height="16">'
  + '<polyline points="3 6 5 6 21 6" />'
  + '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />'
  + '<line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>'

// ============================================================
//  Plugin state
// ============================================================

interface TocDecoState {
  headingsHash: string
}

function initialState(): TocDecoState {
  return { headingsHash: '' }
}

export const tocDecoKey = new PluginKey<TocDecoState>('tocDecoration')

// ============================================================
//  Heading 收集
// ============================================================

interface HeadingInfo {
  level: number
  text: string
  pos: number
  children: HeadingInfo[]
}

function collectHeadings(doc: PMNode): HeadingInfo[] {
  const headings: HeadingInfo[] = []
  doc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== 'heading') return
    const text = (node.textContent || '').trim()
    if (!text) return
    headings.push({ level: node.attrs.level as number, text, pos, children: [] })
  })
  return headings
}

function buildTree(headings: HeadingInfo[]): HeadingInfo[] {
  const root: HeadingInfo[] = []
  const stack: HeadingInfo[] = []
  for (const h of headings) {
    while (stack.length && stack[stack.length - 1].level >= h.level) {
      stack.pop()
    }
    if (stack.length === 0) root.push(h)
    else stack[stack.length - 1].children.push(h)
    stack.push(h)
  }
  return root
}

// ============================================================
//  Widget 工厂
// ============================================================

let currentView: EditorView | null = null

function makeTocWidget(
  tree: HeadingInfo[],
  doc: PMNode,
  view: EditorView | null = null,
  getPos: (() => number | undefined) | null = null,
): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'velo-toc'

  if (tree.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'velo-toc-empty'
    empty.textContent = 'No headings in this document'
    dom.appendChild(empty)
    return dom
  }

  const ul = document.createElement('ul')
  ul.className = 'velo-toc-list'
  for (const item of tree) {
    ul.appendChild(buildItem(item, doc))
  }
  dom.appendChild(ul)

  // 删除按钮 —— hover 时可见,点击后 toc 节点还原为 [TOC] 段落
  if (view && getPos) {
    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'velo-toc-delete-btn'
    deleteBtn.title = '删除目录'
    deleteBtn.contentEditable = 'false'
    deleteBtn.innerHTML = TRASH_SVG
    deleteBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    deleteBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (getPos) deleteTocNode(view, getPos)
    })
    dom.appendChild(deleteBtn)
  }

  return dom
}

function buildItem(item: HeadingInfo, doc: PMNode): HTMLElement {
  const li = document.createElement('li')
  li.className = 'velo-toc-item'
  li.style.setProperty('--toc-level', String(item.level - 1))

  const link = document.createElement('span')
  link.className = 'velo-toc-link'
  link.textContent = item.text
  link.addEventListener('click', (e) => {
    e.stopPropagation()
    scrollToHeading(item.level, item.text)
  })
  li.appendChild(link)

  if (item.children.length > 0) {
    const childUl = document.createElement('ul')
    childUl.className = 'velo-toc-list'
    for (const child of item.children) {
      childUl.appendChild(buildItem(child, doc))
    }
    li.appendChild(childUl)
  }

  return li
}

function scrollToHeading(level: number, text: string): void {
  const editor = document.querySelector('.ProseMirror') as HTMLElement | null
  if (!editor) return
  const tag = `h${level}`
  const els = editor.querySelectorAll<HTMLElement>(tag)
  for (const el of els) {
    if (el.textContent?.trim() === text) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      el.classList.add('velo-toc-highlight')
      setTimeout(() => el.classList.remove('velo-toc-highlight'), 1500)
      return
    }
  }
}

function deleteTocNode(view: EditorView, getPos: () => number | undefined): void {
  const pos = getPos()
  if (pos == null || view.isDestroyed) return
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'toc') return
  const tr = view.state.tr
  // 用段落([TOC]) 替换 toc 节点,保留撤销能力
  const para = view.state.schema.nodes.paragraph.create(null, [
    view.state.schema.text('[TOC]'),
  ])
  tr.replaceRangeWith(pos, pos + node.nodeSize, para)
  view.dispatch(tr)
}

// ============================================================
//  Build decorations
// ============================================================

function buildDecorations(state: EditorState): DecorationSet {
  const decos: Decoration[] = []
  const headings = collectHeadings(state.doc)
  const tree = buildTree(headings)
  // headings hash：变化时 widget key 变，触发重建
  const hash = headings.map(h => `${h.level}:${h.text}`).join('|')

  state.doc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== 'toc') return
    decos.push(Decoration.widget(pos, (view, getPos) => {
      return makeTocWidget(tree, state.doc, view, getPos)
    }, {
      key: `toc-widget:${pos}:${hash}`,
      block: true,
    }))
  })

  return DecorationSet.create(state.doc, decos)
}

// ============================================================
//  Plugin
// ============================================================

const tocDecoPlugin = new Plugin<TocDecoState>({
  key: tocDecoKey,
  state: {
    init: () => initialState(),
    apply(tr, prev) {
      const meta = tr.getMeta(tocDecoKey)
      if (meta && typeof meta.headingsHash === 'string') {
        return { headingsHash: meta.headingsHash }
      }
      // doc 变了 → 重新算 hash
      if (tr.docChanged) {
        const headings = collectHeadings(tr.doc)
        const hash = headings.map(h => `${h.level}:${h.text}`).join('|')
        return { headingsHash: hash }
      }
      return prev
    },
  },
  props: {
    decorations(state) {
      return trace('toc.decorations', () => buildDecorations(state))
    },
  },
  view(view: EditorView) {
    currentView = view
    return {
      destroy() {
        if (currentView === view) currentView = null
      },
    }
  },
})

export const tocDecoration = tocDecoPlugin
