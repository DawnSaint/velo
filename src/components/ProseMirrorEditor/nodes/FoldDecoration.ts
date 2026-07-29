// 块级折叠(heading / list_item / code_block)—— v0.5.12。
//
// code_block 折叠:header 标题栏内置 chevron,click → dispatch
// setMeta(foldKey, { toggle: contentStart })。折叠态 pre 挂 velo-folded
// class → display:none,header 保留显示(含行数摘要)。toggle 由
// CodeHighlightWidget 的 header widget 提供(不需要 FoldDecoration 再挂
// toggle widget),本 plugin 只负责 Decoration.node 隐藏 pre + stable key
// 持久化 + cross-plugin set 同步(lineNumber / mermaid 跳过)。
//
// 范式:对齐 mermaid / toc / codeLineNumber 走 ProseMirror 标准
// `Decoration.widget` + `Decoration.node`,不走 NodeView(同 mermaid 教训:
// NodeView outer dom 改 innerHTML 会被 PM DOMObserver 当外部突变)。
//
// 关键设计取舍:
//  1. **视觉折叠、不改 doc**。folded 区段挂 `class: 'velo-folded'` → SCSS
//     `display:none`。markdown round-trip 完全不受影响,折叠态不污染
//     `toMarkdown()` 输出。
//  2. **plugin state 跟踪 `Set<number>`**(折叠点绝对 pos,即 heading /
//     list_item / code_block 的 contentStart)。`tr.mapping.map(pos, -1)` 跟住
//     doc 变化(mermaid 同坑,见 MermaidDecoration.ts apply 注释)。
//  3. **稳定 key 持久化**。doc pos 关闭文件后失效,store 存的是由 block
//     类型 + 内容指纹派生的字符串(见 makeStableKey)。换文件 / 重开 →
//     EditorInner 把 store keys → 当前位置,walk doc 翻译回 Set<number>。
//  4. **toggle 按钮永远渲染**(heading / list_item)。collapsed / expanded 共用
//     同一个 widget,切到 expanded 时变 chevron-down,collapsed 时变
//     chevron-right。code_block 的 toggle 在 CodeHighlightWidget 的 header 内。
//  5. **placeholder 是真实 inline atom 节点**(fold_placeholder),不是
//     Decoration.widget。v0.7.2 改为真实节点:光标可自然停在 `...` 两侧、
//     可被 TextSelection 覆盖划选。折叠/展开时由 appendTransaction 插入/
//     删除节点(addToHistory:false,不进 undo)。toMarkdown 跳过(不污染
//     markdown round-trip)。点击 `...` → handleClickOn 展开(与 chevron 等效)。
//     划选覆盖 `...` → Decoration.node 挂 is-selected 高亮;foldDeleteCommand
//     (排在 keymap 链首)把删除范围扩展到折叠节点起点 ~ range[1](整块删除)+
//     从 collapsedSet 移除该折叠点。
//  6. **list_item 仅在含 block 子项时折叠**(`content: 'paragraph block*'`,
//     折叠 = 首段之后的 block 子项)。无子项 → 不挂 toggle,避免对纯叶子
//     列表项加冗余按钮。
//  7. **selectable: false**。folded 区段不可被节点选中 / 鼠标拖蓝选中,
//     防止从 folded 块外选进 hidden 文本;键盘箭头仍可越过 hidden 文本
//     (PM 不知 CSS display,见下面"维护者注意点"一节;v1 接受)。
//     注意:`selectable: false` 只挡 NodeSelection / 鼠标 drag,不挡
//     `tr.delete(from, to)` 区间删除 —— foldDeleteCommand
//     直接 `tr.delete(nodeStart, range[1])` 仍能删掉区间内的隐藏 block。
//  8. **auto-expand on search hit**:`ensureFoldExpandedAt(view, pos)` 与
//     mermaid 的 `ensureMermaidSourceVisibleAt` 同形态,findreplace 命中
//     隐藏区段时幂等展开。
//
// 维护者注意点:
//  - `selectable: false` 不阻挡 PM 键盘 navigation。ArrowRight / End 等
//    仍可把光标送进 display:none 区段。这是有意接受:1) 视觉不可见,
//    用户极少主动进 hidden 文本;2) 修起来要把 fold 区段包成 NodeView
//    自管 keydown,范围大,v1 不做。
//  - `tr.mapping.map(pos, -1)` 用 `-1` association:insertText 折叠点
//    之前时,pos 不会跑到新文本末尾(mermaid 同坑,见 MermaidDecoration
//    .ts apply 内注释)。
//  - 折叠区段 `selectable: false` 仅阻止 node 选中 + 鼠标拖蓝;PM 的
//    `node-resize` / `gapCursor` 仍可落在区段边界,这是合规的(用户
//    在折叠区段前/后正常操作)。不影响 gapCursor 进出(已实测)。
//  - 折叠 widget **不** dispatch setMeta 触发自身 rebuild:widget destroy
//    → create 是 PM 在每次 docChanged / 自身 apply 后自动 rebuild,
//    不需要 plugin 主动推;mermaid 同范式。
//  - `state.init` 不读 foldStore。EditorInner.vue 挂载完(以及 file 切换)
//    主动 dispatch `setMeta(foldKey, { initCollapsed: number[] })` 灌入
//    当前文件的折叠 pos(由 store 里的 stable key 经 doc walk 翻译得)。

import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorState, Transaction } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { chevronDownSvg } from '@/components/icons/widgetIcons'
import { useFoldStore } from '@/stores/folding'
import { useDocumentStore } from '@/stores/document'
import { scanDoc } from './docScanCache'
import { viewportKey } from './viewportPlugin'
// useFoldStore / useDocumentStore 在 view factory 内 lazy 调用 —— 模块顶层
// 调 pinia 还没就绪,view factory 跑时已经在 component context 内。

// ============================================================
//  Plugin state
// ============================================================

export interface FoldState {
/** 折叠点绝对 pos(contentStart)集合 —— heading / list_item / code_block /
*  frontmatter 折叠时,各自的 contentStart 落进 set。见 FOLDABLE_TYPES。 */
collapsedSet: Set<number>
/** 缓存的 DecorationSet;null 表示需要全量重建。 */
decoSet: DecorationSet | null
}

function initialState(): FoldState {
return { collapsedSet: new Set(), decoSet: null }
}

export const foldKey = new PluginKey<FoldState>('foldDecoration')

// 折叠白名单 —— makeStableKey / apply / collectFoldableKeys / buildDecorations
// 四处检查节点类型的位置统一从这里过。新增类型只加这里,不动四个方面任何一处。
const FOLDABLE_TYPES = new Set(['heading', 'list_item', 'code_block', 'frontmatter'])
const isFoldable = (n: PMNode) => FOLDABLE_TYPES.has(n.type.name)

// ============================================================
//  Cross-plugin 通信:当前处于 fold 范围内的 code_block 节点 pos 集合
// ============================================================
//
// codeLineNumberPlugin 的行号 widget 是 position: absolute 浮在
// code_block 外部,无法靠 ancestor `display: none` 跟着 hide —— 即使
// pre 被挂 `velo-folded`,行号 widget 仍会按 pre 的 0,0 rect 算 transform,
// 飞到界面左上角;且展开后的下一帧 lineNumberPlugin.decorations(state)
// 看到的是 stale set(仍带本折叠的 code_block pos),再次跳过 gutter
// widget,表现为"展开后行号消失"。
//
// 修法:这里维护一个 module-level Set,装当前折叠范围内所有 code_block
// 节点的绝对 pos(descendants 给的 code_block 节点 pos,即 open token
// 之前的位置)。**apply 阶段同步**(而非 view hook):
// PM 渲染顺序是 reducer chain → plugin.decorations(state) → DOM 渲染
// → view.update(view)。lineNumberPlugin.decorations 必须看到最新
// 集合,fold 区段的 code_block 同步不挂 gutter widget(避免飞到 (0,0));
// 展开帧 set 已被 apply 清空 → gutter 重挂回 → 行号回来。
//
// 为什么不走 plugin state 通信:行号 widget 不需要持久化、不需要 sync 到
// 协作 / undo,纯运行时缓存,module-level Set 足够。
let foldedCodeBlockPosSet: Set<number> = new Set()
let foldedMermaidPosSet: Set<number> = new Set()
let foldedTocPosSet: Set<number> = new Set()

/** 祖先(heading / list_item)折叠范围内的 code_block 节点 pos 集合。
 *  与 foldedCodeBlockPosSet 的区别:不含 code_block 自身折叠的 pos。
 *  CodeHighlightWidget 据此跳过 header widget —— 自身折叠时 header 是摘要
 *  (行数 + 语言 + 复制)必须保留,但祖先折叠时整个区段都该隐,header
 *  不能孤悬在外。 */
let ancestorFoldedCodeBlockPosSet: Set<number> = new Set()

/** 公开:codeLineNumberPlugin 调,判断本 code_block 是否处于 fold 范围内
 *  (含自身折叠 + 祖先折叠)。行号 gutter 在两种情况下都应跳过(pre 均被
 *  velo-folded 隐)。 */
export function isCodeBlockFolded(codeBlockPos: number): boolean {
  return foldedCodeBlockPosSet.has(codeBlockPos)
}

/** 公开:CodeHighlightWidget 调,判断本 code_block 是否被祖先(heading /
 *  list_item)折叠隐。与 isCodeBlockFolded 的区别:不含 code_block 自身折叠。
 *  自身折叠时 header 是摘要必须保留;祖先折叠时整个区段都该隐,header
 *  不能孤悬在外。 */
export function isCodeBlockAncestorFolded(codeBlockPos: number): boolean {
  return ancestorFoldedCodeBlockPosSet.has(codeBlockPos)
}

/** 公开:MermaidDecoration 调,判断本 mermaid code_block 是否处于 fold 范围
 *  内。fold 范围内的 mermaid:pre 已被 velo-folded display:none 隐藏,但
 *  SVG widget 是 pre 的 sibling(不受 velo-folded 影响),不跳过的会浮在
 *  fold 区间之外 → 整段不是"折叠"视觉。这里跳过整个 widget 创建,
 *  → mermaid 整块(pre + SVG + toolbar)跟 fold 区段一起隐。
 *
 *  与 isCodeBlockFolded 同源(recomputeFoldedCodeBlockPos 一并维护),
 *  都是 descendants-style pos(node open token 之前的位置)。 */
export function isMermaidFolded(codeBlockPos: number): boolean {
  return foldedMermaidPosSet.has(codeBlockPos)
}

/** 公开:TocDecoration 调,判断本 toc 节点是否处于 fold 范围内。
 *  fold 范围内的 toc:节点自身 DOM(<div data-type="toc">)已被
 *  velo-folded display:none 隐藏,但 TOC widget 是 block-level sibling
 *  (不受 velo-folded 影响),不跳过的会浮在 fold 区间之外 → 整段
 *  不是"折叠"视觉。跳过整个 widget 创建,展开帧 isTocFolded 翻 false
 *  → widget 重建 → TOC 完整回归(同 isMermaidFolded 范式)。 */
export function isTocFolded(tocPos: number): boolean {
  return foldedTocPosSet.has(tocPos)
}

/** 从 state 算当前所有 fold 范围内 code_block / mermaid 节点 pos,更新
 *  module-level sets。 */
function recomputeFoldedCodeBlockPos(doc: PMNode, collapsedSet: Set<number>) {
  const nextCode = new Set<number>()
  const nextMermaid = new Set<number>()
  const nextToc = new Set<number>()
  const nextAncestorFolded = new Set<number>()
  for (const triggerContentStart of collapsedSet) {
    // 越界守卫:切标签时 apply 可能收到上一个标签的 stale pos(与 doc 不匹配),
    // doc.resolve 会抛 "Position X outside of fragment"。越界直接跳过。
    if (triggerContentStart < 0 || triggerContentStart > doc.content.size) continue
    const triggerNode = doc.resolve(triggerContentStart).parent
    // code_block 折叠自身:直接加入 foldedCodeBlockPosSet
    // (不加入 ancestorFoldedCodeBlockPosSet —— 自身折叠时 header 是摘要)
    if (triggerNode.type.name === 'code_block') {
      const blockPos = triggerContentStart - 1
      if (blockPos < 0 || blockPos >= doc.content.size) continue
      nextCode.add(blockPos)
      const lang = (triggerNode.attrs.language as string) || ''
      if (lang === 'mermaid') nextMermaid.add(blockPos)
      continue
    }
    // heading / list_item:查找 fold 范围内的 code_block / toc
    if (
      triggerNode.type.name !== 'heading'
      && triggerNode.type.name !== 'list_item'
    ) continue
    // trigger 节点的 pos:用 contentStart 之前的兄弟 pos 推算
    // 直接走 doc.nodeAt(triggerContentStart - 1) 拿该 block
    const blockPos = triggerContentStart - 1
    if (blockPos < 0 || blockPos >= doc.content.size) continue
    const blockNode = doc.nodeAt(blockPos)
    if (!blockNode) continue
    const range = computeFoldRange(blockNode, triggerContentStart, doc)
    if (!range) continue
    doc.nodesBetween(range[0], range[1], (n, p) => {
      if (p < 0 || p >= doc.content.size) return
      if (n.type.name === 'code_block') {
        nextCode.add(p)
        nextAncestorFolded.add(p)
        const lang = (n.attrs.language as string) || ''
        if (lang === 'mermaid') nextMermaid.add(p)
      }
      else if (n.type.name === 'toc') {
        nextToc.add(p)
      }
    })
  }
  foldedCodeBlockPosSet = nextCode
  foldedMermaidPosSet = nextMermaid
  foldedTocPosSet = nextToc
  ancestorFoldedCodeBlockPosSet = nextAncestorFolded
}

// ============================================================
//  稳定 key(持久化用)
// ============================================================

const KEY_PREFIX_HEADING = 'h'
const KEY_PREFIX_LI = 'li'
const KEY_PREFIX_CB = 'cb'
const KEY_PREFIX_FM = 'fm'
const KEY_TEXT_LIMIT = 80

/**
 * 派生 block 的稳定 key(供折叠状态持久化使用)。
 * 设计取舍:用"block 类型 + 前 80 字内容"作指纹。
 *  - 优点:跨文件关闭 / 重开能保持折叠
 *  - 缺点:用户改了 heading 文本,key 变了,折叠态不会跟随
 *  - 这是合理的:折叠是"大块内容视图",用户编辑块内容本就该 unfold 重看
 *
 * 文本截断 + 简单 normalize:trim + 折叠多空格 → 减少意外抖动。
 */
export function makeStableKey(node: PMNode): string {
  // IIFE 抽取节点指纹文本:String(heading / list_item 首段 / code_block /
  // frontmatter 全部内容)。返回值 trim + 多空格折叠 + 80 字符截断,供下方
  // 各类型前缀复用。
  const text = (() => {
    if (node.type.name === 'heading') return node.textContent || ''
    if (node.type.name === 'list_item') {
      // list_item 首子是 paragraph(必填,见 schema),折叠 key 跟首段挂钩
      return node.firstChild?.textContent || ''
    }
    if (node.type.name === 'code_block') {
      return node.textContent || ''
    }
    if (node.type.name === 'frontmatter') {
      return node.textContent || ''
    }
    return ''
  })().trim().replace(/\s+/g, ' ').slice(0, KEY_TEXT_LIMIT)

  if (node.type.name === 'heading') {
    return `${KEY_PREFIX_HEADING}${node.attrs.level as number}:${text}`
  }
  if (node.type.name === 'list_item') {
    return `${KEY_PREFIX_LI}:${text}`
  }
  if (node.type.name === 'code_block') {
    const lang = (node.attrs.language as string) || ''
    return `${KEY_PREFIX_CB}:${lang}:${text}`
  }
  if (node.type.name === 'frontmatter') {
    return `${KEY_PREFIX_FM}:${text}`
  }
  return ''
}

/**
 * 给定 doc + contentStart,返回该位置对应 block 的稳定 key。
 * 用于 plugin view hook 把折叠 pos → stable key 写回 store。
 * pos 无效或对应节点不是 foldable → 返回 ''(caller 跳过)。
 *
 * **位置越界守卫**:切标签时 view.updateState(cachedState) 整体替换 state,
 * foldDecoPlugin.view.update 的 prevCollapsed 闭包仍持有上一个标签的折叠 pos。
 * diff 同步逻辑会拿旧标签的 pos 在新标签的 doc 上调 makeStableKeyForPos →
 * doc.nodeAt(pos) 抛 "Position X outside of fragment"。这里在 nodeAt 之前
 * 做 bounds check,越界直接返回 ''(跳过 store 同步,不 crash)。
 */
function makeStableKeyForPos(doc: PMNode, pos: number): string {
  if (pos < 0 || pos > doc.content.size) return ''
  const node = doc.nodeAt(pos)
  if (!node) return ''
  if (isFoldable(node)) {
    return makeStableKey(node)
  }
  return ''
}

// ============================================================
//  Fold range 计算
// ============================================================

/**
 * 给一个折叠点 node 算折叠区段 [from, to)。
 * - heading:折叠到下一个 level <= 当前 level 的 heading 之前;若直到 doc
 *   末尾都找不到 → 折到 doc.content.size
 * - list_item:首段之后的所有 block 子项(`content: 'paragraph block*'`,
 *   首段必填,折叠 = 从 firstChildEnd 到 listItemEnd);无 block 子项时
 *   返回 null(不应折叠)
 *
 * 失败 → null(调用方跳过该折叠点)。
 */
function computeFoldRange(
  node: PMNode,
  contentStart: number,
  doc: PMNode,
): [number, number] | null {
  if (node.type.name === 'heading') {
    const thisLevel = node.attrs.level as number
    const headingType = node.type
    // 找到当前 heading 在 doc 顶层 children 里的 index。
    // **关键修复**:之前用 `doc.resolve(cursor).parent` walk forward,
    // 在某些 doc 结构下 $pos.parent 不是预期的直接 sibling(比如 cursor
    // 落在嵌套容器边界,parent 跳到外层容器),导致 cursor 步长错乱,fold
    // range 一路滚到 doc 末尾 —— 用户报"折叠后面所有内容"。
    // 改为严格走 doc 顶层 children 序列,杜绝 parent 跳变。
    const myIndex = findDocChildIndex(doc, contentStart - 1)
    if (myIndex < 0) return null
    // fold range 起点 = 当前 heading 之后 = (myIndex + 1) 之后的第一个
    // child 的起始 pos。
    const after = myIndex + 1
    if (after >= doc.childCount) return null
    const headingEnd = childStartPos(doc, after)
    // walk forward 在 doc 顶层 children 上找下一个同/高 level heading
    for (let i = after; i < doc.childCount; i++) {
      const child = doc.child(i)
      if (
        child.type === headingType
        && (child.attrs.level as number) <= thisLevel
      ) {
        return [headingEnd, childStartPos(doc, i)]
      }
    }
    return [headingEnd, doc.content.size]
  }

  if (node.type.name === 'list_item') {
    const firstChild = node.firstChild
    if (!firstChild) return null
    const firstChildEnd = contentStart + firstChild.nodeSize
    const listItemEnd = contentStart + node.content.size
    if (firstChildEnd >= listItemEnd) return null
    return [firstChildEnd, listItemEnd]
  }

  return null
}

/** 找 doc.children 里 pos 落在哪个 child 上。pos = child 起始 pos(open token 处)。
 *  -1 表示没找到(pos 在嵌套容器里 / 非法)。 */
function findDocChildIndex(doc: PMNode, pos: number): number {
  let p = 0
  for (let i = 0; i < doc.childCount; i++) {
    if (p === pos) return i
    p += doc.child(i).nodeSize
  }
  return -1
}

/** 算 doc 第 i 个 child 的起始 pos。 */
function childStartPos(doc: PMNode, i: number): number {
  let p = 0
  for (let k = 0; k < i; k++) p += doc.child(k).nodeSize
  return p
}

/** 深度遍历 [from, to) 区间内的 block 节点,**只**对完全在区间内的节点
 *  调 callback(节点 pos ≥ from 且 pos + nodeSize ≤ to)。
 *
 *  与 PM `nodesBetween` 的区别:nodesBetween 会访问跨越 from-to 的
 *  ancestor(例:list_item 内部 fold,nodesBetween 会把外层 bullet_list
 *  / list_item 也算进回调),我们这里要的是"完全在 fold range 内的
 *  block"——外层容器不能挂 velo-folded,否则整段都 display:none。
 */
function visitBlocksInRange(
  doc: PMNode,
  from: number,
  to: number,
  cb: (n: PMNode, pos: number) => void,
) {
  let cursor = from
  while (cursor < to) {
    const $pos = doc.resolve(cursor)
    const parent = $pos.parent
    // 找 parent 的直接子节点中从 cursor 开始的那个
    const index = $pos.index($pos.depth)
    if (index >= parent.childCount) break
    const child = parent.child(index)
    const childStart = cursor
    const childEnd = cursor + child.nodeSize
    if (child.isBlock && childStart >= from && childEnd <= to) {
      cb(child, childStart)
    }
    // 跳到 child 末尾之后(无论 child 是否被 cb 处理)
    cursor = childEnd
  }
}

// ============================================================
//  Widget 工厂
// ============================================================

let currentView: EditorView | null = null

function makeToggleWidget(
  isCollapsed: boolean,
  stableKey: string,
  contentStart: number,
): HTMLElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'velo-fold-toggle'
  // contentEditable=false:PM 不接管按钮,keydown 不会从按钮发到 PM
  btn.contentEditable = 'false'
  btn.setAttribute('data-fold-key', stableKey)
  // data-fold-cs:contentStart,syncToggleState 据此查 collapsedSet 同步属性
  btn.dataset.foldCs = String(contentStart)
  btn.setAttribute('data-fold-state', isCollapsed ? 'collapsed' : 'expanded')
  const title = isCollapsed ? '展开' : '折叠'
  btn.title = title
  btn.setAttribute('aria-label', title)
  // 始终用 chevron-down(▼),旋转靠 CSS `transform: rotate(-90deg)` 实现
  // —— 单一图标 + CSS 旋转 = 平滑动画 + 视觉一致
  btn.innerHTML = chevronDownSvg(16)
  btn.addEventListener('mousedown', (e) => {
    // 抢在 PM 之前吞掉 mousedown —— 防止光标被推到 widget 之后
    e.preventDefault()
    e.stopPropagation()
  })
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const view = currentView
    if (!view || view.isDestroyed) return
    // **关键 1**:PM widget 在 key 不变时复用旧 DOM element,factory 不再
    // 被调,闭包里的 `isCollapsed` 永远是初值 → 第二次点击 `!isCollapsed`
    // 算的是初值的反,看起来"点不动"。修法:从 `view.state` 的 plugin
    // collapsedSet 读**真实当前** fold state(每次点击都现读,不被闭包
    // 锁住)。
    // **关键 2**:click 立即翻 attribute(给 CSS transition 用),再 dispatch
    // meta。PM widget 因 key 不变会复用旧 DOM,attribute 变化 → CSS
    // transition 播放 rotate 0 ↔ -90deg。
    const s = foldKey.getState(view.state)
    const currentlyCollapsed = s ? s.collapsedSet.has(contentStart) : isCollapsed
    const nextCollapsed = !currentlyCollapsed
    btn.setAttribute('data-fold-state', nextCollapsed ? 'collapsed' : 'expanded')
    btn.title = nextCollapsed ? '展开' : '折叠'
    btn.setAttribute('aria-label', btn.title)
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: contentStart }))
  })
  return btn
}

/** 同步所有 toggle 按钮的 data-fold-state 属性。toggle widget key 不含折叠状态,
 *  PM 复用旧 DOM → factory 不重跑 → handleClickOn(点 `...` 展开)路径下属性不更新。
 *  每帧 view.update 跑一次,按 collapsedSet 统一同步。 */
function syncToggleState(view: EditorView, s: FoldState) {
  const toggles = view.dom.querySelectorAll<HTMLElement>('.velo-fold-toggle')
  toggles.forEach((el) => {
    const cs = Number(el.dataset.foldCs)
    if (!cs) return
    const isCollapsed = s.collapsedSet.has(cs)
    el.setAttribute('data-fold-state', isCollapsed ? 'collapsed' : 'expanded')
    el.title = isCollapsed ? '展开' : '折叠'
    el.setAttribute('aria-label', el.title)
  })
}

// ============================================================
//  Build decorations
// ============================================================

function buildDecorations(state: EditorState, deco: FoldState): DecorationSet {
  const decos: Decoration[] = []
  const scan = scanDoc(state.doc)

  for (const { node, pos } of scan.frontmatters) {
    addFrontmatterDecos(node, pos, deco, decos)
  }
  for (const { node, pos } of scan.headings) {
    addHeadingDecos(state.doc, node, pos, deco, decos)
  }
  for (const { node, pos } of scan.listItems) {
    addListItemDecos(state.doc, node, pos, deco, decos)
  }
  for (const { node, pos } of scan.codeBlocks) {
    addCodeBlockDecos(node, pos, deco, decos)
  }

  // v0.7.2:fold_placeholder 节点在非空选区内时挂 is-selected 高亮
  // (真实节点 contentEditable=false,浏览器原生选区蓝底不覆盖它,
  // 用 Decoration.node 自绘蓝底对齐 ::selection)
  const sel = state.selection
  if (!sel.empty) {
    for (const { node, pos } of scan.foldPlaceholders) {
      if (pos >= sel.from && pos + node.nodeSize <= sel.to) {
        decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'is-selected' }))
      }
    }
  }

  return DecorationSet.create(state.doc, decos)
}

function addHeadingDecos(
  doc: PMNode,
  node: PMNode,
  pos: number,
  deco: FoldState,
  decos: Decoration[],
) {
  // heading 折叠要求"有可折叠的后续内容" —— 简单判定:不空 + 有 siblings
  if (node.content.size === 0) return
  const contentStart = pos + 1
  // heading 是顶级 block(在 doc 直下或 blockquote 内),不过我们折叠只看
  // 它的直接后续 sibling。computeFoldRange 自己会走到下一个同/高 level heading
  // 或 doc 末尾。
  const isCollapsed = deco.collapsedSet.has(contentStart)
  const stableKey = makeStableKey(node)
  if (!stableKey) return

  // toggle 按钮:必须用 inline 位置(pos+1) + side:-1 才能成为 heading 的
  // inline child(side:1 / 0 在 block 边界会被 PM 渲染为 block 级兄弟元素,
  // 视觉上"另起一行"在 heading 之前 —— 用户已反馈)。side:-1 在第一个 inline
  // 位置 = 紧贴 open token 之后,是真正的"块内首字符位置"。
  decos.push(
    Decoration.widget(pos + 1, () => {
      return makeToggleWidget(isCollapsed, stableKey, contentStart)
    }, {
      key: `fold-toggle:${contentStart}:${stableKey}`,
      ignoreSelection: true,
      side: -1,
    }),
  )

  if (!isCollapsed) return

  const range = computeFoldRange(node, contentStart, doc)
  if (!range) return
  // 折叠区段首部 placeholder + 区段内每个 block 挂 hidden class
  applyFoldRange(doc, range, contentStart, decos)
}

function addListItemDecos(
  doc: PMNode,
  node: PMNode,
  pos: number,
  deco: FoldState,
  decos: Decoration[],
) {
  // list_item 折叠要求"首段之后有 block 子项",否则没东西可折
  if (!node.firstChild) return
  if (node.childCount <= 1) return
  const contentStart = pos + 1
  const isCollapsed = deco.collapsedSet.has(contentStart)
  const stableKey = makeStableKey(node)
  if (!stableKey) return

  // toggle:list_item 内首段首个 inline 位置 = 与首段文本同行的最左侧
  // (list_item 必填首子是 paragraph;pos+1 是 paragraph 的 open token,
  //  pos+2 才是 paragraph 内首个 inline 位置。side:-1 让 widget 紧贴
  //  paragraph open token 之后,成为 paragraph 内的 inline child,视觉上
  //  与首段文本同在一行 —— 用绝对定位推到 bullet 左侧 gutter)
  decos.push(
    Decoration.widget(pos + 2, () => makeToggleWidget(isCollapsed, stableKey, contentStart), {
      key: `fold-toggle:${contentStart}:${stableKey}`,
      ignoreSelection: true,
      side: -1,
    }),
  )

  if (!isCollapsed) return
  const range = computeFoldRange(node, contentStart, doc)
  if (!range) return
  applyFoldRange(doc, range, contentStart, decos)
}

function addCodeBlockDecos(
  node: PMNode,
  pos: number,
  deco: FoldState,
  decos: Decoration[],
) {
  // code_block 折叠:折叠自身(pre 整块 display:none)。
  // toggle 由 CodeHighlightWidget 的 header 提供(chevron),不需要本 plugin 挂。
  // 不需要 placeholder(header 即摘要)。
  const contentStart = pos + 1
  const isCollapsed = deco.collapsedSet.has(contentStart)
  if (!isCollapsed) return
  // 折叠态:pre 整块挂 velo-folded → display:none
  decos.push(
    Decoration.node(pos, pos + node.nodeSize, { class: 'velo-folded' }, {
      selectable: false,
    }),
  )
}

/**
 * frontmatter 折叠渲染钩子(空实现):折叠**视觉层**由 FrontmatterNodeView 的
 * `update()` 自管(dom.classList.toggle('is-collapsed', ...)),本函数仅作
 * 类型钩子保留,让 buildDecorations 的 frontmatter 分支可以无遗漏地走到。
 *
 * 为什么不走 Decoration.node:
 *   frontmatter schema content 是 'text*'(纯文本,无块子),外层由 NodeView 原子
 *   渲染。Decoration.node 要么装饰整个 NodeView wrapper(整个 header+pre
 *   一起被 velo-folded display:none,不符合"保留 header"的设计),要么因
 *   找不到对应 DOM 节点被 PM 静默丢弃。故视觉折叠由 NodeView 自管。
 *
 * foldDecoration 仍集中管理折叠状态(collapsedSet + stableKey + tr.mapping
 * 跟住 + ensureFoldExpandedAt 白名单 + file 切换灌入),本函数不做装饰推送。
 */
function addFrontmatterDecos(
  _node: PMNode,
  _pos: number,
  _deco: FoldState,
  _decos: Decoration[],
) {
  // 视觉折叠由 FrontmatterNodeView.update() 通过 dom.classList 自管
}

function applyFoldRange(
  doc: PMNode,
  range: [number, number],
  _triggerPos: number,
  decos: Decoration[],
) {
  // 把 fold 区段内的每个 block 整块 `display: none`。
  // **关键**:`doc.nodesBetween(from, to)` 会访问**跨越 from-to 的
  // ancestor 节点**(PM 默认行为:遍历所有与范围相交的节点,包括外层
  // 容器)。如果 list_item 折叠,fold range 在 list_item 内部,nodesBetween
  // 会同时给外层 bullet_list / list_item 也挂 velo-folded → display:none,
  // 整个外层 list 消失 —— 用户报"折叠把整个 list 都弄消失"。
  //
  // 修法:手动深度遍历,只对**完全在 fold range 内**的 block 挂
  // velo-folded:`p >= range[0] && p + n.nodeSize <= range[1]`。
  // 这样外层 bullet_list / list_item(跨越 fold range)不会被挂,只挂
  // fold range 内的 block(nested bullet_list / nested list_item / paragraph
  // 等)。
  visitBlocksInRange(doc, range[0], range[1], (n, p) => {
    decos.push(Decoration.node(p, p + n.nodeSize, { class: 'velo-folded' }, {
      // selectable: false 阻止 fold 区段被 NodeSelection / 鼠标 drag 选中
      // PM 内部仍按 doc 位置走,键盘 navigation 仍可越过(v1 接受)
      selectable: false,
    }))
  })
  // v0.7.2:placeholder 不再是 Decoration.widget,而是真实 fold_placeholder
  // 节点,由 appendTransaction 在折叠时插入到 range[0]-1 位置。
  // 真实节点光标可停两侧、可被 TextSelection 划选,彻底解决 widget 的
  // side 限制(光标只能停一侧)和选区覆盖问题。
}

// ============================================================
//  Plugin
// ============================================================

/**
 * Plugin state apply。
 *  - setMeta `initCollapsed: number[]` → 覆盖整个 set(file 切换 / 启动时灌入)
 *  - setMeta `toggle: number` → 单点 toggle
 *  - setMeta `remove: number[]`(v0.7.2)→ 从 set 批量移除(选区删除折叠内容时
 *    清理折叠点,避免部分选中 heading 后留下指向已删内容的 stale 折叠)
 *  - docChanged → tr.mapping.map(pos, -1) 跟住,失效 pos 丢
 */
const foldDecoPlugin = new Plugin<FoldState>({
  key: foldKey,
  state: {
    init: () => initialState(),
    apply(tr, prev, _oldState, newState) {
      const meta = tr.getMeta(foldKey) as
        | { initCollapsed?: number[], toggle?: number, remove?: number[] }
        | undefined
      // selection-only:如果文档中有 fold_placeholder,is-selected 高亮依赖选区,需重建;
      // 没有 fold_placeholder 时可以安全跳过(返回同一引用)。
      if (!meta && !tr.docChanged) {
        // viewport 变化:fold 始终全量(velo-folded 不能因滚出视口而丢失),跳过重建
        if (tr.getMeta(viewportKey)) return prev
        if (scanDoc(tr.doc).foldPlaceholders.length === 0) return prev
        // 有 fold_placeholder:需要重建(选区变化影响 is-selected)
        return { ...prev, decoSet: null }
      }
      let collapsedSet = prev.collapsedSet
      let setMutated = false
      if (meta?.initCollapsed) {
        collapsedSet = new Set(meta.initCollapsed)
        setMutated = true
      }
      else if (typeof meta?.toggle === 'number') {
        const next = new Set(prev.collapsedSet)
        if (next.has(meta.toggle)) next.delete(meta.toggle)
        else next.add(meta.toggle)
        collapsedSet = next
        setMutated = true
      }
      // v0.7.2:批量移除折叠点(选区删除折叠内容时清理 stale 折叠)
      else if (meta?.remove && meta.remove.length > 0) {
        const next = new Set(prev.collapsedSet)
        for (const r of meta.remove) next.delete(r)
        if (next.size !== prev.collapsedSet.size) {
          collapsedSet = next
          setMutated = true
        }
      }
      // doc 变化跟住折叠点(用 assoc=-1 防止 contentStart 在 insertText
      // 之后跑到文本末尾 —— mermaid 同坑)
      if (tr.docChanged && collapsedSet.size > 0) {
        const mapped = new Set<number>()
        for (const pos of collapsedSet) {
          const m = tr.mapping.map(pos, -1)
          if (m == null) continue
          // **深度处理**:折叠点落到 doc 起点(deleted block 后剩 0,或 fold
          // trigger 被删除),`$pos.before($pos.depth)` 会抛
          // "no position before top-level node"。直接丢(折叠点失效)。
          if (m <= 0) continue
          const $pos = newState.doc.resolve(m)
          if ($pos.depth === 0) continue
          // 折叠点失效(node 已被删 / node 类型变了)→ 丢
          const node = newState.doc.nodeAt($pos.before($pos.depth))
          if (!node) continue
          if (isFoldable(node)) {
            mapped.add(m)
          }
        }
        collapsedSet = mapped
        setMutated = true
      }
      // **同步模块级折叠 → code_block 集合**(给 codeLineNumberPlugin
      // 读用)。必须在 apply 阶段跑 —— PM 渲染顺序是 reducer chain →
      // plugin.decorations(state) → DOM 渲染 → view.update(view),
      // lineNumberPlugin.decorations 要看到最新 set 才能在 fold 区段
      // 内的 code_block 上跳过 gutter widget(否则 pre 被 display:none
      // 时 gutter 飞到 (0,0);展开帧 stale set 仍带本折叠的 code_block,
      // gutter 被误跳,行号消失)。
      if (setMutated || tr.docChanged) {
        recomputeFoldedCodeBlockPos(newState.doc, collapsedSet)
      }

      // meta(initCollapsed / toggle / remove / nodeSync)→ 全量重建
      if (meta) {
        return { collapsedSet, decoSet: null }
      }

      // docChanged only → 增量更新
      if (!prev.decoSet) {
        return { collapsedSet, decoSet: null }
      }

      // 检查 dirty range 是否落在折叠区段内,或折叠触发点是否在 dirty range 内。
      // 这两种情况需要全量重建(fold range 可能已变化,增量无法保证正确性)。
      const dirtyRanges: Array<{ from: number; to: number }> = []
      for (const step of tr.steps) {
        step.getMap().forEach((_os, _oe, ns, ne) => {
          dirtyRanges.push({ from: ns, to: ne })
        })
      }

      let needsFullRebuild = false
      for (const triggerContentStart of collapsedSet) {
        const triggerPos = triggerContentStart - 1
        if (triggerPos < 0 || triggerPos >= newState.doc.content.size) continue

        // 折叠触发点在 dirty range 内 → 全量重建
        for (const dr of dirtyRanges) {
          if (triggerPos >= dr.from && triggerPos < dr.to) {
            needsFullRebuild = true
            break
          }
        }
        if (needsFullRebuild) break

        // dirty range 落在折叠区段内 → 全量重建
        const triggerNode = newState.doc.resolve(triggerContentStart).parent
        if (triggerNode.type.name === 'heading' || triggerNode.type.name === 'list_item') {
          const blockNode = newState.doc.nodeAt(triggerPos)
          if (!blockNode) continue
          const range = computeFoldRange(blockNode, triggerContentStart, newState.doc)
          if (!range) continue
          for (const dr of dirtyRanges) {
            if (dr.from >= range[0] && dr.to <= range[1]) {
              needsFullRebuild = true
              break
            }
          }
          if (needsFullRebuild) break
        }
      }

      if (needsFullRebuild) {
        return { collapsedSet, decoSet: null }
      }

      // 增量:map 旧 set → 只重建 dirty range 内 heading / list_item 的 toggle widget。
      // 折叠触发点不在 dirty range 内(上面已检查),所以 addHeadingDecos /
      // addListItemDecos 对这些节点只加 toggle widget(isCollapsed=false 时不
      // 调 applyFoldRange),不会产生重复 velo-folded。
      let newSet = prev.decoSet.map(tr.mapping, tr.doc)
      const scan = scanDoc(tr.doc)

      const affectedHeadings: Array<{ pos: number; node: PMNode }> = []
      const affectedListItems: Array<{ pos: number; node: PMNode }> = []
      for (const dr of dirtyRanges) {
        for (const { node, pos } of scan.headings) {
          if (pos + node.nodeSize >= dr.from && pos <= dr.to) {
            if (!affectedHeadings.some(a => a.pos === pos)) affectedHeadings.push({ pos, node })
          }
        }
        for (const { node, pos } of scan.listItems) {
          if (pos + node.nodeSize >= dr.from && pos <= dr.to) {
            if (!affectedListItems.some(a => a.pos === pos)) affectedListItems.push({ pos, node })
          }
        }
      }

      if (affectedHeadings.length === 0 && affectedListItems.length === 0) {
        return { collapsedSet, decoSet: newSet }
      }

      // 移除受影响节点的旧 decoration,重建
      for (const { pos, node } of [...affectedHeadings, ...affectedListItems]) {
        const found = newSet.find(pos, pos + node.nodeSize)
        newSet = newSet.remove(found)
      }
      const newDecos: Decoration[] = []
      const foldState: FoldState = { collapsedSet, decoSet: null }
      for (const { node, pos } of affectedHeadings) {
        addHeadingDecos(newState.doc, node, pos, foldState, newDecos)
      }
      for (const { node, pos } of affectedListItems) {
        addListItemDecos(newState.doc, node, pos, foldState, newDecos)
      }
      if (newDecos.length > 0) {
        newSet = newSet.add(tr.doc, newDecos)
      }

      return { collapsedSet, decoSet: newSet }
    },
  },
  props: {
    decorations(state) {
      const s = foldKey.getState(state)
      if (!s) return null
      if (!s.decoSet) {
        return buildDecorations(state, s)
      }
      return s.decoSet
    },
    // v0.7.2:点击 fold_placeholder 节点 → 展开(与 chevron toggle 等效)
    handleClickOn(view, _pos, node, nodePos, _event, _direct) {
      if (node.type.name !== 'fold_placeholder') return false
      // 拖选结束后 click 也会触发 —— 只在选区为空(纯点击)时展开
      if (!view.state.selection.empty) return false
      const $pos = view.state.doc.resolve(nodePos)
      for (let depth = $pos.depth; depth > 0; depth--) {
        const ancestor = $pos.node(depth)
        if (isFoldable(ancestor)) {
          const contentStart = $pos.start(depth)
          view.dispatch(view.state.tr.setMeta(foldKey, { toggle: contentStart }))
          return true
        }
      }
      return false
    },
  },
  // v0.7.2:appendTransaction 同步 fold_placeholder 真实节点与 collapsedSet。
  // 折叠(toggle / initCollapsed)→ 插入节点;展开 → 删除节点。
  // 用 nodeSync meta 防无限循环(自己的 transaction 不再触发)。
  appendTransaction(trs, _oldState, newState) {
    const lastTr = trs[trs.length - 1]
    if (lastTr.getMeta(foldKey)?.nodeSync) return null

    const s = foldKey.getState(newState)
    if (!s) return null
    const set = s.collapsedSet
    const doc = newState.doc

    // 扫描 fold_placeholder 节点,找到其父 foldable 的 contentStart
    const placeholders = new Map<number, number>() // contentStart → pos
    const orphaned: number[] = []
    for (const { pos } of scanDoc(doc).foldPlaceholders) {
      const $pos = doc.resolve(pos)
      let found = false
      for (let depth = $pos.depth; depth > 0; depth--) {
        const ancestor = $pos.node(depth)
        if (isFoldable(ancestor)) {
          placeholders.set($pos.start(depth), pos)
          found = true
          break
        }
      }
      if (!found) orphaned.push(pos)
    }

    // 检查是否已同步
    const setArr = [...set].sort((a, b) => a - b)
    const phArr = [...placeholders.keys()].sort((a, b) => a - b)
    const inSync = setArr.length === phArr.length && setArr.every((v, i) => v === phArr[i])
    if (inSync && orphaned.length === 0) return null

    const tr = newState.tr
    let modified = false

    // 删除孤儿节点(foldable 父节点已不存在,如 heading→paragraph)
    for (const pos of orphaned.sort((a, b) => b - a)) {
      tr.delete(pos, pos + 1)
      modified = true
    }
    // 删除不在 set 中的 placeholder(逆序删以保持位置)
    const toRemove = [...placeholders.entries()]
      .filter(([cs]) => !set.has(cs))
      .sort((a, b) => b[1] - a[1])
    for (const [, pos] of toRemove) {
      tr.delete(pos, pos + 1)
      modified = true
    }
    // 插入 set 中没有 placeholder 的折叠点(逆序插以保持位置)
    const toInsert = [...set]
      .filter(cs => !placeholders.has(cs))
      .sort((a, b) => b - a)
    for (const contentStart of toInsert) {
      const node = doc.nodeAt(contentStart - 1)
      if (!node) continue
      // code_block / frontmatter 不需要 placeholder(header 即摘要)
      if (node.type.name !== 'heading' && node.type.name !== 'list_item') continue
      const range = computeFoldRange(node, contentStart, doc)
      if (!range) continue
      tr.insert(range[0] - 1, schema.nodes.fold_placeholder.create())
      modified = true
    }

    if (!modified) return null
    tr.setMeta(foldKey, { nodeSync: true })
    tr.setMeta('addToHistory', false)
    return tr
  },
  view: (view) => {
    currentView = view
    // 折叠集 diff 同步到 store:每次 state.apply 后比 prevCollapsed,新加
    // 的 pos 写 store.setKey(path, key, true),移除的 pos 写 setKey(_, _, false)。
    // 这样不管折叠由 user 手动 toggle / doc 变化 tr.mapping 跟住 / file 切换
    // 灌入 哪条路径触发,store 始终保持最新稳定 key 集合 —— 关掉应用也
    // 不丢(配合 App.vue watch → debounceSave 落盘)。
    let prevCollapsed = new Set<number>()
    return {
      update(updatedView) {
        if (updatedView.isDestroyed) return
        const s = foldKey.getState(updatedView.state)
        if (!s) return
        // 同步 toggle 按钮的 data-fold-state 属性:toggle widget key 不含折叠状态,
        // PM 复用旧 DOM → factory 不重跑 → 属性停在初值。handleClickOn(点 `...` 展开)
        // 只 dispatch toggle meta,不像 chevron click handler 那样手动 setAttribute。
        // 这里统一同步:每帧扫描所有 toggle,按 collapsedSet 更新属性 + title。
        syncToggleState(updatedView, s)
        // 切标签守卫:view.updateState(cachedState) 整体替换 state,prevCollapsed
        // 仍持有上一个标签的折叠 pos。检测到越界 pos 时说明是跨标签 state swap,
        // 直接重置 prevCollapsed 并跳过 diff(避免拿旧标签 pos 在新标签 doc 上
        // 算 stable key → 误写 store / crash)。
        if (prevCollapsed.size > 0) {
          const docSize = updatedView.state.doc.content.size
          let stale = false
          for (const pos of prevCollapsed) {
            if (pos < 0 || pos > docSize) { stale = true; break }
          }
          if (stale) {
            prevCollapsed = new Set(s.collapsedSet)
            return
          }
        }
        // 同步 store:只在 collapsedSet 实际变化时跑
        if (
          s.collapsedSet.size === prevCollapsed.size
          && Array.from(s.collapsedSet).every(p => prevCollapsed.has(p))
        ) {
          return
        }
        // lazy 取 store:pinia 必须在 component setup 后才活跃
        let foldStore
        let filePath: string | null = null
        try {
          foldStore = useFoldStore()
          filePath = useDocumentStore().currentFilePath
        }
        catch {
          return // pinia 还没好 / dev web 端,本帧同步放弃
        }
        if (!foldStore || !filePath) {
          prevCollapsed = new Set(s.collapsedSet)
          return
        }
        // diff 应用到 store
        for (const pos of prevCollapsed) {
          if (!s.collapsedSet.has(pos)) {
            const key = makeStableKeyForPos(updatedView.state.doc, pos)
            if (key) foldStore.setKey(filePath, key, false)
          }
        }
        for (const pos of s.collapsedSet) {
          if (!prevCollapsed.has(pos)) {
            const key = makeStableKeyForPos(updatedView.state.doc, pos)
            if (key) foldStore.setKey(filePath, key, true)
          }
        }
        prevCollapsed = new Set(s.collapsedSet)
        // foldedCodeBlockPosSet 的同步已挪到 apply 阶段(见 apply
        // 末尾)—— view.update 太晚,lineNumberPlugin.decorations 已经
        // 按 stale set 渲染,gutter 飞左上角 / 展开后不重现。
      },
      destroy() {
        if (currentView === view) currentView = null
      },
    }
  },
})

export const foldDecoration = foldDecoPlugin

// ============================================================
//  Auto-expand helper(给 findreplace 等用)
// ============================================================

/**
 * 搜索命中折叠区段时,幂等展开。
 * mirror mermaid 的 `ensureMermaidSourceVisibleAt`:返回 true 表示"展开过",
 * false 表示"无折叠 / 已展开",调用方据此决定要不要 scrollIntoView。
 *
 * pos 任意 doc 位置,resolve 到最近的 heading / list_item / code_block
 * 祖先节点;若该节点处于折叠态 → setMeta(toggle) 展开。
 */
export function ensureFoldExpandedAt(view: EditorView, pos: number): boolean {
  if (view.isDestroyed) return false
  const $pos = view.state.doc.resolve(pos)
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth)
    if (!isFoldable(node)) {
      continue
    }
    const start = $pos.start(depth)
    const s = foldKey.getState(view.state)
    if (!s) return false
    if (!s.collapsedSet.has(start)) return false
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: start }))
    return true
  }
  return false
}

// ============================================================
//  Exposed helpers(给 EditorInner / 测试用)
// ============================================================

/** 收集 doc 里所有 foldable node(contentStart, stableKey)对,用于把
 *  store 里的稳定 key 翻译成当前 doc 的 contentStart。 */
export function collectFoldableKeys(
  doc: PMNode,
): Array<{ contentStart: number, stableKey: string, type: string }> {
  const out: Array<{ contentStart: number, stableKey: string, type: string }> = []
  const scan = scanDoc(doc)
  for (const { node, pos } of scan.frontmatters) {
    const key = makeStableKey(node)
    if (key) out.push({ contentStart: pos + 1, stableKey: key, type: 'frontmatter' })
  }
  for (const { node, pos } of scan.headings) {
    if (node.content.size > 0) {
      const key = makeStableKey(node)
      if (key) out.push({ contentStart: pos + 1, stableKey: key, type: 'heading' })
    }
  }
  for (const { node, pos } of scan.listItems) {
    if (node.childCount > 1 && node.firstChild) {
      const key = makeStableKey(node)
      if (key) out.push({ contentStart: pos + 1, stableKey: key, type: 'list_item' })
    }
  }
  for (const { node, pos } of scan.codeBlocks) {
    const key = makeStableKey(node)
    if (key) out.push({ contentStart: pos + 1, stableKey: key, type: 'code_block' })
  }
  return out
}

// ============================================================
//  foldDeleteCommand(给 EditorInner keymap 链首用)
// ============================================================

/**
 * v0.7.2:选区覆盖 fold_placeholder 节点时,把删除范围扩展到折叠节点起点 ~
 * range[1](整块删除),并从 collapsedSet 移除该折叠点。
 *
 * 排在 Backspace/Delete keymap 链首,先于 baseKeymap['Backspace'] 执行。
 * 不覆盖任何 fold_placeholder → return false,走正常删除链。
 *
 * deleteFrom 扩展到 contentStart-1(折叠节点起点):若从 sel.from 删会留
 * heading open token 碎片,PM replace 会把它和下一个 heading 合并,吞掉
 * 下一个 heading —— 用户报"下一行被删"。
 */
export function foldDeleteCommand(
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const s = foldKey.getState(state)
  if (!s || s.collapsedSet.size === 0) return false
  const sel = state.selection
  if (sel.empty) return false

  const doc = state.doc
  let deleteFrom = sel.from
  let deleteEnd = sel.to
  const toRemove: number[] = []

  doc.nodesBetween(sel.from, sel.to, (node, pos) => {
    if (node.type.name !== 'fold_placeholder') return
    // 找到 fold_placeholder 的父 foldable 节点
    const $pos = doc.resolve(pos)
    for (let depth = $pos.depth; depth > 0; depth--) {
      const ancestor = $pos.node(depth)
      if (isFoldable(ancestor)) {
        const contentStart = $pos.start(depth)
        const range = computeFoldRange(ancestor, contentStart, doc)
        if (range) {
          const nodeStart = contentStart - 1
          if (nodeStart < deleteFrom) deleteFrom = nodeStart
          if (range[1] > deleteEnd) deleteEnd = range[1]
          if (!toRemove.includes(contentStart)) toRemove.push(contentStart)
        }
        break
      }
    }
  })

  if (toRemove.length === 0) return false

  if (dispatch) {
    dispatch(state.tr.delete(deleteFrom, deleteEnd).setMeta(foldKey, { remove: toRemove }))
  }
  return true
}
