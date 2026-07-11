// TOC (Table of Contents) 渲染插件 —— 跟 MermaidDecoration 同范式：
// schema 只占槽位，真实渲染由 Decoration.widget 接管。
//
// 行为：
//  1. 扫描 doc 内所有 toc 节点，为每个生成一个 widget
//  2. widget 内用 doc.descendants 收集 headings，构建嵌套树
//  3. 渲染为 <ul>/<li> 嵌套列表，每项 click → scrollIntoView 到对应 heading
//  4. headings 变化时 widget key 变 → ProseMirror 自动重建
//  5. hover 显示 X 按钮，点击删除整个 toc 节点

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorState } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { trashSvg } from '@/components/icons/widgetIcons'
import { isTocFolded } from './FoldDecoration'

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

  // 删除按钮 —— hover 时可见,点击后删除整个 toc 节点
  if (view && getPos) {
    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'velo-icon-btn velo-icon-btn--danger velo-icon-btn--hidden velo-toc-delete-btn'
    deleteBtn.title = '删除目录'
    deleteBtn.contentEditable = 'false'
    deleteBtn.innerHTML = trashSvg(16)
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
  tr.delete(pos, pos + node.nodeSize)
  // 显式设置光标到删除位置附近的合法 text 位置。删除 block 节点后,
  // 选区映射可能落到块边界(两个 block 之间),ProseMirror 无法在该位置
  // 创建合法 TextSelection → 回退到 Selection.atStart(doc)(文档开头)。
  // 这不仅影响删除后的光标,还会导致 Ctrl+Z undo 后光标仍停在文档开头
  // (history 存的是失效后的 atStart 选区,逆向映射后仍在开头)。
  const $pos = tr.doc.resolve(Math.min(pos, tr.doc.content.size))
  tr.setSelection(TextSelection.near($pos))
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
    // fold 范围内的 toc:widget 是 block-level sibling,不受 velo-folded
    // display:none 影响(同 mermaid / codeBlockHeader 范式),跳过创建,
    // 展开 → isTocFolded 翻 false → widget 重建 → TOC 回归。
    if (isTocFolded(pos)) return
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
      return buildDecorations(state)
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
