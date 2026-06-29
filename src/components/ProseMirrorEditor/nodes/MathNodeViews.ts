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

async function renderKatex(source: string, el: HTMLElement, displayMode: boolean): Promise<void> {
  el.innerHTML = ''
  const katex = await getKatex()
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
    void renderKatex(readValue(), dom, false)
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
    void renderKatex(node.attrs.value, dom, true)
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
    editor.setPreviewHtml(renderedHtml)
    // 初始预览就是 dom.innerHTML 捕获的渲染结果,直接显示;input 监听负责后续重新渲染
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
  }
}

// ========== 导出 ==========

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
