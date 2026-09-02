// WYSIWYG code_block 行号 —— per-block 粒度开关。
//
// 范式对齐 CodeWrapPlugin:用 Set<number> 跟踪已开启行号的 code_block node pos。
// 默认空集 = 全部关闭(与旧全局开关默认 false 一致)。用户在 header 行号按钮
// toggle 某个块 → 加入/移出 set → PM 重建该块的 gutter widget。
//
// 不持久化:行号是临时视图偏好,切文件 / 重开 = 重置(与 wrap 同范式)。
// 不进 schema / 不进 markdown 序列化。

import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { isCodeBlockFolded, foldKey } from './FoldDecoration'
import { mermaidDecoKey } from './MermaidDecoration'
import { scanDoc } from './docScanCache'
import { getViewport, isInViewport, viewportKey } from './viewportPlugin'

// ============================================================
//  Plugin state
// ============================================================

interface LineNumberState {
  /** 已开启行号的 code_block node pos 集合。空集 = 全部关闭(默认)。 */
  enabledSet: Set<number>
  /** 缓存的 DecorationSet;null 表示需要全量重建。 */
  decoSet: DecorationSet | null
}

function initialState(): LineNumberState {
  return { enabledSet: new Set(), decoSet: null }
}

export const lineNumbersKey = new PluginKey<LineNumberState>('codeLineNumbers')

// ============================================================
//  Cross-plugin 通信:module-level set
// ============================================================
//
// 与 CodeWrapPlugin 的 unwrappedCodeBlockPosSet 同范式:CodeHighlightWidget
// 的 header 行号按钮需要读行号状态决定按钮 active 态,module-level set
// 在 apply 阶段同步更新(早于 decorations),保证 header 看到最新值。
let lineNumberEnabledPosSet: Set<number> = new Set()

/** 公开:判断本 code_block 是否已开启行号(默认 false)。 */
export function isCodeBlockLineNumbersEnabled(codeBlockPos: number): boolean {
  return lineNumberEnabledPosSet.has(codeBlockPos)
}

/** 同步 module-level set:从 doc 实际 code_block 节点校验,过滤已删除的 pos。 */
function syncModuleSet(doc: PMNode, set: Set<number>): void {
  const next = new Set<number>()
  for (const { pos } of scanDoc(doc).codeBlocks) {
    if (set.has(pos)) {
      next.add(pos)
    }
  }
  lineNumberEnabledPosSet = next
}

// ============================================================
//  构造 decorations
// ============================================================

/** 为单个 code_block 构建行号 widget decoration。 */
function buildLineDecosForBlock(
  doc: PMNode,
  node: PMNode,
  pos: number,
): Decoration[] {
  const decos: Decoration[] = []
  const blockStart = pos + 1
  const blockEnd = pos + node.nodeSize - 1
  if (blockStart >= blockEnd) return decos
  const code = doc.textBetween(blockStart, blockEnd, '\n', '\n')
  const lines = code.split('\n')
  decos.push(
    Decoration.node(pos, pos + node.nodeSize, {
      'data-velo-gutter': 'true',
    }, { key: `code-gutter-class:${pos}` }),
  )
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const lineStart = blockStart + offset
    const lineNum = i + 1
    decos.push(
      Decoration.widget(lineStart, () => {
        // 外层零宽锚点承载 sticky,行号本体靠负 margin 画进 pre 的 padding 区
        // ——sticky 不能直接挂行号,会被 Chrome 按 containing block 夹回代码列
        // (见 _editor-code.scss 行号段注释)。
        const anchor = document.createElement('span')
        anchor.className = 'velo-code-lineno-anchor'
        const span = document.createElement('span')
        span.className = 'velo-code-lineno'
        span.textContent = String(lineNum)
        anchor.appendChild(span)
        return anchor
      }, {
        side: -1,
        key: `code-ln:${pos}:${lineNum}`,
        ignoreSelection: true,
      }),
    )
    offset += lines[i].length + 1 // +1 for \n
  }
  return decos
}

/** 走 `decorationSet.empty` 而不是 `null` —— enabledSet 为空时根本不要
 *  decoration,ProseMirror 区分"空"和"空集合"语义(后者仍走 decorations
 *  重建,前者直接短路返回)。 */
function buildDecorations(
  state: EditorState,
  enabledSet: Set<number>,
): DecorationSet {
  if (enabledSet.size === 0) return DecorationSet.empty
  const decos: Decoration[] = []
  const scan = scanDoc(state.doc)
  const viewport = getViewport(state)
  for (const { node, pos } of scan.codeBlocks) {
    if (!enabledSet.has(pos)) continue
    if (!isInViewport(pos, node.nodeSize, viewport)) continue
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
    decos.push(...buildLineDecosForBlock(state.doc, node, pos))
  }
  return DecorationSet.create(state.doc, decos)
}

// ============================================================
//  Plugin
// ============================================================

/** docChanged 时把 enabledSet 的 pos 平移到新 doc 坐标(同 fold / wrap 范式)。 */
function mapEnabledSet(set: Set<number>, tr: Transaction): Set<number> {
  if (!tr.docChanged || set.size === 0) return set
  const mapped = new Set<number>()
  for (const pos of set) {
    mapped.add(tr.mapping.map(pos, -1))
  }
  return mapped
}

export const codeLineNumberPlugin = new Plugin<LineNumberState>({
  key: lineNumbersKey,
  state: {
    init: initialState,
    apply(tr, prev, oldState, newState) {
      const meta = tr.getMeta(lineNumbersKey) as
        | { toggle?: number }
        | undefined
      // selection-only:返回同一引用,PM 跳过 decoration diff
      if (!meta && !tr.docChanged) return prev

      let set = prev.enabledSet

      // toggle meta:翻转行号状态
      if (meta?.toggle != null) {
        set = new Set(prev.enabledSet)
        if (set.has(meta.toggle)) {
          set.delete(meta.toggle)
        } else {
          set.add(meta.toggle)
        }
      }

      // doc 变化:映射 enabledSet 位置(同 fold / wrap 的 mapping 范式)
      if (tr.docChanged && set.size > 0) {
        set = mapEnabledSet(set, tr)
      }

      // 同步 module-level set(apply 阶段,早于 decorations)
      syncModuleSet(tr.doc, set)

      // toggle meta → 全量重建(行号可见性变化)
      if (meta) {
        return { enabledSet: set, decoSet: null }
      }

      // fold / mermaid 状态变化 → 行号可见性变化 → 全量重建
      if (tr.getMeta(foldKey) || tr.getMeta(mermaidDecoKey)) {
        return { ...prev, enabledSet: set, decoSet: null }
      }
      // viewport 变化(滚动)→ 全量重建
      if (tr.getMeta(viewportKey)) {
        return { ...prev, enabledSet: set, decoSet: null }
      }

      if (!prev.decoSet || prev.enabledSet.size === 0) return { ...prev, enabledSet: set }

      // 增量:map 旧 set → 只重建 dirty range 内 code_block 的行号
      let newSet = prev.decoSet.map(tr.mapping, tr.doc)
      const scan = scanDoc(tr.doc)
      const oldMermaidState = mermaidDecoKey.getState(oldState)
      const affected: Array<{ pos: number; node: PMNode }> = []
      for (const step of tr.steps) {
        step.getMap().forEach((_os, _oe, ns, ne) => {
          for (const { node, pos } of scan.codeBlocks) {
            if (pos + node.nodeSize >= ns && pos <= ne) {
              if (!affected.some(a => a.pos === pos)) affected.push({ pos, node })
            }
          }
        })
      }
      if (affected.length === 0) return { ...prev, enabledSet: set, decoSet: newSet }

      for (const { pos, node } of affected) {
        const found = newSet.find(pos, pos + node.nodeSize)
        newSet = newSet.remove(found)
      }
      const newDecos: Decoration[] = []
      const viewport = getViewport(newState)
      for (const { node, pos } of affected) {
        if (!set.has(pos)) continue
        if (!isInViewport(pos, node.nodeSize, viewport)) continue
        const lang = (node.attrs.language as string) || ''
        if (lang === 'mermaid') {
          if (!oldMermaidState || !oldMermaidState.editNodeSet.has(pos + 1)) continue
        }
        if (isCodeBlockFolded(pos)) continue
        newDecos.push(...buildLineDecosForBlock(tr.doc, node, pos))
      }
      if (newDecos.length > 0) newSet = newSet.add(tr.doc, newDecos)
      return { ...prev, enabledSet: set, decoSet: newSet }
    },
  },
  props: {
    decorations(state) {
      const s = lineNumbersKey.getState(state)
      if (!s) return null
      if (!s.decoSet) {
        return buildDecorations(state, s.enabledSet)
      }
      return s.decoSet
    },
  },
})
