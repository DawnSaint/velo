import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import mermaid from 'mermaid'

// ========== 唯一 ID 生成 ==========

let nextId = 1
function uid(): string {
  return `mermaid-${nextId++}`
}

// ========== HTML 转义 ==========

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// ========== Mermaid 初始化 ==========

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'default',
})

function getMermaidTheme(): 'default' | 'dark' {
  const editor = document.querySelector('.milkdown-editor')
  if (editor && editor.classList.contains('dark')) return 'dark'
  return 'default'
}

// ========== 异步渲染 ==========

interface RenderOutcome {
  svg: string
  bindFunctions?: (element: Element) => void
  error: string | null
}

async function renderMermaid(code: string, id: string): Promise<RenderOutcome> {
  const trimmed = code.trim()
  if (!trimmed) return { svg: '', error: null }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: getMermaidTheme(),
  })

  try {
    await mermaid.parse(trimmed)
  }
  catch (e: any) {
    return { svg: '', error: e?.message || 'Syntax error' }
  }

  try {
    const result = await mermaid.render(id, trimmed)
    return { svg: result.svg, bindFunctions: result.bindFunctions, error: null }
  }
  catch (e: any) {
    return { svg: '', error: e?.message || 'Render error' }
  }
}

// ========== NodeView ==========

function createMermaidView(node: any, view: any, getPos: () => number) {
  const dom = document.createElement('div')
  dom.className = 'mermaid-node'
  let editing = false
  let lastRenderId = ''

  dom.addEventListener('mousedown', (e: Event) => { e.stopPropagation() }, true)

  // ------ 渲染态 ------
  function showDisplay() {
    if (editing) return
    dom.innerHTML = ''
    dom.classList.remove('is-editing')

    const source = (node.attrs.value || '').trim()

    if (!source) {
      const placeholder = document.createElement('div')
      placeholder.className = 'mermaid-placeholder'
      placeholder.textContent = '点击添加 Mermaid 图表'
      dom.appendChild(placeholder)
      return
    }

    const loader = document.createElement('div')
    loader.className = 'mermaid-loading'
    loader.textContent = '渲染中...'
    dom.appendChild(loader)

    const myId = uid()
    lastRenderId = myId

    renderMermaid(source, myId).then((result) => {
      if (editing || lastRenderId !== myId) return
      dom.innerHTML = ''

      if (result.error) {
        const errorEl = document.createElement('div')
        errorEl.className = 'mermaid-error'
        errorEl.innerHTML = `<span class="mermaid-error-icon">!</span>
          <span class="mermaid-error-msg">${escapeHtml(result.error)}</span>
          <span class="mermaid-error-hint">点击编辑</span>`
        dom.appendChild(errorEl)
      }
      else {
        dom.innerHTML = result.svg
        if (result.bindFunctions) result.bindFunctions(dom)
        const svgEl = dom.querySelector('svg')
        if (svgEl) svgEl.style.height = 'auto'
      }
    })
  }

  // ------ 编辑态 ------
  function startEdit() {
    if (editing) return
    editing = true

    // 保存当前渲染内容作为灰色参考
    const renderedHtml = dom.innerHTML
    lastRenderId = ''
    dom.classList.add('is-editing')
    view.dom.classList.add('prosemirror-caret-hidden')

    const textarea = document.createElement('textarea')
    textarea.value = node.attrs.value || ''
    textarea.className = 'edit-textarea'
    textarea.placeholder = 'graph TD\n  A[开始] --> B[结束]'

    const preview = document.createElement('div')
    preview.className = 'edit-preview'
    preview.innerHTML = renderedHtml

    dom.innerHTML = ''
    dom.appendChild(textarea)
    dom.appendChild(preview)

    function autoHeight() {
      textarea.style.height = `${textarea.scrollHeight}px`
    }

    // 实时预览：debounce + stale 丢弃
    let lastPreviewCode = ''
    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    function schedulePreview(code: string) {
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => { debounceTimer = null; doPreview(code) }, 400)
    }

    function doPreview(code: string) {
      if (lastPreviewCode === code) return
      lastPreviewCode = code
      const trimmed = code.trim()

      if (!trimmed) {
        preview.innerHTML = ''
        return
      }

      preview.innerHTML = '<div class="mermaid-loading">渲染中...</div>'
      const pid = uid()

      renderMermaid(trimmed, pid).then((result) => {
        if (lastPreviewCode !== code) return
        preview.innerHTML = ''
        if (result.error) {
          preview.innerHTML = `<span class="mermaid-error">${escapeHtml(result.error)}</span>`
        }
        else {
          preview.innerHTML = result.svg
          const svgEl = preview.querySelector('svg')
          if (svgEl) svgEl.style.height = 'auto'
        }
      })
    }

    textarea.addEventListener('beforeinput', (e) => { e.stopPropagation() })
    textarea.addEventListener('input', (e) => {
      e.stopPropagation()
      autoHeight()
      schedulePreview(textarea.value)
    })
    // 初始渲染
    schedulePreview(textarea.value)

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
        else {
          node.attrs.value = textarea.value
          showDisplay()
        }
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

    ;(dom as any).__mermaidCleanup = () => { cleanup() }
    setTimeout(() => { textarea.focus(); autoHeight() }, 0)
  }

  dom.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!editing) startEdit()
  })

  // 主题切换不会产生 ProseMirror transaction，所以 update() 不会触发；
  // 这里直接监听 App.vue 在 darkMode 变化时派发的事件，强制重渲染一次。
  const onThemeChange = () => {
    if (editing) return
    if (!(node.attrs.value || '').trim()) return
    showDisplay()
  }
  window.addEventListener('velo:theme-change', onThemeChange)

  showDisplay()

  return {
    dom,
    update(newNode: any) {
      // ProseMirror 每次文档变化都会调 update()，但只要 value 没变就不重渲染
      const valueChanged = node.attrs.value !== newNode.attrs.value
      node = newNode
      if (!editing && valueChanged) showDisplay()
      return true
    },
    destroy() {
      window.removeEventListener('velo:theme-change', onThemeChange)
      ;(dom as any).__mermaidCleanup?.()
    },
    ignoreMutation() { return true },
  }
}

// ========== 导出 ==========

export const mermaidEditPlugin = $prose(() => new Plugin({
  key: new PluginKey('mermaidEdit'),
  props: {
    nodeViews: {
      mermaid: (node, view, getPos) => createMermaidView(node, view, getPos as () => number),
    },
  },
}))
