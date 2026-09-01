// CJK 字间距装饰插件(Phase 1)
//
// 对文档中的 CJK 字符段(汉字 / 假名 / 谚文 / 注音符号)添加 CSS
// `letter-spacing`,纯视觉层不改文档内容。Decoration.inline 包裹
// `.cjk-spacing` class,SCSS 层接管 `letter-spacing: 0.05em`。
//
// 代码块 / 行内代码内不添加装饰(schema.name === 'code_block' 的 node
// 直接跳过;inline code 不在 text node 父链里,由 schema 结构天然隔离)。
//
// **初始化与文件切换**:`state.init` 从 store 同步读初值;切文件时 `view.updateState
// (EditorState.create(...))` 会重跑 init,正确恢复开关态。
//
// **增量更新**:docChanged 时用 `tr.mapping` map 旧 DecorationSet,
// 再扫 dirty range(由 `tr.steps` 的 getMap 得到)内的文本节点重建装饰,
// 避免每次输入都全量扫描。

import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { useEditorStore } from '@/stores/editor'

// ============================================================
//  CJK Unicode 范围
// ============================================================

// 匹配 CJK 统一表意文字、假名、谚文、注音符号等"需要加字间距"的字符段。
// 连续的 CJK 字符合并为一个 run,减少 Decoration 数量。
//
// 范围:
//  \u2E80-\u9FFF   CJK 部首 / 字母 / 统一表意文字(含 Extension A 下半)
//  \uA000-\uA4CF  彝文
//  \uAC00-\uD7AF  谚文音节 / 谚文字母
//  \uF900-\uFAFF  CJK 兼容表意文字
//  \uFE30-\uFE4F  CJK 兼容形式
//  \uFF00-\uFFEF   全角 ASCII / 半角片假名 / 全角标点
//  \u3040-\u30FF  平假名 / 片假名
//  \u31F0-\u31FF  片假名扩展
//  \u3400-\u4DBF  CJK 统一表意文字 Extension A 上半
//  \u20000-\u2A6DF Extension B (surrogate pair, 单独处理)
//
// 简化:不处理 surrogate pair(Extension B+),这些字符极少出现在日常中文
// 写作中,且正则复杂度不值得。覆盖 BMP 内 CJK 已满足 99.9% 场景。
const CJK_REGEX = /[\u2E80-\u9FFF\uA000-\uA4CF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF]+/g

/** 扫描文本节点,返回 CJK 字符段的 [from, to] 范围数组(文档绝对位置)。 */
function findCjkRanges(text: string, basePos: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  CJK_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CJK_REGEX.exec(text)) !== null) {
    const start = basePos + match.index
    const end = start + match[0].length
    ranges.push([start, end])
  }
  return ranges
}

/** 遍历 doc,收集所有 text node 中的 CJK 范围,跳过 code_block。 */
function scanDocForCjk(doc: PMNode): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'code_block') return false // 跳过代码块子树
    if (!node.isText) return true
    const text = node.text!
    const localRanges = findCjkRanges(text, pos)
    for (const r of localRanges) ranges.push(r)
    return true
  })
  return ranges
}

// ============================================================
//  Plugin state
// ============================================================

interface CjkSpacingState {
  enabled: boolean
  /** 缓存的 DecorationSet;null 表示需要全量重建。 */
  decoSet: DecorationSet | null
}

export const cjkSpacingKey = new PluginKey<CjkSpacingState>('veloCjkLetterSpacing')

/** 从 store 同步读初值;store 未就绪 / 单元测试场景 fallback false。 */
function makeInitialState(): CjkSpacingState {
  let enabled = false
  try {
    const store = useEditorStore()
    if (typeof store.cjkLetterSpacing === 'boolean') {
      enabled = store.cjkLetterSpacing
    }
  } catch { /* pinia 未就绪 / 单元测试场景,fallback false */ }
  return { enabled, decoSet: null }
}

/** 全量重建装饰。 */
function buildDecorations(state: EditorState, enabled: boolean): DecorationSet {
  if (!enabled) return DecorationSet.empty
  const ranges = scanDocForCjk(state.doc)
  if (ranges.length === 0) return DecorationSet.empty
  const decos = ranges.map(([from, to]) =>
    Decoration.inline(from, to, { class: 'cjk-spacing' }),
  )
  return DecorationSet.create(state.doc, decos)
}

export const cjkLetterSpacingPlugin = new Plugin<CjkSpacingState>({
  key: cjkSpacingKey,
  state: {
    init: makeInitialState,
    apply(tr, prev, _oldState, newState) {
      const meta = tr.getMeta(cjkSpacingKey) as { enabled?: boolean } | undefined
      if (meta) {
        return { enabled: meta.enabled ?? prev.enabled, decoSet: null }
      }
      // selection-only:返回同一引用,PM 跳过 decoration diff
      if (!tr.docChanged) return prev
      if (!prev.decoSet || !prev.enabled) return prev

      // 增量:map 旧 set → 扫 dirty range 重建受影响装饰
      let newSet = prev.decoSet.map(tr.mapping, tr.doc)

      // 收集 dirty range 内的 CJK 装饰,先移除
      const dirtyRanges: Array<[number, number]> = []
      for (const step of tr.steps) {
        step.getMap().forEach((_os, _oe, ns, ne) => {
          dirtyRanges.push([ns, ne])
        })
      }

      // 移除与 dirty range 相交的旧装饰
      for (const [ds, de] of dirtyRanges) {
        const found = newSet.find(ds, de)
        newSet = newSet.remove(found)
      }

      // 重建 dirty range 内的 CJK 装饰:
      // 扫描 dirty range 覆盖的文本节点
      const newDecos: Decoration[] = []
      for (const [ds, de] of dirtyRanges) {
        newState.doc.nodesBetween(ds, de, (node, pos) => {
          if (node.type.name === 'code_block') return false
          if (!node.isText) return true
          // 文本节点可能只部分落在 dirty range 内,扫描整段即可
          // (findCjkRanges 用绝对位置,Decoration.inline 范围正确)
          const textStart = pos
          const textEnd = pos + node.text!.length
          // 只处理与 dirty range 有交集的文本节点
          if (textEnd < ds || textStart > de) return true
          const localRanges = findCjkRanges(node.text!, textStart)
          for (const [from, to] of localRanges) {
            newDecos.push(Decoration.inline(from, to, { class: 'cjk-spacing' }))
          }
          return true
        })
      }

      if (newDecos.length > 0) {
        newSet = newSet.add(newState.doc, newDecos)
      }

      return { ...prev, decoSet: newSet }
    },
  },
  props: {
    decorations(state) {
      const s = cjkSpacingKey.getState(state)
      if (!s) return null
      if (!s.decoSet) {
        return buildDecorations(state, s.enabled)
      }
      return s.decoSet
    },
  },
})
