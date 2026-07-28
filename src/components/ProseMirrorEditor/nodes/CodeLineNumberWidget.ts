// WYSIWYG code_block 行号(v0.5.11,可选开关)
//
// 每行行首插一个 Decoration.widget(<span class="velo-code-lineno">N</span>)。

import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { useEditorStore } from '@/stores/editor'
import { isCodeBlockFolded } from './FoldDecoration'
import { mermaidDecoKey } from './MermaidDecoration'
import { scanDoc } from './docScanCache'

// ============================================================
//  Plugin state
// ============================================================

interface LineNumberState {
  /** 当前是否启用行号。设置面板开关切换 → App.vue 走 setMeta 翻这个值。 */
  enabled: boolean
}

/** 工厂:每次调都从 store 同步拿当前值,factory 内不能直接用 ref(模块
 *  加载时 store 还没就绪,改在 state.init 内联调)。 */
function makeInitialState(): LineNumberState {
  let enabled = false
  try {
    const store = useEditorStore()
    if (typeof store.showCodeLineNumbers === 'boolean') {
      enabled = store.showCodeLineNumbers
    }
  }
  catch { /* pinia 未就绪 / 单元测试场景,fallback false */ }
  return { enabled }
}

export const lineNumbersKey = new PluginKey<LineNumberState>('codeLineNumbers')

// ============================================================
//  构造 decorations
// ============================================================

/** 走 `decorationSet.empty` 而不是 `null` —— enabled=false 时根本不要
 *  decoration,ProseMirror 区分"空"和"空集合"语义(后者仍走 decorations
 *  重建,前者直接短路返回)。 */
function buildDecorations(
  state: EditorState,
  enabled: boolean,
): DecorationSet {
  if (!enabled) return DecorationSet.empty
  const decos: Decoration[] = []
  const scan = scanDoc(state.doc)
  for (const { node, pos } of scan.codeBlocks) {
    const lang = (node.attrs.language as string) || ''
    // mermaid 联动展开态:收起态(显示 SVG / 源码隐藏)行号与 SVG 并排视觉割裂,
    // 跳过;展开态(源码可见,SVG 在 pre 下方)行号有用,保留 —— 与 mermaid code header
    // 同范式。mermaidDecoration 未加载时(单 plugin 测试场景)mermaidState 为
    // undefined → 视为收起态 → 跳过,维持既有"无 mermaid 插件则无行号"行为。
    if (lang === 'mermaid') {
      const mermaidState = mermaidDecoKey.getState(state)
      if (!mermaidState || !mermaidState.editNodeSet.has(pos + 1)) continue
    }
    if (isCodeBlockFolded(pos)) continue
    const blockStart = pos + 1
    const blockEnd = pos + node.nodeSize - 1
    if (blockStart >= blockEnd) continue
    const code = state.doc.textBetween(blockStart, blockEnd, '\n', '\n')
    const lines = code.split('\n')
    decos.push(
      Decoration.node(pos, pos + node.nodeSize, {
        'data-velo-gutter': 'true',
      }, { key: `code-gutter-class:${pos}:${enabled}` }),
    )
    let offset = 0
    for (let i = 0; i < lines.length; i++) {
      const lineStart = blockStart + offset
      const lineNum = i + 1
      decos.push(
        Decoration.widget(lineStart, () => {
          const span = document.createElement('span')
          span.className = 'velo-code-lineno'
          span.contentEditable = 'false'
          span.textContent = String(lineNum)
          return span
        }, {
          side: -1,
          key: `code-ln:${pos}:${lineNum}`,
          ignoreSelection: true,
        }),
      )
      offset += lines[i].length + 1 // +1 for \n
    }
  }
  return DecorationSet.create(state.doc, decos)
}

// ============================================================
//  Plugin
// ============================================================

export const codeLineNumberPlugin = new Plugin<LineNumberState>({
  key: lineNumbersKey,
  state: {
    init: makeInitialState,
    apply(tr, prev) {
      const meta = tr.getMeta(lineNumbersKey) as
        | { enabled?: boolean }
        | undefined
      if (!meta) return prev
      return {
        enabled: meta.enabled ?? prev.enabled,
      }
    },
  },
  props: {
    decorations(state) {
      const s = lineNumbersKey.getState(state)
      if (!s) return null
      return buildDecorations(state, s.enabled)
    },
  },
})
