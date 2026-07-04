// 块级折叠(heading / list_item)—— v0.5.12。
// 暂不折叠 code_block(mermaid / 普通代码块折叠的视觉放在 `<pre>` 左上角
// 工具条附近,跟 toolbar 几何冲突难以分清,先 ship 两类再回头补)。
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
//     list_item 的 contentStart)。`tr.mapping.map(pos, -1)` 跟住 doc 变化
//     (mermaid 同坑,见 MermaidDecoration.ts apply 注释)。
//  3. **稳定 key 持久化**。doc pos 关闭文件后失效,store 存的是由 block
//     类型 + 内容指纹派生的字符串(见 makeStableKey)。换文件 / 重开 →
//     EditorInner 把 store keys → 当前位置,walk doc 翻译回 Set<number>。
//  4. **toggle 按钮永远渲染**。collapsed / expanded 共用同一个 widget,
//     切到 expanded 时变 chevron-down,collapsed 时变 chevron-right。
//  5. **placeholder widget** 极简,只是灰色 `...`,挂 fold 区段首部
//     side:-1 上一可见 block 末尾,点击展开。
//  6. **list_item 仅在含 block 子项时折叠**(`content: 'paragraph block*'`,
//     折叠 = 首段之后的 block 子项)。无子项 → 不挂 toggle,避免对纯叶子
//     列表项加冗余按钮。
//  7. **selectable: false**。folded 区段不可被节点选中 / 鼠标拖蓝选中,
//     防止从 folded 块外选进 hidden 文本;键盘箭头仍可越过 hidden 文本
//     (PM 不知 CSS display,见下面"维护者注意点"一节;v1 接受)。
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
import type { EditorState } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { chevronDownSvg } from '@/components/icons/widgetIcons'
import { useFoldStore } from '@/stores/folding'
import { useDocumentStore } from '@/stores/document'
// useFoldStore / useDocumentStore 在 view factory 内 lazy 调用 —— 模块顶层
// 调 pinia 还没就绪,view factory 跑时已经在 component context 内。

// ============================================================
//  Plugin state
// ============================================================

export interface FoldState {
  /** 折叠点绝对 pos(contentStart)集合 —— heading / list_item / code_block
   *  这三类节点折叠时,各自的 contentStart 落进 set。 */
  collapsedSet: Set<number>
}

function initialState(): FoldState {
  return { collapsedSet: new Set() }
}

export const foldKey = new PluginKey<FoldState>('foldDecoration')

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

/** 公开:codeLineNumberPlugin 调,判断本 code_block 是否处于 fold 范围内。 */
export function isCodeBlockFolded(codeBlockPos: number): boolean {
  return foldedCodeBlockPosSet.has(codeBlockPos)
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

/** 从 state 算当前所有 fold 范围内 code_block / mermaid 节点 pos,更新
 *  module-level sets。 */
function recomputeFoldedCodeBlockPos(doc: PMNode, collapsedSet: Set<number>) {
  const nextCode = new Set<number>()
  const nextMermaid = new Set<number>()
  for (const triggerContentStart of collapsedSet) {
    // triggerContentStart 是 heading/list_item 的 contentStart,需要
    // 反推 trigger 节点本身(查 doc 找 contentStart 之前的 block)。
    const triggerNode = doc.resolve(triggerContentStart).parent
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
      if (n.type.name !== 'code_block' || p < 0 || p >= doc.content.size) return
      nextCode.add(p)
      const lang = (n.attrs.language as string) || ''
      if (lang === 'mermaid') nextMermaid.add(p)
    })
  }
  foldedCodeBlockPosSet = nextCode
  foldedMermaidPosSet = nextMermaid
}

// ============================================================
//  稳定 key(持久化用)
// ============================================================

const KEY_PREFIX_HEADING = 'h'
const KEY_PREFIX_LI = 'li'
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
  const text = (() => {
    if (node.type.name === 'heading') return node.textContent || ''
    if (node.type.name === 'list_item') {
      // list_item 首子是 paragraph(必填,见 schema),折叠 key 跟首段挂钩
      return node.firstChild?.textContent || ''
    }
    return ''
  })().trim().replace(/\s+/g, ' ').slice(0, KEY_TEXT_LIMIT)

  if (node.type.name === 'heading') {
    return `${KEY_PREFIX_HEADING}${node.attrs.level as number}:${text}`
  }
  if (node.type.name === 'list_item') {
    return `${KEY_PREFIX_LI}:${text}`
  }
  return ''
}

/**
 * 给定 doc + contentStart,返回该位置对应 block 的稳定 key。
 * 用于 plugin view hook 把折叠 pos → stable key 写回 store。
 * pos 无效或对应节点不是 foldable → 返回 ''(caller 跳过)。
 */
function makeStableKeyForPos(doc: PMNode, pos: number): string {
  const node = doc.nodeAt(pos)
  if (!node) return ''
  if (
    node.type.name === 'heading'
    || node.type.name === 'list_item'
  ) {
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

function makePlaceholderWidget(
  range: [number, number],
  triggerPos: number,
  stableKey: string,
): HTMLElement {
  // 极简:一个 `...`,点击展开。挂在 fold 区段首部 side:-1 的 inline 位置,
  // 视觉上接在 trigger block(heading / list_item 首段)末尾同一行。
  const wrap = document.createElement('span')
  wrap.className = 'velo-fold-placeholder'
  wrap.contentEditable = 'false'
  wrap.textContent = '...'
  wrap.title = '展开'
  wrap.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  wrap.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const view = currentView
    if (!view || view.isDestroyed) return
    // **手动同步 toggle button**:PM toggle widget key 不依赖折叠状态
    // (`fold-toggle:${contentStart}:${stableKey}` 不含 collapsed/expanded),
    // collapsed↔expanded 时 PM 复用同一个 button DOM,factory 不重跑,
    // `data-fold-state` 不会自动翻 —— 不手动同步,展开后按钮仍停在
    // collapsed 视觉,chevron 不旋转。手动 setAttribute 让 CSS transition
    // 看到属性变化,触发 0 ↔ -90deg 平滑动画。
    // 这里总是展开(`isCollapsed = false`),因为 placeholder 仅在折叠态可见。
    syncToggleButton(view, stableKey, false)
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: triggerPos }))
    // scrollIntoView 到折叠区段起点
    try {
      const dom = view.nodeDOM(range[0]) as HTMLElement | null
      if (dom) dom.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    catch { /* swallow */ }
  })
  return wrap
}

/** 反查 view.dom 里对应 stableKey 的 toggle button。 */
function findToggleByKey(view: EditorView, stableKey: string): HTMLElement | null {
  // 不走 CSS attribute selector —— stableKey 是用户文本 + 类型/level,
  // 可能含 `"` `\` 字符,直接拼进选择器会破坏 selector。改用
  // querySelectorAll + JS 字符串比对,O(N) 代价可接受(N = 当前 doc 中
  // foldable block 数,典型 < 100)。
  const candidates = view.dom.querySelectorAll<HTMLElement>('.velo-fold-toggle[data-fold-key]')
  for (const el of candidates) {
    if (el.getAttribute('data-fold-key') === stableKey) return el
  }
  return null
}

/** 手动翻 toggle button 的 `data-fold-state`,触发 CSS transition 旋转。
 *  仅在 key 不变、PM 复用 DOM 的场景用(placeholder 展开路径)。 */
function syncToggleButton(
  view: EditorView,
  stableKey: string,
  isCollapsed: boolean,
): void {
  const el = findToggleByKey(view, stableKey)
  if (!el) return
  const title = isCollapsed ? '展开' : '折叠'
  el.setAttribute('data-fold-state', isCollapsed ? 'collapsed' : 'expanded')
  el.title = title
  el.setAttribute('aria-label', title)
}

// ============================================================
//  Build decorations
// ============================================================

function buildDecorations(state: EditorState, deco: FoldState): DecorationSet {
  const decos: Decoration[] = []

  state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      addHeadingDecos(state, node, pos, deco, decos)
      return
    }
    if (node.type.name === 'list_item') {
      addListItemDecos(state, node, pos, deco, decos)
      return
    }
  })

  return DecorationSet.create(state.doc, decos)
}

function addHeadingDecos(
  state: EditorState,
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

  const range = computeFoldRange(node, contentStart, state.doc)
  if (!range) return
  // 折叠区段首部 placeholder + 区段内每个 block 挂 hidden class
  applyFoldRange(state, range, contentStart, stableKey, decos)
}

function addListItemDecos(
  state: EditorState,
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
  const range = computeFoldRange(node, contentStart, state.doc)
  if (!range) return
  applyFoldRange(state, range, contentStart, stableKey, decos)
}

function applyFoldRange(
  state: EditorState,
  range: [number, number],
  triggerPos: number,
  stableKey: string,
  decos: Decoration[],
) {
  // 把 fold 区段内的每个 block 整块 `display: none`。
  // **关键**:`state.doc.nodesBetween(from, to)` 会访问**跨越 from-to 的
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
  visitBlocksInRange(state.doc, range[0], range[1], (n, p) => {
    decos.push(Decoration.node(p, p + n.nodeSize, { class: 'velo-folded' }, {
      // selectable: false 阻止 fold 区段被 NodeSelection / 鼠标 drag 选中
      // PM 内部仍按 doc 位置走,键盘 navigation 仍可越过(v1 接受)
      selectable: false,
    }))
  })
  // placeholder 挂到 range[0] - 1 side:1(首段/heading 末尾 close token
  // 紧前位置的最后一个 inline 位)。这里 PM 看作 inline text 末尾,
  // widget 作为 inline 元素紧跟首段文字同行,视觉上"首行末 + ..."。
  //
  // 为什么不用 side:-1 在 range[0]:range[0] 是 block 结束位置
  // (heading close token 之后 / list_item 首段 paragraph 之后),
  // PM 会在 block 边界换段,placeholder 视觉上在新一行 —— 用户报"占了一行"。
  // 用 side:1 在 range[0] - 1 把它挤进 block 内部最后一个 inline 位。
  decos.push(
    Decoration.widget(range[0] - 1, () => makePlaceholderWidget(range, triggerPos, stableKey), {
      key: `fold-placeholder:${range[0]}-${range[1]}`,
      ignoreSelection: true,
      side: 1,
    }),
  )
}

// ============================================================
//  Plugin
// ============================================================

/**
 * Plugin state apply。
 *  - setMeta `initCollapsed: number[]` → 覆盖整个 set(file 切换 / 启动时灌入)
 *  - setMeta `toggle: number` → 单点 toggle
 *  - setMeta `expandKey: string` → 把折叠集里这个 stable key 移除
 *    (placeholder 路径,需要先 resolve 到 contentStart —— 但本 meta 路径
 *    不直接做,留给 store 端处理:plugin 仍 dispatch toggle,store 同步翻)
 *  - docChanged → tr.mapping.map(pos, -1) 跟住,失效 pos 丢
 */
const foldDecoPlugin = new Plugin<FoldState>({
  key: foldKey,
  state: {
    init: () => initialState(),
    apply(tr, prev, _oldState, newState) {
      const meta = tr.getMeta(foldKey) as
        | { initCollapsed?: number[], toggle?: number, expandKey?: string }
        | undefined
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
          if (
            node.type.name === 'heading'
            || node.type.name === 'list_item'
          ) {
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
      return { collapsedSet }
    },
  },
  props: {
    decorations(state) {
      const s = foldKey.getState(state)
      if (!s) return null
      return buildDecorations(state, s)
    },
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
    if (
      node.type.name !== 'heading'
      && node.type.name !== 'list_item'
    ) {
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
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading' && node.content.size > 0) {
      const key = makeStableKey(node)
      if (key) out.push({ contentStart: pos + 1, stableKey: key, type: 'heading' })
      return
    }
    if (node.type.name === 'list_item' && node.childCount > 1 && node.firstChild) {
      const key = makeStableKey(node)
      if (key) out.push({ contentStart: pos + 1, stableKey: key, type: 'list_item' })
      return
    }
  })
  return out
}
