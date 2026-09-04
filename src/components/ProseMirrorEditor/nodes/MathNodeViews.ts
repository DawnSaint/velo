import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type Katex from 'katex'
import { observeLazy, unobserveLazy } from './lazyRender'

// ========== katex 懒加载 ==========
//
// katex 包 ~270KB minified(+ 字体),首屏 doc 不含 $/$$ 公式时无需加载。
// 用模块级 lazy getter 把 `import katex` + `import 'katex/dist/katex.min.css'`
// 推迟到第一次 render 时才执行,Vite/rolldown 据此把 katex 拆出独立 chunk
// (配合 vite.config.ts 不再 codeSplitting:false)。
//
// 调用点(showDisplay / startEdit)都改成 `void renderKatex(...)`,
// 第一次 render 时 katex 尚未就绪 → innerHTML 先清空占位,加载完才填,
// 视觉上"先空后渲染"(数学公式场景首次加载可接受)。

let katexMod: typeof Katex | null = null
let katexPromise: Promise<typeof Katex> | null = null

function getKatex(): Promise<typeof Katex> {
  if (katexMod) return Promise.resolve(katexMod)
  if (!katexPromise) {
    katexPromise = Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ]).then(([m]) => {
      katexMod = m.default
      return m.default
    })
  }
  return katexPromise
}

async function renderKatex(source: string, el: HTMLElement, displayMode: boolean): Promise<void> {
  // B2:math_block 去 atom 后不再有 is-editing class,renderKatex 写入的 target
  // 始终是 display 渲染层(contenteditable=false),不会覆盖 contentDOM。
  // await 后检查 isConnected 即可——节点被 PM 销毁时不再写入。
  el.innerHTML = ''
  const katex = await getKatex()
  if (!el.isConnected) return
  try {
    katex.render(source || ' ', el, { throwOnError: true, displayMode })
  }
  catch (e: any) {
    const errSpan = document.createElement('span')
    errSpan.className = 'math-error'
    errSpan.textContent = source || '(空)'
    errSpan.title = e?.message || 'LaTeX 语法错误'
    el.appendChild(errSpan)
  }
}

// ========== 行内公式 NodeView ==========
//
// Obsidian Live Preview / Typora 风格 —— 与 footnote_reference "label as text content"
// 同范式:
//   - math_inline 节点 = schema `content: 'text*'`,source 文本由 PM 通过 contentDOM
//     直接管理(光标能进入节点内逐字符编辑,Backspace/Delete 按节点内 selection 处理)。
//   - NodeView DOM 结构:
//       [prefix $][contentDOM source][suffix $][katex 渲染层]
//   - 渲染层**始终可见**;data-mode 只控制 source + 前后 $ 是否显示:
//       - display (光标在节点外):隐藏 source + 前后 $,仅显示渲染层 → 阅读纯净
//       - edit    (光标在节点内):显示 source + 前后 $ + 渲染层 → 源码与预览并列,
//         源码更新时由 update() 实时把 katex 重渲染到 .math-inline-display
//   - `$` 分隔符走主题色 var(--md-primary-color),由 SCSS 控制
//   - 模式切换由 NodeView 监听 `view.dom.ownerDocument` 的 `selectionchange` 事件,
//     读 view.state.selection 判断 head 是否落在本节点 pos 范围内。
//
// 旧版(inline math 走 atom + 自管 input/textarea)的"显式输入框 + blur 消失"交互被
// 完全替换 —— 用户感知"光标进入即显示源码、离开即折叠回渲染",与 footnote_reference
// 修复后行为同型。

function createMathInlineView(node: any, view: any, getPos: () => number) {
  const dom = document.createElement('span')
  dom.className = 'math-node math-inline-node'
  dom.dataset.mode = 'display'

  // B1:contentDOM 直接含完整 `$x^2$`(含分隔符,PM 管理,用户可编辑 $)。
  // 不再有独立 prefix/suffix 装饰 —— `$` 就是 contentDOM 内文本的一部分,
  // 用户删掉一个 `$` 后 content 不匹配 `$...$`,由 mathInlineUnwrapPlugin 降级为普通文本。
  const contentDOM = document.createElement('span')
  contentDOM.className = 'math-inline-source'
  dom.appendChild(contentDOM)

  // 渲染层(始终可见)—— 从 textContent 剥离首尾 $ 后给 katex。
  // contenteditable=false:防止光标意外从 source 漂到渲染层里(PM 会把渲染层当可编辑
  // 区域处理,导致选区错位),也防止 IME 在渲染层里启动输入。
  const display = document.createElement('span')
  display.className = 'math-inline-display'
  display.setAttribute('contenteditable', 'false')
  dom.appendChild(display)

  // B3: 视口外不调 katex.render,进入视口才渲染;滚出后缓存 innerHTML 并销毁。
  // edit 态(光标在节点内 = 节点在视口)始终渲染,不参与销毁。
  let rendered = false
  let cachedHtml: string | null = null
  let inViewport = false

  // B1:剥离首尾连续 `$` 得纯 source 给 katex。`$x^2$` → `x^2`、`$$x^2$$` → `x^2`。
  // 与 markdownIO.stripMathDelimiters 同源逻辑(各自本地副本,避免循环依赖)。
  function stripDelimiters(s: string): string {
    return s.replace(/^\$+/, '').replace(/\$+$/, '')
  }

  function readValue(n: any = node): string {
    return n.textContent || ''
  }

  function isCursorInNode(): boolean {
    const pos = getPos()
    if (pos < 0) return false
    if (node.nodeSize === 0) return true // 空节点:始终显示空占位($ $),用户可点击进入输入
    // 优先读 DOM selection —— PM 对鼠标点击导致的 DOM selection 变化的 state 同步
    // 是异步的(rAF),selectionchange 触发时 view.state.selection 可能还是旧值 →
    // 鼠标移出节点后 mode 不立即切换,用户须再点一下或输入才更新。
    // 直接检查 DOM selection 的 anchorNode 是否在 contentDOM 子树内,无延迟。
    const sel = view.dom.ownerDocument.getSelection()
    if (sel && sel.rangeCount > 0 && sel.anchorNode && view.dom.contains(sel.anchorNode)) {
      // anchorNode 在编辑器内,直接用 DOM 判断(绕开 PM state 同步延迟)
      let n: Node | null = sel.anchorNode
      while (n) {
        if (n === contentDOM) return true // 光标在 contentDOM 子树内 → 在节点内
        if (n === dom) return false // 在 dom(math-inline-node)内但不在 contentDOM 内
        n = n.parentNode
      }
      return false // 在 view.dom 内但不在本节点内
    }
    // Fallback: 读 view.state.selection
    // (jsdom 下 DOM Selection API 同步不完整,测试用 dispatch(tr.setSelection) 时
    // state 即时正确;键盘导航走 tr.setSelection,state 也是即时同步的)
    const head = view.state.selection.$head
    return head.pos > pos && head.pos < pos + node.nodeSize
  }

  function syncMode() {
    // 阅读模式:强制 display,不进 edit(光标进入 $...$ 不展开 source,保持渲染态)
    if (!view.editable) {
      if (dom.dataset.mode !== 'display') {
        dom.dataset.mode = 'display'
        maybeRender()
      }
      return
    }
    const target = isCursorInNode() ? 'edit' : 'display'
    if (dom.dataset.mode !== target) {
      dom.dataset.mode = target
      // B3:edit 态(光标在节点内 = 节点在视口)始终渲染;display 态按视口门控 ——
      // 切到 display 时 source 隐藏,渲染层是用户唯一能看到的,在视口内才渲染。
      if (target === 'edit') {
        inViewport = true
        showDisplay()
      }
      else {
        maybeRender()
      }
    }
  }

  function showDisplay() {
    const value = readValue() // 含 `$` 分隔符,如 `$x^2$` 或 `$$x^2$$`
    const source = stripDelimiters(value) // 剥离首尾 $ 得纯 source 给 katex
    cachedHtml = null
    rendered = true
    // 空 source 渲染可见占位 —— 节点不可见会让用户以为"math 节点丢了"。
    // 占位 pointer-events:none 透传到 .math-node mousedown,点击进编辑态。
    if (!source) renderEmptyPlaceholder(display)
    else void renderKatex(source, display, false)
  }

  // B3: 进入视口 → 渲染(有缓存则同步恢复);滚出 → 缓存 + 销毁。edit 态不销毁。
  function maybeRender() {
    if (rendered) return
    if (cachedHtml) {
      display.innerHTML = cachedHtml
      rendered = true
      return
    }
    if (inViewport || dom.dataset.mode === 'edit') showDisplay()
    // else: 留空/占位,不调 katex(视口外)
  }

  function onLazy(intersecting: boolean) {
    inViewport = intersecting
    if (intersecting) {
      maybeRender()
    }
    else if (rendered && dom.dataset.mode !== 'edit') {
      cachedHtml = display.innerHTML
      renderLazyPlaceholder(display, false)
      rendered = false
    }
  }

  function renderEmptyPlaceholder(target: HTMLElement) {
    target.innerHTML = ''
    const ph = document.createElement('span')
    ph.className = 'math-empty-placeholder'
    ph.textContent = '公式'
    target.appendChild(ph)
  }

  // selectionchange 监听:文档级事件(浏览器在 selection 变化时触发),触发时
  // view.state.selection 已被 PM 同步更新,可直接读。
  // 每个 math_inline NodeView 注册一个 listener,通常 inline math 数量少,开销可
  // 接受;若未来密度上升,可改为单个 plugin + WeakSet<NodeView> 集中分发。
  const onSelectionChange = () => { syncMode() }
  view.dom.ownerDocument.addEventListener('selectionchange', onSelectionChange)

  // 初始:根据当前 selection 决定 mode;B3 首次渲染由视口观察触发(无 IO 环境
  // 如 jsdom 同步按"在视口内"渲染,行为同旧实现)。
  syncMode()
  observeLazy(dom, onLazy)

  // display 态点击展开:contentDOM 此时 display:none,PM 无法把 DOM selection 放进
  // 隐藏元素 → 光标落到节点边界 → isCursorInNode 不成立 → selectionchange 不触发 →
  // mode 不切 → 死锁,用户须点很多次才能偶然命中展开 source。
  // 这里在 mousedown 阶段拦截:先切 edit 让 contentDOM 可见(display:none → inline,
  // CSS 同步应用),再主动 dispatch TextSelection 到节点内,PM 才能把 DOM selection
  // 正确同步到 contentDOM。edit 态点击不拦截,PM 正常处理光标移动。
  dom.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (dom.dataset.mode !== 'display') return
    // 阅读模式:不展开 source,让 PM/浏览器默认处理点击
    if (!view.editable) return
    e.preventDefault()
    e.stopPropagation()
    const pos = getPos()
    if (pos < 0) return
    // 先切 edit 让 contentDOM 可见 —— 否则 PM 同步 DOM selection 到 display:none 元素
    // 会失败,selectionchange 不触发,死锁在 display 态。
    dom.dataset.mode = 'edit'
    // 根据点击 x 相对渲染层中点,决定光标放节点开头还是结尾 —— 符合"点左半进开头、
    // 点右半进结尾"的直觉。
    const start = pos + 1
    const end = Math.max(start, pos + node.nodeSize - 1)
    const rect = display.getBoundingClientRect()
    const target = e.clientX > rect.left + rect.width / 2 ? end : start
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)))
    view.focus()
  })

  return {
    dom,
    contentDOM,
    update(newNode: any) {
      const valueChanged = readValue() !== readValue(newNode)
      node = newNode
      // source 变化 → 重渲染渲染层(edit 态用户键入时也要看到预览跟着变,不能只在
      // display 态刷;否则用户在 edit 态打 `x^2` 只能看到 `$x^2$` 裸文本,看不到
      // 渲染后的 x²,完全失去 Obsidian Live Preview 的体验)。视口外的变更只标脏,
      // 进入视口时再渲染。
      if (valueChanged) {
        cachedHtml = null
        if (inViewport || dom.dataset.mode === 'edit') showDisplay()
        else rendered = false
      }
      syncMode() // 节点移动后 pos 范围变了,重新判定
      return true
    },
    destroy() {
      unobserveLazy(dom)
      view.dom.ownerDocument.removeEventListener('selectionchange', onSelectionChange)
    },
    ignoreMutation() { return true },
  }
}

// ========== 块级公式 NodeView ==========
//
// PM 直接管理源码文本(含 `$$` 分隔符),NodeView 维护两态:
//   - display (光标在节点外):隐藏 source,仅显示 katex 预览 → 阅读纯净
//   - edit    (光标在节点内):显示 source(含 `$$`)+ katex 预览 → 源码与预览并列
// 预览框保持现状(katex 渲染层 + B3 视口懒加载)。
//
// 与 math_inline 的差异:block 节点用 div 容器,contentDOM 是 block 级;
// `$$` 分隔符在 source 内(用户可编辑),stripDelimiters 剥离首尾 $ 得纯 source。

function createMathBlockView(node: any, view: any, getPos: () => number) {
  const dom = document.createElement('div')
  dom.className = 'math-node math-block-node'
  dom.dataset.mode = 'display'

  // contentDOM:PM 直接管理,含完整 `$$x^2$$`(含分隔符,用户可编辑 $)。
  const contentDOM = document.createElement('div')
  contentDOM.className = 'math-block-source'
  dom.appendChild(contentDOM)

  // 渲染层(katex 预览)—— 从 textContent 剥离首尾 $ 后给 katex。
  // contenteditable=false:防止光标意外漂到渲染层里。
  const display = document.createElement('div')
  display.className = 'math-block-display'
  display.setAttribute('contenteditable', 'false')
  dom.appendChild(display)

  // B3: 视口外不调 katex.render,进入视口才渲染;滚出后缓存 innerHTML 并销毁。
  // edit 态(光标在节点内 = 节点在视口)始终渲染,不参与销毁。
  let rendered = false
  let cachedHtml: string | null = null
  let inViewport = false

  // 剥离首尾连续 `$` 得纯 source 给 katex。`$$x^2$$` → `x^2`。
  // 与 markdownIO.stripMathDelimiters 同源逻辑(各自本地副本,避免循环依赖)。
  function stripDelimiters(s: string): string {
    return s.replace(/^\$+/, '').replace(/\$+$/, '')
  }

  function readValue(n: any = node): string {
    return n.textContent || ''
  }

  function isCursorInNode(): boolean {
    const pos = getPos()
    if (pos < 0) return false
    if (node.nodeSize === 0) return true
    // 优先读 DOM selection(同 math_inline 注释)
    const sel = view.dom.ownerDocument.getSelection()
    if (sel && sel.rangeCount > 0 && sel.anchorNode && view.dom.contains(sel.anchorNode)) {
      let n: Node | null = sel.anchorNode
      while (n) {
        if (n === contentDOM) return true
        if (n === dom) return false
        n = n.parentNode
      }
      return false
    }
    const head = view.state.selection.$head
    return head.pos > pos && head.pos < pos + node.nodeSize
  }

  function syncMode() {
    if (!view.editable) {
      if (dom.dataset.mode !== 'display') {
        dom.dataset.mode = 'display'
        maybeRender()
      }
      return
    }
    const target = isCursorInNode() ? 'edit' : 'display'
    if (dom.dataset.mode !== target) {
      dom.dataset.mode = target
      if (target === 'edit') {
        inViewport = true
        showDisplay()
      }
      else {
        maybeRender()
      }
    }
  }

  function showDisplay() {
    const value = readValue() // 含 `$$` 分隔符,如 `$$\nx^2\n$$`
    // 结构破坏(删掉一个 $ 导致 `$$…$$` 不成对)由 appendTransaction 把整块
    // 降级成普通 paragraph 处理,这里只需负责"合法时渲染预览",无需特殊分支。
    // 不降级的根因已通过解析层自写的 strictMath 解决(未闭合围栏当普通文本,
    // 段落里的 `$` 也不再被 remark-stringify 转义),所以降级路径是安全的。
    display.style.display = ''
    const source = stripDelimiters(value).trim() // 剥离 $$ 并 trim 首尾换行得纯 source
    cachedHtml = null
    rendered = true
    if (!source) renderEmptyPlaceholder(display)
    else void renderKatex(source, display, true)
  }

  // B3: 进入视口 → 渲染(有缓存则同步恢复);滚出 → 缓存 + 销毁。edit 态不销毁。
  function maybeRender() {
    if (rendered) return
    if (cachedHtml) {
      display.innerHTML = cachedHtml
      rendered = true
      return
    }
    if (inViewport || dom.dataset.mode === 'edit') showDisplay()
  }

  function onLazy(intersecting: boolean) {
    inViewport = intersecting
    if (intersecting) {
      maybeRender()
    }
    else if (rendered && dom.dataset.mode !== 'edit') {
      cachedHtml = display.innerHTML
      renderLazyPlaceholder(display, true)
      rendered = false
    }
  }

  function renderEmptyPlaceholder(target: HTMLElement) {
    target.innerHTML = ''
    const ph = document.createElement('div')
    ph.className = 'math-empty-placeholder'
    ph.textContent = '公式'
    target.appendChild(ph)
  }

  const onSelectionChange = () => { syncMode() }
  view.dom.ownerDocument.addEventListener('selectionchange', onSelectionChange)

  syncMode()
  observeLazy(dom, onLazy)

  // 弱引用 set 里的"待自动进 edit"标记。
  // 外部(dollarEnterToMathBlock keymap)在创建节点前 trigger(node),NodeView
  // 初始化时 has() + delete 消费,setTimeout(0) 等 DOM 挂好后再 dispatch
  // TextSelection 到节点内部,syncMode 检测光标在节点内 → 切 edit 态。
  if (autoEditMathBlocks.has(node)) {
    autoEditMathBlocks.delete(node)
    if (view.editable) setTimeout(() => {
      const pos = getPos()
      if (pos < 0) return
      // 光标放首行 `$$` 之后的空行开头(pos+1 = 节点内开头)
      // content = `$$\n\n$$`,pos+1 是文本开头,pos+4 是空行开头(跳过 `$$\n`)
      const cursor = pos + 4
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cursor)))
    }, 0)
  }

  // display 态点击展开(同 math_inline 范式):
  // contentDOM 此时 display:none,PM 无法把 DOM selection 放进隐藏元素 →
  // 先切 edit 让 contentDOM 可见,再 dispatch TextSelection 到节点内。
  dom.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    if (dom.dataset.mode !== 'display') return
    if (!view.editable) return
    e.preventDefault()
    e.stopPropagation()
    const pos = getPos()
    if (pos < 0) return
    dom.dataset.mode = 'edit'
    const start = pos + 1
    const end = Math.max(start, pos + node.nodeSize - 1)
    const rect = display.getBoundingClientRect()
    const target = e.clientX > rect.left + rect.width / 2 ? end : start
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)))
    view.focus()
  })

  return {
    dom,
    contentDOM,
    update(newNode: any) {
      const valueChanged = readValue() !== readValue(newNode)
      node = newNode
      if (valueChanged) {
        cachedHtml = null
        if (inViewport || dom.dataset.mode === 'edit') showDisplay()
        else rendered = false
      }
      syncMode()
      return true
    },
    destroy() {
      unobserveLazy(dom)
      view.dom.ownerDocument.removeEventListener('selectionchange', onSelectionChange)
    },
    ignoreMutation() { return true },
  }
}

// ========== 导出 ==========

/**
 * B3: 视口外的 math 节点渲染轻量占位 —— 不调 katex.render，进入视口后才渲染。
 * block 给 min-height 避免进入视口时高度跳变；inline 最小化（行内零宽无妨，
 * 1000px rootMargin 保证进入可见区前已渲染，占位只在极快滚动时短暂出现）。
 */
function renderLazyPlaceholder(target: HTMLElement, block: boolean): void {
  target.innerHTML = ''
  const ph = document.createElement(block ? 'div' : 'span')
  ph.className = 'math-lazy-placeholder'
  ph.textContent = block ? '公式' : 'ƒ'
  target.appendChild(ph)
}

/**
 * 标记"某个具体的 math_block 节点应该自动进入编辑态"。
 * keymap (dollarEnterToMathBlock) 在创建节点前 add(node),NodeView 工厂
 * 初始化时 has() 检查 + delete 消费,setTimeout(0) 等 DOM 挂好再自动聚焦光标。
 *
 * 用 WeakSet 而不是 module-level bool 槽 —— 之前 bool 槽在用户极快连按两次
 * Enter(连敲两行 `$$`)时第二个 math_block 不会进 edit,WeakSet 按节点引用
 * 不会丢。
 */
const autoEditMathBlocks = new WeakSet<object>()
export function triggerNextMathBlockAutoEdit(node: object) {
  autoEditMathBlocks.add(node)
}

// Valid math_block content: at least two $ on first and last line, any content between.
const MATH_BLOCK_RE = /^\${2,}\n[\s\S]*\n\${2,}$/

export const mathEditPlugin = new Plugin({
  key: new PluginKey('mathEdit'),
  props: {
    nodeViews: {
      math_inline: (node, view, getPos) => createMathInlineView(node, view, getPos as () => number),
      math_block: (node, view, getPos) => createMathBlockView(node, view, getPos as () => number),
    },
    // 光标在 math_inline content 末尾(尾 `$` 之后,close tag 之前)时输入非 `$` 字符 →
    // 字符插到节点**之外**,光标也移出 → isCursorInNode false → syncMode 切 display 收起。
    // 输入 `$` 不拦截(用户编辑分隔符,如 `$x$` → `$$x$$`)。
    // 配合 inlineMath.ts 的"转换后光标设到 content 末尾",实现 Obsidian Live Preview:
    //   打完 `$x$` → 光标在尾 $ 后,edit 态显示 $x$ + 渲染;继续输入别的字符 → 移出收起。
    handleTextInput(view, from, to, text) {
      if (from !== to || !text) return false
      const $pos = view.state.doc.resolve(from)
      for (let d = $pos.depth; d >= 1; d--) {
        const node = $pos.node(d)
        if (node.type.name === 'math_inline') {
          const mathPos = $pos.before(d)
          const contentEnd = mathPos + 1 + node.content.size
          if (from !== contentEnd) return false
          if (text === '$') return false
          const afterNode = mathPos + node.nodeSize
          const tr = view.state.tr.insertText(text, afterNode)
          tr.setSelection(TextSelection.create(tr.doc, afterNode + text.length))
          view.dispatch(tr)
          return true
        }
      }
      return false
    },
  },
  // B1 降级:math_inline content 必须匹配 `$...$`(首尾各至少一个 $,中间非空)。
  // 用户删掉一个 $ 后 content 变成 `$x^2` 或 `x^2$` → 不匹配 → unwrap 成普通 text,
  // 用户可重新打 $ 触发 inlineMathSyntax 再成公式。`$$x^2$$` 首尾都有 $ 仍合法(行内双 $)。
  //
  // B2 降级:math_block content 必须匹配 `$$\n...\n$$`(首尾各至少两个 $ 独占行)。
  // 用户删掉一个 $ 后 content 变成 `$\n...\n$$` → 不匹配 → 降级为普通段落,
  // 用户可重新打 $ 触发 dollarEnterCmd 再成公式。
  //
  // 为什么现在敢降级了:解析层已换成自写的 strictMath(见 plugins/strictMath)。
  //   - 未闭合的 `$$` 围栏当普通文本,不会再吞掉后续段落;
  //   - 段落里的 `$` 也不再被 remark-stringify 转义成 `\$`。
  // 于是"退回普通文本段落"和"不产生额外转义"不再冲突 —— 这正是用户要的效果。
  appendTransaction(trs, _oldState, newState) {
    if (!trs.some(tr => tr.docChanged)) return null
    const matches: Array<{ pos: number; size: number; text: string; isBlock: boolean }> = []
    newState.doc.descendants((node, pos) => {
      if (node.type.name === 'math_inline') {
        const text = node.textContent
        if (!/^\$.+\$$/.test(text)) matches.push({ pos, size: node.nodeSize, text, isBlock: false })
      }
      else if (node.type.name === 'math_block') {
        const text = node.textContent
        // 合法格式:$$ \n ... \n $$ (首尾各至少两个 $,中间可有任意内容含空)
        if (!MATH_BLOCK_RE.test(text)) {
          matches.push({ pos, size: node.nodeSize, text, isBlock: true })
        }
      }
      return true
    })
    if (matches.length === 0) return null
    const tr = newState.tr
    // 从后往前替换,避免前面替换导致后面 pos 偏移
    for (let i = matches.length - 1; i >= 0; i--) {
      const { pos, size, text, isBlock } = matches[i]
      if (isBlock) {
        // math_block 降级为 paragraph(含原始文本,逐字拷贝、不加任何转义)
        const para = newState.schema.nodes.paragraph.create(null, text ? newState.schema.text(text) : [])
        tr.replaceWith(pos, pos + size, para)
      }
      else {
        tr.replaceWith(pos, pos + size, text ? newState.schema.text(text) : [])
      }
    }
    return tr
  },
})
