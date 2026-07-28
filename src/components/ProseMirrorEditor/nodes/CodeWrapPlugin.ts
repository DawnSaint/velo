// code_block 自动换行(wrap)—— v0.6.3。
//
// 为什么走独立 plugin 而非并入 codeHighlightPlugin:
//   - wrap 状态是 per-code_block 的运行时视图态(与 fold 同范式),不进 schema /
//     markdownIO(round-trip 完全无感)。独立 plugin 的 state + decorations
//     职责单一,codeHighlightPlugin 只需读 wrap 状态把按钮 active 态 + key
//     打进 header widget。
//   - 与 FoldDecoration 同构:Set<number> 跟踪 node pos、module-level
//     set 供跨 plugin 读、apply 阶段 mapping + 同步 set、decorations 阶段
//     挂 Decoration.node({ 'data-velo-wrap': 'true' })。
//
// **默认开启**:语义翻转——跟踪的是 *已关闭 wrap* 的 code_block
//   (unwrappedSet),空集 = 全部开启。新创建的 code_block 不在 set 中 → 自动
//   开启 wrap。用户点 toggle 关闭 → 加入 set;再点开启 → 移出 set。
//
// 与 fold 的差异:
//   - 无稳定 key 持久化(wrap 是临时视图偏好,切文件后重置)。
//   - 无折叠区段联动(wrap 只影响 pre 的 CSS white-space,不影响其他节点)。
//   - toggle 按钮在 CodeHighlightWidget 的 header 内(复制按钮左侧),与 fold
//     chevron 同一 header 但独立按钮;wrap 开启 / 关闭时图标切换。
//
// 行号交互:wrap 开启后单条逻辑行可能跨多条视觉行,gutter widget 需动态
//   测量每行实际高度并同步行号 div 高度(见 CodeLineNumberWidget.ts 的
//   syncLineHeights)。gutter widget key 含 wrap 状态 → toggle 时 PM 重建
//   widget → 新 widget 的 syncPosition 测量正确高度。
//
// 不持久化:wrap 状态只在当前编辑会话有效,切文件 / 重开 = 重置(全部恢复
//   默认开启)。后续可选走 stable key + store(同 fold)。

import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { scanDoc } from './docScanCache'

// ============================================================
//  Plugin state
// ============================================================

interface CodeWrapState {
  /** 已 *关闭* wrap 的 code_block node pos 集合。空集 = 全部开启(默认)。 */
  unwrappedSet: Set<number>
}

function initialState(): CodeWrapState {
  return { unwrappedSet: new Set() }
}

export const codeWrapKey = new PluginKey<CodeWrapState>('codeWrap')

// ============================================================
//  Cross-plugin 通信:module-level set
// ============================================================
//
// 与 FoldDecoration 的 foldedCodeBlockPosSet 同范式:CodeLineNumberWidget
// 的 gutter widget 需要读 wrap 状态决定是否动态测量行高,但 gutter 的
// buildDecorations 不方便拿 codeWrapKey.getState(它只从 isCodeBlockFolded
// 这种函数读)。module-level set 在 apply 阶段同步更新(早于 decorations),
// 保证 gutter widget 看到最新值。
//
// 存储 node pos(非 contentStart),与 FoldDecoration 的 isCodeBlockFolded
// 对齐——调用方(CodeHighlightWidget / CodeLineNumberWidget)传的都是
// descendants 给的 node pos。
let unwrappedCodeBlockPosSet: Set<number> = new Set()

/** 公开:判断本 code_block 是否已开启 wrap(默认 true)。 */
export function isCodeBlockWrapped(codeBlockPos: number): boolean {
  return !unwrappedCodeBlockPosSet.has(codeBlockPos)
}

/** 同步 module-level set:从 doc 实际 code_block 节点校验,过滤已删除的 pos。 */
function syncModuleSet(doc: PMNode, set: Set<number>): void {
  const next = new Set<number>()
  for (const { pos } of scanDoc(doc).codeBlocks) {
    if (set.has(pos)) {
      next.add(pos)
    }
  }
  unwrappedCodeBlockPosSet = next
}

// ============================================================
//  构造 decorations
// ============================================================

function buildDecorations(state: EditorState, unwrappedSet: Set<number>): DecorationSet {
  const decos: Decoration[] = []
  for (const { node, pos } of scanDoc(state.doc).codeBlocks) {
    // 在 unwrappedSet 中 = 用户已关闭 wrap,跳过(不加 data-velo-wrap)
    if (unwrappedSet.has(pos)) continue
    decos.push(
      Decoration.node(pos, pos + node.nodeSize, {
        'data-velo-wrap': 'true',
      }, { key: `code-wrap:${pos}` }),
    )
  }
  return DecorationSet.create(state.doc, decos)
}

// ============================================================
//  Plugin
// ============================================================

export const codeWrapPlugin = new Plugin<CodeWrapState>({
  key: codeWrapKey,
  state: {
    init: initialState,
    apply(tr, prev) {
      const meta = tr.getMeta(codeWrapKey) as
        | { toggle?: number }
        | undefined
      let set = prev.unwrappedSet
      if (meta?.toggle != null) {
        set = new Set(prev.unwrappedSet)
        if (set.has(meta.toggle)) {
          // 已在 unwrappedSet 中 → 移出 = 恢复默认开启
          set.delete(meta.toggle)
        } else {
          // 不在 unwrappedSet 中 → 加入 = 关闭 wrap
          set.add(meta.toggle)
        }
      }
      // Map positions through the transaction (同 fold 的 mapping 范式)
      if (tr.docChanged) {
        const nextSet = new Set<number>()
        for (const pos of set) {
          const mapped = tr.mapping.map(pos, -1)
          if (mapped > 0 && mapped < tr.doc.content.size) {
            nextSet.add(mapped)
          }
        }
        set = nextSet
      }
      // 同步 module-level set(apply 阶段,早于 decorations)
      syncModuleSet(tr.doc, set)
      return { unwrappedSet: set }
    },
  },
  props: {
    decorations(state) {
      const s = codeWrapKey.getState(state)
      if (!s) return null
      return buildDecorations(state, s.unwrappedSet)
    },
  },
})
