import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import katex from 'katex'
import { isolateInputFromProseMirror } from './plugin-common'

function renderKatex(source: string, el: HTMLElement, displayMode: boolean) {
  el.innerHTML = ''
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

function createMathInlineView(node: any, view: any, getPos: () => number) {
  const dom = document.createElement('span')
  dom.className = 'math-node math-inline-node'
  let editing = false

  dom.addEventListener('mousedown', (e) => { e.stopPropagation() }, true)

  function showDisplay() {
    dom.innerHTML = ''
    dom.classList.remove('is-editing')
    renderKatex(node.attrs.value, dom, false)
  }

  function startEdit() {
    if (editing) return
    editing = true
    dom.innerHTML = ''
    dom.classList.add('is-editing')
    view.dom.classList.add('prosemirror-caret-hidden')

    const wrapper = document.createElement('span')
    wrapper.className = 'math-edit-wrapper'

    const input = document.createElement('input')
    input.type = 'text'
    input.value = node.attrs.value || ''
    input.className = 'math-edit-input'
    input.placeholder = 'LaTeX 源码'

    const preview = document.createElement('span')
    preview.className = 'edit-preview'
    renderKatex(input.value, preview, false)

    wrapper.appendChild(input)
    wrapper.appendChild(preview)
    dom.appendChild(wrapper)

    isolateInputFromProseMirror(input)
    input.addEventListener('input', (e) => {
      e.stopPropagation()
      renderKatex(input.value, preview, false)
    })

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); cancel() }
      if (e.key === 'Tab') {
        e.preventDefault()
        const start = input.selectionStart ?? input.value.length
        const end = input.selectionEnd ?? input.value.length
        input.value = input.value.slice(0, start) + '\t' + input.value.slice(end)
        input.selectionStart = input.selectionEnd = start + 1
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })

    input.addEventListener('blur', () => { save() })

    function save() {
      if (!editing) return
      editing = false
      cleanup()
      if (input.value !== node.attrs.value) {
        const pos = getPos()
        if (pos >= 0) {
          view.dispatch(view.state.tr.setNodeAttribute(pos, 'value', input.value))
        }
        else { showDisplay() }
      }
      else { showDisplay() }
    }

    function cancel() {
      if (!editing) return
      editing = false
      cleanup()
      showDisplay()
    }

    function cleanup() {
      view.dom.classList.remove('prosemirror-caret-hidden')
    }

    ;(dom as any).__mathCleanup = () => { cleanup() }
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
      // ProseMirror 每次文档变化都会调 update()，但只要 value 没变就不重渲染
      // —— 否则在长文档里每键击 N 个 math 节点都白白重跑一次 KaTeX
      const valueChanged = node.attrs.value !== newNode.attrs.value
      node = newNode
      if (!editing && valueChanged) showDisplay()
      return true
    },
    destroy() { ;(dom as any).__mathCleanup?.() },
    ignoreMutation() { return true },
  }
}

// ========== 块级公式 NodeView ==========

function createMathBlockView(node: any, view: any, getPos: () => number) {
  const dom = document.createElement('div')
  dom.className = 'math-node math-block-node'
  let editing = false

  dom.addEventListener('mousedown', (e) => { e.stopPropagation() }, true)

  function showDisplay() {
    dom.innerHTML = ''
    dom.classList.remove('is-editing')
    renderKatex(node.attrs.value, dom, true)
  }

  function startEdit() {
    if (editing) return
    editing = true

    // 保存当前渲染内容作为参考
    const renderedHtml = dom.innerHTML
    dom.classList.add('is-editing')
    view.dom.classList.add('prosemirror-caret-hidden')

    const textarea = document.createElement('textarea')
    textarea.value = node.attrs.value || ''
    textarea.className = 'edit-textarea'
    textarea.placeholder = 'LaTeX 源码'

    const preview = document.createElement('div')
    preview.className = 'edit-preview'
    preview.innerHTML = renderedHtml

    dom.innerHTML = ''
    dom.appendChild(textarea)
    dom.appendChild(preview)

    function autoHeight() {
      textarea.style.height = `${textarea.scrollHeight}px`
    }

    isolateInputFromProseMirror(textarea)
    textarea.addEventListener('input', (e) => {
      e.stopPropagation()
      autoHeight()
      renderKatex(textarea.value, preview, true)
    })

    textarea.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); cancel() }
      if (e.key === 'Tab') {
        e.preventDefault()
        const start = textarea.selectionStart ?? textarea.value.length
        const end = textarea.selectionEnd ?? textarea.value.length
        textarea.value = textarea.value.slice(0, start) + '\t' + textarea.value.slice(end)
        textarea.selectionStart = textarea.selectionEnd = start + 1
        autoHeight()
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })

    textarea.addEventListener('blur', () => { save() })

    function save() {
      if (!editing) return
      editing = false
      cleanup()
      if (textarea.value !== node.attrs.value) {
        const pos = getPos()
        if (pos >= 0) {
          view.dispatch(view.state.tr.setNodeAttribute(pos, 'value', textarea.value))
        }
        else { showDisplay() }
      }
      else { showDisplay() }
    }

    function cancel() {
      if (!editing) return
      editing = false
      cleanup()
      showDisplay()
    }

    function cleanup() {
      view.dom.classList.remove('prosemirror-caret-hidden')
    }

    ;(dom as any).__mathCleanup = () => { cleanup() }
    setTimeout(() => { textarea.focus(); autoHeight() }, 0)
  }

  dom.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!editing) startEdit()
  })

  showDisplay()

  return {
    dom,
    update(newNode: any) {
      // 同 inline：只在 value 真的变了才重渲染
      const valueChanged = node.attrs.value !== newNode.attrs.value
      node = newNode
      if (!editing && valueChanged) showDisplay()
      return true
    },
    destroy() { ;(dom as any).__mathCleanup?.() },
    ignoreMutation() { return true },
  }
}

// ========== 导出 ==========

export const mathEditPlugin = $prose(() => new Plugin({
  key: new PluginKey('mathEdit'),
  props: {
    nodeViews: {
      math_inline: (node, view, getPos) => createMathInlineView(node, view, getPos as () => number),
      math_block: (node, view, getPos) => createMathBlockView(node, view, getPos as () => number),
    },
  },
}))
