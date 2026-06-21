// 查找替换编辑器后端抽象 —— 把 PM / CM6 两套编辑器差异收敛到统一接口,
// 让 FindReplace.vue 不再直接依赖任一编辑器 API。
//
// 两后端语义差异(关键,各自符合该模式下用户所见文本):
//   - findMatches:PM 遍历文本节点搜 prose 文本(不含 markdown 标记,match 不跨块);
//     CM6 搜原始 markdown 全串(含 `**`/`|`/`[]()` 等,match 可跨行)。
//   - highlight:PM 走 findHighlightKey setMeta(ProseMirror 插件);CM6 走
//     cmFindHighlightEffect(CodeMirror StateField)。
//   - scroll:PM 焦点在 find 输入里时 tr.scrollIntoView 早退 → 手动 coordsAtPos +
//     祖先 scrollBy;CM6 的 scrollIntoView effect 不依赖焦点,直接 dispatch 即居中。
//   - selection / replaceRange / getRangeText:各自原生 API。
//
// Match.from/to 是编辑器本地坐标(PM pos / CM6 offset),FindReplace 不感知差异。

import { EditorView as PmEditorView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import { EditorView as CmEditorView } from '@codemirror/view'
import { EditorSelection as CmEditorSelection } from '@codemirror/state'
import { findMatchesInDoc, buildPattern, replaceInText, type FindOptions, type Match } from './findMatches'
import { findHighlightKey } from './findHighlight'
import { cmFindHighlightEffect } from './cmFindHighlight'

export type { Match, FindOptions } from './findMatches'

export interface FindReplaceBackend {
  /** 当前选区文本(空选区 → '')。Ctrl+F 初始 query 用。 */
  getSelectionText(): string
  /** [from,to) 的实际文本。replaceCurrent 取 match 文本跑 replaceInText(支持 $N)。 */
  getRangeText(from: number, to: number): string
  /** 在当前编辑器文档里找所有 match(本地坐标)。 */
  findMatches(query: string, options: FindOptions): Match[]
  /** 设选区 [from,to],不滚动(FindReplace 随后单独调 scrollMatchIntoView)。 */
  setSelection(from: number, to: number): void
  /** 把 match from 滚到滚动容器中线。 */
  scrollMatchIntoView(from: number): void
  /** 推高亮(matches / currentIndex 变化后调)。 */
  setHighlight(matches: Match[], currentIndex: number): void
  /** 清高亮。 */
  clearHighlight(): void
  /** 替换 [from,to) 为 newText,返回替换后光标应停的 pos(from + newText.length)。 */
  replaceRange(from: number, to: number, newText: string): number
  /** 焦点拉回编辑器(replaceAll / close 后)。 */
  focus(): void
}

// ============================================================
//  ProseMirror 后端
// ============================================================

export function createPmBackend(view: PmEditorView): FindReplaceBackend {
  return {
    getSelectionText() {
      const { from, to } = view.state.selection
      if (from === to) return ''
      return view.state.doc.textBetween(from, to, '\n', '\n')
    },
    getRangeText(from, to) {
      return view.state.doc.textBetween(from, to, '\n', '\n')
    },
    findMatches(query, options) {
      return findMatchesInDoc(view.state.doc, query, options)
    },
    setSelection(from, to) {
      const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to))
      view.dispatch(tr)
    },
    // 焦点在 find 输入里时 tr.scrollIntoView() 走 view.scrollIntoView() 会早退
    // (只滚当前 selection,我们要滚指定位置)→ 手动 coordsAtPos + 祖先 scrollBy 居中。
    scrollMatchIntoView(from) {
      const coords = view.coordsAtPos(from)
      if (!coords) return
      let el: HTMLElement | null = view.dom as HTMLElement
      while (el && el !== document.body) {
        const style = getComputedStyle(el)
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          const containerRect = el.getBoundingClientRect()
          const matchCenter = (coords.top + coords.bottom) / 2
          const containerCenter = containerRect.top + el.clientHeight / 2
          const delta = matchCenter - containerCenter
          // 差 < 4px 不滚,避免连续 Enter 时每下微小 smooth 抖动
          if (Math.abs(delta) > 4) el.scrollBy({ top: delta, behavior: 'smooth' })
          return
        }
        el = el.parentElement
      }
    },
    setHighlight(matches, currentIndex) {
      view.dispatch(view.state.tr.setMeta(findHighlightKey, { matches, currentIndex }))
    },
    clearHighlight() {
      view.dispatch(view.state.tr.setMeta(findHighlightKey, { matches: [], currentIndex: 0 }))
    },
    replaceRange(from, to, newText) {
      const tr = view.state.tr
      tr.replaceWith(from, to, view.state.schema.text(newText))
      view.dispatch(tr)
      return from + newText.length
    },
    focus() {
      view.focus()
    },
  }
}

// ============================================================
//  CodeMirror 6 后端
// ============================================================

export function createCmBackend(view: CmEditorView): FindReplaceBackend {
  return {
    getSelectionText() {
      const { from, to } = view.state.selection.main
      if (from === to) return ''
      return view.state.doc.sliceString(from, to)
    },
    getRangeText(from, to) {
      return view.state.doc.sliceString(from, to)
    },
    findMatches(query, options) {
      // CM6 文档即原始 markdown 串,offset == pos;在整串上跑全局正则。
      const pat = buildPattern(query, options)
      if (!pat) return []
      const text = view.state.doc.toString()
      const result: Match[] = []
      pat.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = pat.exec(text)) !== null) {
        if (m[0].length === 0) {
          // 零宽匹配手动推进,防死循环(同 findMatchesInDoc)
          pat.lastIndex++
          continue
        }
        result.push({ from: m.index, to: m.index + m[0].length })
      }
      return result
    },
    setSelection(from, to) {
      view.dispatch({ selection: CmEditorSelection.range(from, to) })
    },
    // CM6 的 scrollIntoView effect 不依赖焦点(与 PM 的 tr.scrollIntoView 不同),
    // 直接 dispatch 即可居中。
    scrollMatchIntoView(from) {
      view.dispatch({ effects: CmEditorView.scrollIntoView(from, { y: 'center' }) })
    },
    setHighlight(matches, currentIndex) {
      view.dispatch({ effects: cmFindHighlightEffect.of({ matches, currentIndex }) })
    },
    clearHighlight() {
      view.dispatch({ effects: cmFindHighlightEffect.of({ matches: [], currentIndex: 0 }) })
    },
    replaceRange(from, to, newText) {
      view.dispatch({
        changes: { from, to, insert: newText },
        selection: CmEditorSelection.cursor(from + newText.length),
      })
      return from + newText.length
    },
    focus() {
      view.focus()
    },
  }
}

/** replaceInText 透传(replaceAll / replaceCurrent 在 FindReplace 里编辑器无关地用)。 */
export { replaceInText }
