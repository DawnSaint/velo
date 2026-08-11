// 多行可编辑 NodeView 的 textarea + preview 共用壳。
//
// 适用场景:NodeView 内部要编辑一段源码(LaTeX / mermaid ...),实时预览
// 同步显示渲染结果。helper 管 textarea 的输入/keydown/blur/focus/autoSize,
// 调用方只关心 preview 怎么渲染、onCommit 怎么把 value 写回 doc。
//
// 用法:
//   const ed = createTextareaEditor({
//     initialValue: node.attrs.value || '',
//     placeholder: 'LaTeX 源码',
//     onCommit: (value) => { /* view.dispatch(...) */ },
//     onCancel: () => { /* 退出编辑 */ },
//   })
//   dom.appendChild(ed.container)
//   ed.setPreviewHtml(initialPreviewHtml)      // 放初始参考预览
//   // 业务 input 监听(实时预览)
//   ed.textarea.addEventListener('input', () => renderPreview(ed.textarea.value))
//
// helper 自带的行为:
// - input/textarea 用 isolateInputFromProseMirror 隔开 ProseMirror
// - Tab → 当前光标处插 \t,autoSize 跟随
// - Escape → onCancel
// - blur  → onCommit(value),由调用方决定怎么 dispatch
// - input 事件 stopPropagation 防止冒泡,autoSize 始终生效
//
// 为什么不抽成 Vue SFC:这些操作要直接接 ProseMirror view / DOM,
// 引一层 Vue 反而多绕;函数式 helper 单元测也好写。

export interface TextareaEditorOptions {
  initialValue: string
  placeholder: string
  /** blur 时触发,把 value 写回 doc 由调用方决定怎么 dispatch。 */
  onCommit: (value: string) => void
  /** Escape 时触发。 */
  onCancel: () => void
}

export interface TextareaEditor {
  /** wrapper,内部已包含 textarea + preview。caller 整个 append 到自己 dom 里。 */
  container: HTMLElement
  textarea: HTMLTextAreaElement
  preview: HTMLElement
  /** 把 html 直接塞进 preview.innerHTML,简单一层包装避免 caller 漏看 preview 引用。 */
  setPreviewHtml: (html: string) => void
  /** 焦点到 textarea。内部 setTimeout(0) 等 caller 把 container 挂上 dom。 */
  focus: () => void
  /** 移除 caret hidden。caller 在 NodeView 的 destroy() 调,保证编辑中途销毁不留残影。 */
  dispose: () => void
}

export function createTextareaEditor(opts: TextareaEditorOptions): TextareaEditor {
  const textarea = document.createElement('textarea')
  textarea.value = opts.initialValue
  textarea.className = 'edit-textarea'
  textarea.placeholder = opts.placeholder

  const preview = document.createElement('div')
  preview.className = 'edit-preview'

  const container = document.createElement('div')
  container.appendChild(textarea)
  container.appendChild(preview)

  isolateInputFromProseMirror(textarea)
  textarea.addEventListener('input', (e) => {
    e.stopPropagation()
    autoHeightFor(textarea)
  })
  textarea.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); opts.onCancel() }
    if (e.key === 'Tab') {
      e.preventDefault()
      insertTabAtCursor(textarea)
      // 合成 input 事件会触发 input 监听,那里跑 autoSize
    }
  })
  textarea.addEventListener('blur', () => { opts.onCommit(textarea.value) })

  // 初始高度适配。setTimeout(0) 等 caller 把 container appendChild 上去,
  // 之后 scrollHeight 才反映真实 layout;input 事件挂在这之后才注册,
  // 第一次 size 不会触发 input(没有字符变化),所以这里显式跑一次。
  setTimeout(() => { autoHeightFor(textarea) }, 0)

  return {
    container,
    textarea,
    preview,
    setPreviewHtml: (html) => { preview.innerHTML = html },
    focus: () => { setTimeout(() => { textarea.focus() }, 0) },
    dispose: () => {
      // 把 container 从 dom 移除(如果还在树里)
      if (container.parentNode) container.parentNode.removeChild(container)
    },
  }
}

// ============================================================
// 下面几个小 helper:createTextareaEditor 内部用,inline math (用 <input>
// 而非 textarea) 也复用。保持同文件以便一处维护 / 一处理解。
// ============================================================

/**
 * capture 阶段拦 mousedown,防止 ProseMirror 在 mouseup 链上抢 selection。
 *
 * 背景:ProseMirror 自己的 mousedown 挂在 `view.dom` 的 bubble 阶段,
 * 如果不在 capture 提前 stopPropagation,bubble 阶段它会先跑,
 * 执行 selectClickedNode / selectClickedLeaf 把光标塞进原子节点,
 * 后续的 click / setSelection 都会被撤销。
 */
export function stopMousedownPropagation(el: HTMLElement): void {
  el.addEventListener('mousedown', (e) => { e.stopPropagation() }, true)
}

/**
 * 给 NodeView 里的 input / textarea 挂上 `beforeinput` + `paste` 的
 * `stopPropagation`,把外层 ProseMirror 隔开。
 *
 * - 只 `stopPropagation`,**不** `preventDefault`(后者会取消输入/粘贴的
 *   默认行为)。粘贴板的纯文本仍能进 textarea,只是不让 ProseMirror 看到。
 * - `paste` 走自己的事件不经过 `beforeinput`,必须单独挂。
 */
function isolateInputFromProseMirror(el: HTMLElement): void {
  el.addEventListener('beforeinput', (e) => { e.stopPropagation() })
  el.addEventListener('paste', (e) => { e.stopPropagation() })
}

/**
 * input / textarea 在当前光标处插一个 `\t`,然后派合成的 `input` 事件,
 * 让原本的 `input` 监听者(实时预览 / autoSize / 业务回调)感知到变化。
 *
 * 用在 keydown 的 Tab 分支里 —— 调用前**自己**记得 `preventDefault()`。
 */
function insertTabAtCursor(el: HTMLInputElement | HTMLTextAreaElement): void {
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? el.value.length
  el.value = el.value.slice(0, start) + '\t' + el.value.slice(end)
  el.selectionStart = el.selectionEnd = start + 1
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** textarea 高度撑到 `scrollHeight`,让内容多少行就高多少行,无内部滚动条。 */
function autoHeightFor(textarea: HTMLTextAreaElement): void {
  textarea.style.height = `${textarea.scrollHeight}px`
}
