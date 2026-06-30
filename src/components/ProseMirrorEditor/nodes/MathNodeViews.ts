import { Plugin, PluginKey } from 'prosemirror-state'
import type Katex from 'katex'
import {
  createTextareaEditor,
  stopMousedownPropagation,
  isolateInputFromProseMirror,
  insertTabAtCursor,
} from './TextareaEditor'

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
  // 两道闸:同步入口处判一次 + await 之后再判一次,任一不通过就放弃写入。
  //
  // **入口闸不判 isConnected**:NodeView 工厂同步跑 showDisplay 时,PM 还没把 dom
  // 挂到 view.dom(此时 isConnected === false),太早 return → 整个 NodeView 寿命里
  // katex 都不再 render。await 之后 PM 已挂好,走第二道闸就够。
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
// inline 用 <input> 而非 <textarea>,结构跟 block / mermaid 差别大,
// 不走 createTextareaEditor。直接复用 stopMousedownPropagation /
// isolateInputFromProseMirror / insertTabAtCursor。

function createMathInlineView(node: any, view: any, getPos: () => number) {
  const dom = document.createElement('span')
  dom.className = 'math-node math-inline-node'
  let editing = false

  function readValue(n: any = node): string {
    return n.textContent || ''
  }

  stopMousedownPropagation(dom)

  function showDisplay() {
    dom.innerHTML = ''
    dom.classList.remove('is-editing')
    const value = readValue()
    // 空 value 不走 katex:render(' ') 出来高度趋近 0,节点看起来"消失";
    // 改成渲染可见占位,让用户能看见并点击重新进编辑。点击走 dom 上
    // 的 click listener(startEdit),占位本身 pointer-events:none 透传。
    if (!value) renderEmptyPlaceholder(dom, false)
    else void renderKatex(value, dom, false)
  }

  function startEdit() {
    if (editing) return
    editing = true
    dom.innerHTML = ''
    dom.classList.add('is-editing')

    const wrapper = document.createElement('span')
    wrapper.className = 'math-edit-wrapper'

    const input = document.createElement('input')
    input.type = 'text'
    input.value = readValue()
    input.className = 'math-edit-input'
    input.placeholder = 'LaTeX 源码'

    const preview = document.createElement('span')
    preview.className = 'edit-preview'
    void renderKatex(input.value, preview, false)

    wrapper.appendChild(input)
    wrapper.appendChild(preview)
    dom.appendChild(wrapper)

    isolateInputFromProseMirror(input)
    input.addEventListener('input', (e) => {
      e.stopPropagation()
      void renderKatex(input.value, preview, false)
    })

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); cancel() }
      if (e.key === 'Tab') {
        e.preventDefault()
        insertTabAtCursor(input)
      }
    })

    input.addEventListener('blur', () => { save() })

    function save() {
      if (!editing) return
      editing = false
      if (input.value !== readValue()) {
        const pos = getPos()
        if (pos >= 0) {
          const newNode = node.type.create(null, view.state.schema.text(input.value))
          view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, newNode))
        }
        else { showDisplay() }
      }
      else { showDisplay() }
    }

    function cancel() {
      if (!editing) return
      editing = false
      showDisplay()
    }

    setTimeout(() => input.focus(), 0)
  }

  dom.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!editing) startEdit()
  })

  showDisplay()

  return {
    dom,
    update(newNode: any) {
      const valueChanged = readValue() !== readValue(newNode)
      node = newNode
      if (!editing && valueChanged) showDisplay()
      return true
    },
    destroy() { /* nothing */ },
    ignoreMutation() { return true },
    // 编辑态下,textarea / preview 内部的所有输入事件不能让 PM 看到 —— PM 的
    // eventBelongsToView 会从 event.target 一路走到 view.dom,对每个有
    // pmViewDesc 的祖先调 stopEvent。这里返回 true → PM 整条链路忽略这个事件,
    // 不会触发默认的 tr.insertText 把 math_inline 整个替换成输入字符。
    stopEvent(event: Event) {
      if (!editing) return false
      return INPUT_EVENT_TYPES.has(event.type)
    },
  }
}

// ========== 块级公式 NodeView ==========

function createMathBlockView(node: any, view: any, getPos: () => number) {
  const dom = document.createElement('div')
  dom.className = 'math-node math-block-node'
  let editing = false
  let editor: ReturnType<typeof createTextareaEditor> | null = null

  stopMousedownPropagation(dom)

  function showDisplay() {
    if (editing) return
    dom.innerHTML = ''
    dom.classList.remove('is-editing')
    // 空 value 渲染可见占位(同上 inline 注释)
    if (!node.attrs.value) renderEmptyPlaceholder(dom, true)
    else void renderKatex(node.attrs.value, dom, true)
  }

  function startEdit() {
    if (editing) return
    editing = true
    const renderedHtml = dom.innerHTML
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
    // 初始预览就是 dom.innerHTML 捕获的渲染结果,直接显示;input 监听负责后续重新渲染。
    // 仅在原本有 value 时恢复 — 空节点的 dom 现在是 .math-empty-placeholder,
    // 把它塞回 preview 里会污染 dom(querySelector('.math-empty-placeholder') 仍能命中)。
    if (renderedHtml && node.attrs.value) editor.setPreviewHtml(renderedHtml)
    dom.innerHTML = ''
    dom.appendChild(editor.container)
    editor.textarea.addEventListener('input', () => {
      void renderKatex(editor!.textarea.value, editor!.preview, true)
    })
    editor.focus()
  }

  dom.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!editing) startEdit()
  })

  showDisplay()

  // 弱引用 set 里的"待自动进 edit"标记。
  // 外部(dollarEnterToMathBlock keymap)在创建节点前 trigger(node),NodeView
  // 初始化时 has() + delete 消费,setTimeout(0) 等 DOM 挂好再 startEdit(),
  // 确保 textarea focus 不被外层 ProseMirror 的 transaction 重入抢掉。
  // 走 click 触发那条路在测试里发现 setTimeout 时机不稳(NodeView 还没 attach
  // 完就 click),改走 NodeView 自检路径更可靠。
  if (autoEditMathBlocks.has(node)) {
    autoEditMathBlocks.delete(node)
    setTimeout(() => { if (!editing) startEdit() }, 0)
  }

  return {
    dom,
    update(newNode: any) {
      // 同 inline：只在 value 真的变了才重渲染
      const valueChanged = node.attrs.value !== newNode.attrs.value
      node = newNode
      if (!editing && valueChanged) showDisplay()
      return true
    },
    destroy() { editor?.dispose() },
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
  },
})
