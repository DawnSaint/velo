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
//   - onDocChange:两侧都订阅 doc 变化 → 面板打开期间重算 matches。PM 走
//     subscribeFindDocChange(微任务合并同 tick),CM6 走 subscribeCmDocChange
//     (120ms trailing debounce,避免逐键全文正则扫描)。见各自模块。
//   - PM 侧特有:markSourceEdit 会把行内 code / strong 等 mark 临时换成 markdown
//     源码字面量(改 doc),FindReplace 缓存的 matches 坐标因此会整体漂移。
//     findMatches 前先 flush 会话、面板打开期间冻结这类插件、doc 变化后重算,
//     三条一起保证坐标唯一(见 findHighlight.ts 顶部注释)。charRef 源码态同理
//     (1 个解码字符 → 6 个字符);面板活跃期间它不改 doc,改用纯装饰显示命中
//     实体,关闭时 clearHighlight 顺带 recheckCharRefReveal 按选区重判。
//
// Match.from/to 是编辑器本地坐标(PM pos / CM6 offset),FindReplace 不感知差异。

import { EditorView as PmEditorView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import { EditorView as CmEditorView } from '@codemirror/view'
import { EditorSelection as CmEditorSelection } from '@codemirror/state'
import { findMatchesInDoc, buildPattern, type FindOptions, type Match } from './findMatches'
import { findHighlightKey, subscribeFindDocChange } from './findHighlight'
import { cmFindHighlightEffect } from './cmFindHighlight'
import { subscribeCmDocChange } from './cmDocChange'
import { flushMarkSourceEdit } from '../plugins/markSourceEdit'
import { flushCharRefReveal, recheckCharRefReveal } from '../plugins/charRefSourceEdit'
import { ensureMermaidSourceVisibleAt } from '../nodes/MermaidDecoration'

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
  /** 清高亮。PM 侧同时解除「查找面板打开」标记。 */
  clearHighlight(): void
  /** 查找面板开合通知:PM 侧冻结会改 doc 的瞬时视图插件,并 flush 已有会话。 */
  setFindActive(active: boolean): void
  /** 订阅文档变化 → 面板打开期间重算 matches,返回取消订阅函数。 */
  onDocChange(cb: () => void): () => void
  /** 替换 [from,to) 为 newText,返回替换后光标应停的 pos(from + newText.length)。 */
  replaceRange(from: number, to: number, newText: string): number
  /** 焦点拉回编辑器(replaceAll / close 后)。 */
  focus(): void
}

// ============================================================
//  ProseMirror 后端
// ============================================================

function centerPmPos(view: PmEditorView, from: number, behavior: ScrollBehavior = 'smooth'): void {
  if (view.isDestroyed) return
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
      if (Math.abs(delta) > 4) el.scrollBy({ top: delta, behavior })
      return
    }
    el = el.parentElement
  }
}

// setSelection 留下的"刚展开过 mermaid"标记:scrollMatchIntoView 读到了就知道
// 这次布局抖过(pre display:none → block、widget 重建),要 rAF 等一帧再 coordsAtPos。
// 跨文件搜索 + Ctrl+F 都走 setSelection → scrollMatchIntoView 串联,
// 不能在 scrollMatchIntoView 里再调一次 ensureMermaidSourceVisibleAt 当信号用 ——
// helper 是幂等的,第二次必然 false,等于把"刚展开"这个事实丢了,scroll 立刻发生
// 在还没稳定的 layout 上,跨文件冷启动时尤其明显。
const scrollNeedsFrame = new WeakMap<PmEditorView, boolean>()

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
      // markSourceEdit 的 session 把 mark 换成源码字面量(行内 code → "`code`",
      // 净 +2),doc 坐标系与渲染态不通用。先 commit 会话再搜,matches 才能落在
      // 稳定的渲染态坐标上。flush 是同步 dispatch,view.state.doc 随即更新;
      // 没有 session(或没装该插件)时返回 null,零副作用。
      flushMarkSourceEdit(view)
      // 实体源码态同样会改 doc 长度(解码字符 → 实体字面量),先还原再算坐标。
      // 工作区搜索点击结果走 findMatches → setSelection → 重新进入源码态,无副作用。
      flushCharRefReveal(view)
      return findMatchesInDoc(view.state.doc, query, options)
    },
    setSelection(from, to) {
      const expandedMermaid = ensureMermaidSourceVisibleAt(view, from)
      // 仅在这次真把 mermaid 展开时才标记;幂等展开(已展开 / 非 mermaid)不污染
      scrollNeedsFrame.set(view, expandedMermaid)
      const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to))
      view.dispatch(tr)
    },
    // 焦点在 find 输入里时 tr.scrollIntoView() 走 view.scrollIntoView() 会早退
    // (只滚当前 selection,我们要滚指定位置)→ 手动 coordsAtPos + 祖先 scrollBy 居中。
    // Mermaid 源码默认 display:none,pre display:block 切换会让 pre 与 widget 重建,
    // 必须等下一帧让浏览器把 layout 算稳再 coordsAtPos,否则 scroll 偏(跨文件冷启动
    // 最明显)。读 setSelection 留下的标记:helper 幂等,第二次不会返 true,所以不能
    // 在这里直接调 ensureMermaidSourceVisibleAt 当信号;只有没标记时才再调一次兜底
    // (调用方直接调 scrollMatchIntoView 而没先 setSelection 的场景)。
    scrollMatchIntoView(from) {
      let needsFrame = scrollNeedsFrame.get(view) === true
      scrollNeedsFrame.delete(view)
      if (!needsFrame && ensureMermaidSourceVisibleAt(view, from)) {
        needsFrame = true
      }
      if (needsFrame) {
        requestAnimationFrame(() => centerPmPos(view, from, 'auto'))
        return
      }
      centerPmPos(view, from)
    },
    setHighlight(matches, currentIndex) {
      view.dispatch(view.state.tr.setMeta(findHighlightKey, { type: 'set', matches, currentIndex }))
    },
    clearHighlight() {
      view.dispatch(view.state.tr.setMeta(findHighlightKey, { type: 'active', active: false }))
      // 面板关闭(findOpen → false)时焦点已经还给编辑器:解除退避后按当前选区
      // 重判一次实体源码态 —— 命中停在实体上就继续显示字面量,否则空操作。
      // 工作区搜索跳转也走这里,此时选区就在刚展开的实体内,sync 会保持原状。
      recheckCharRefReveal(view)
    },
    setFindActive(active) {
      if (active) {
        // 先立守卫再 flush:flush 自身是 docChanged tr,不会被 appendTransaction
        // 的「纯选区变化」守卫误判成又一次 enter。
        view.dispatch(view.state.tr.setMeta(findHighlightKey, { type: 'active', active: true }))
        flushMarkSourceEdit(view)
        flushCharRefReveal(view)
      } else {
        view.dispatch(view.state.tr.setMeta(findHighlightKey, { type: 'active', active: false }))
      }
    },
    onDocChange(cb) {
      return subscribeFindDocChange(view, cb)
    },
    replaceRange(from, to, newText) {
      const tr = view.state.tr
      // 新内容为空 → 走 tr.delete。
      // schema.text('') 会抛 RangeError('Empty text nodes are not allowed'):
      // ProseMirror 不允许构造空 text 节点(无论是否带 mark),replaceCurrent /
      // replaceAll 在 replacement='' 的"删 match"场景会撞这层。delete 是
      // 同一意图的等价路径 —— 删除区间 + 光标停在 from,replacement.length
      // 仍 0,后续 findNext 的 cursorPos = from + 0 也对得上。
      if (newText.length === 0) tr.delete(from, to)
      else tr.replaceWith(from, to, view.state.schema.text(newText))
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
    // CM6 的文档就是原始 markdown,没有「渲染态 ↔ 源码态」的瞬时切换,无需冻结;
    // 但面板打开期间用户继续输入会让缓存的 matches 坐标陈旧 —— cmFindHighlightField
    // 的 deco.map(tr.changes) 只让高亮视觉跟住,坐标仍要重算。故订阅 doc 变化,
    // 经 120ms debounce 通知 FindReplace 重算(见 cmDocChange.ts)。
    setFindActive(_active) {},
    onDocChange(cb) {
      return subscribeCmDocChange(view, cb)
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
