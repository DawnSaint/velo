import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type Katex from 'katex'
import {
  createTextareaEditor,
  stopMousedownPropagation,
} from './TextareaEditor'
import { createSelectionSync } from './selectionSync'
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

// 编辑态下 NodeView 需要从 PM 事件链里摘出来的输入事件类型:
//   eventBelongsToView 从 event.target 沿祖先链走到 view.dom,对每个有
//   pmViewDesc 的节点问 stopEvent;返回 true → PM 整条链路忽略。
//   isolateInputFromProseMirror 在 textarea / input 上 stopPropagation 是
//   inner 一侧兜底,stopEvent 在 NodeView 外侧兜底,两道闸互不依赖。
// (math_block 编辑态仍依赖这套机制,math_inline 去 atom 后不再需要)
const INPUT_EVENT_TYPES = new Set([
  'beforeinput',
  'input',
  'keydown',
  'keyup',
  'keypress',
  'paste',
  'copy',
  'cut',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'drop',
  'dragover',
  'dragenter',
  'dragleave',
])

async function renderKatex(source: string, el: HTMLElement, displayMode: boolean): Promise<void> {
  // 节点可能已切到编辑态 / 被 PM 销毁(典型的 `$$`+Enter 场景):
  //   showDisplay 同步排队 renderKatex → 微任务边界 → startEdit 同步挂上
  //   editor(进入 is-editing)→ katex 包异步加载完才 resolve → 这时再
  //   katex.render 到 el 会**覆盖刚挂好的 editor**,textarea 直接消失。
  //
  // **入口闸不判 isConnected**:NodeView 工厂同步跑 showDisplay 时,PM 还没把 dom
  // 挂到 view.dom(此时 isConnected === false),太早 return → 整个 NodeView 寿命里
  // katex 都不再 render。await 之后 PM 已挂好,走第二道闸就够。
  //
  // math_inline 去 atom 后 is-editing 路径已删除(不再有显式编辑态),但 math_block
  // 仍走 autoEditMathBlocks 这条路径 → 入口的 is-editing 检查对 math_block 仍有意义。
  if (el.classList.contains('is-editing')) return
  el.innerHTML = ''
  const katex = await getKatex()
  if (el.classList.contains('is-editing') || !el.isConnected) return
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
// 块级保持原行为:整块占一个段落位置,点击进 textarea 编辑态,blur 写回。
// 用户主诉是"行内公式"的显式输入框,块级语义不同(整段选中、Enter 行为复杂),
// 暂不改成 Obsidian/Typora 块级风格。后续若需要再统一改造。

function createMathBlockView(node: any, view: any, getPos: () => number) {
  const dom = document.createElement('div')
  dom.className = 'math-node math-block-node'
  let editing = false
  let editor: ReturnType<typeof createTextareaEditor> | null = null
  // B3: 视口外不调 katex.render,进入视口才渲染;滚出后缓存 innerHTML 并销毁,
  // 重新进入从缓存恢复(同步,免 katex.render)。editing 期间不销毁(光标在节点
  // = 节点在视口,且 textarea 有焦点)。
  let rendered = false
  let cachedHtml: string | null = null
  let inViewport = false

  stopMousedownPropagation(dom)

  function showDisplay() {
    if (editing) return
    dom.innerHTML = ''
    dom.classList.remove('is-editing')
    cachedHtml = null
    // 空 value 渲染可见占位(同上 inline 注释)
    if (!node.attrs.value) {
      renderEmptyPlaceholder(dom, true)
      rendered = true
      return
    }
    rendered = true
    void renderKatex(node.attrs.value, dom, true)
  }

  // B3: 进入视口 → 渲染(有缓存则同步恢复);滚出 → 缓存 innerHTML + 销毁。
  function maybeRender() {
    if (editing || rendered) return
    if (cachedHtml) {
      dom.innerHTML = cachedHtml
      rendered = true
      return
    }
    showDisplay()
  }

  function onLazy(intersecting: boolean) {
    inViewport = intersecting
    if (intersecting) {
      maybeRender()
    }
    else if (rendered && !editing && node.attrs.value) {
      cachedHtml = dom.innerHTML
      renderLazyPlaceholder(dom, true)
      rendered = false
    }
  }

  function startEdit() {
    if (editing) return
    // 阅读模式:不进编辑态(兜底,click / autoEdit 已守卫)
    if (!view.editable) return
    editing = true
    inViewport = true
    dom.classList.add('is-editing')

    editor = createTextareaEditor({
      initialValue: node.attrs.value || '',
      placeholder: 'LaTeX 源码',
      onCommit: (value) => {
        if (!editing) return
        editing = false
        if (value !== node.attrs.value) {
          const pos = getPos()
          if (pos >= 0) {
            view.dispatch(view.state.tr.setNodeAttribute(pos, 'value', value))
          }
          else { showDisplay() }
        }
        else { showDisplay() }
      },
      onCancel: () => {
        if (!editing) return
        editing = false
        showDisplay()
      },
    })
    // B3:预览优先复用缓存 innerHTML,其次已渲染的 dom,最后现场 render 进 preview。
    // 空 value 不渲染预览(同旧逻辑 — 空节点的 dom 是占位,不该塞进 preview)。
    if (node.attrs.value) {
      if (cachedHtml) editor.setPreviewHtml(cachedHtml)
      else if (rendered) editor.setPreviewHtml(dom.innerHTML)
      else void renderKatex(node.attrs.value, editor.preview, true)
    }
    cachedHtml = null
    dom.innerHTML = ''
    dom.appendChild(editor.container)
    editor.textarea.addEventListener('input', () => {
      void renderKatex(editor!.textarea.value, editor!.preview, true)
    })
    editor.focus()
  }

  dom.addEventListener('click', (e) => {
    // 阅读模式:不进编辑态,不 stopPropagation(让 PM 默认处理)
    if (!view.editable) return
    e.stopPropagation()
    if (!editing) startEdit()
  })

  // B3: 注册视口观察(无 IO 环境如 jsdom 同步按"在视口内"渲染,行为同旧实现)。
  // 先挂 lazy 占位:视口外首帧就有 min-height,避免进入视口时高度跳变;
  // 进入视口 maybeRender → showDisplay 会清掉占位换上 katex。
  renderLazyPlaceholder(dom, true)
  observeLazy(dom, onLazy)

  // 选中态同步:与 image / hr 同范式,抽取到 selectionSync.ts 共用。
  // math_block 是 block atom,编辑态下跳过选中框(textarea UI 视觉冲突)。
  const selectionSync = createSelectionSync({
    dom,
    view,
    getPos,
    getNode: () => node,
    skipSelected: () => editing,
  })

  // 弱引用 set 里的"待自动进 edit"标记。
  // 外部(dollarEnterToMathBlock keymap)在创建节点前 trigger(node),NodeView
  // 初始化时 has() + delete 消费,setTimeout(0) 等 DOM 挂好再 startEdit(),
  // 确保 textarea focus 不被外层 ProseMirror 的 transaction 重入抢掉。
  // 走 click 触发那条路在测试里发现 setTimeout 时机不稳(NodeView 还没 attach
  // 完就 click),改走 NodeView 自检路径更可靠。
  if (autoEditMathBlocks.has(node)) {
    autoEditMathBlocks.delete(node)
    // 阅读模式:不自动进编辑态(`$$`+Enter 在 editable=false 时不触发,WeakSet 标记
    // 可能残留,这里消费并跳过)
    if (view.editable) setTimeout(() => { if (!editing) startEdit() }, 0)
  }

  return {
    dom,
    update(newNode: any) {
      // 同 inline：只在 value 真的变了才重渲染
      const valueChanged = node.attrs.value !== newNode.attrs.value
      node = newNode
      if (valueChanged) {
        cachedHtml = null
        if (inViewport || editing) showDisplay()
        else rendered = false
      }
      return true
    },
    selectNode() { selectionSync.syncSelected() },
    deselectNode() { selectionSync.syncSelected() },
    destroy() {
      unobserveLazy(dom)
      editor?.dispose()
      selectionSync.destroy()
    },
    ignoreMutation() { return true },
    // 编辑态下,editor(内部 textarea + preview)的所有输入事件不能让 PM 看到。
    // 典型场景:`$$`+Enter 进入自动 edit → 用户敲字符 → PM 默认 handleTextInput
    // 走 tr.insertText,把 math_block 当 NodeSelection 选中并替换成输入字符 →
    // math 节点消失、textarea 随 nodeView 销毁一起消失。
    // stopEvent 在 PM 的 eventBelongsToView 里被检查,返回 true → 整条事件
    // 链路被 PM 忽略。isolateInputFromProseMirror 的 stopPropagation 是 textarea
    // 端的兜底,这里是从 NodeView 端兜底,两道闸互不依赖。
    stopEvent(event: Event) {
      if (!editing) return false
      return INPUT_EVENT_TYPES.has(event.type)
    },
  }
}

// ========== 导出 ==========

/**
 * 空 value 的 math 节点渲染占位 DOM(虚线框 + 提示文字)。
 * pointer-events:none 让点击透传到父 .math-node 的 click listener,
 * 由 listener 调 startEdit() 重新进入编辑态。
 */
function renderEmptyPlaceholder(dom: HTMLElement, block: boolean): void {
  const placeholder = document.createElement(block ? 'div' : 'span')
  placeholder.className = 'math-empty-placeholder'
  placeholder.textContent = block ? '点击编辑公式' : '公式'
  dom.appendChild(placeholder)
}

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
 * 初始化时 has() 检查 + delete 消费,setTimeout(0) 等 DOM 挂好再 startEdit。
 *
 * 用 WeakSet 而不是 module-level bool 槽 —— 之前 bool 槽在用户极快连按两次
 * Enter(连敲两行 `$$`)时第二个 math_block 不会进 edit,WeakSet 按节点引用
 * 不会丢。
 */
const autoEditMathBlocks = new WeakSet<object>()
export function triggerNextMathBlockAutoEdit(node: object) {
  autoEditMathBlocks.add(node)
}

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
  // 用户可重新打 $ 触发 inlineMathSyntax 再成公式。
  // `$$x^2$$` 首尾都有 $ 仍合法(行内双 $);块级只认两行独立 `$$`,不在此处处理。
  appendTransaction(trs, _oldState, newState) {
    if (!trs.some(tr => tr.docChanged)) return null
    const matches: Array<{ pos: number; size: number; text: string }> = []
    newState.doc.descendants((node, pos) => {
      if (node.type.name === 'math_inline') {
        const text = node.textContent
        if (!/^\$.+\$$/.test(text)) matches.push({ pos, size: node.nodeSize, text })
      }
      return true
    })
    if (matches.length === 0) return null
    const tr = newState.tr
    // 从后往前替换,避免前面替换导致后面 pos 偏移
    for (let i = matches.length - 1; i >= 0; i--) {
      const { pos, size, text } = matches[i]
      tr.replaceWith(pos, pos + size, text ? newState.schema.text(text) : [])
    }
    return tr
  },
})
