// caller 提供 schema / plugins / 初始 doc / change 回调,
// composable 负责 EditorView 的挂载、销毁,以及把 view 暴露给外层(供 find/replace
// 这种"拿到 view 自己 dispatch"的用例)。
//
// 设计要点:
// - **与 props 解耦**:不直接读 props.modelValue,而是接受 initialDoc。父组件在
//   外部 modelValue 变了时通过 :key 重挂。这与现 EditorInner.vue 的 rebuildRequest
//   策略一致(值对比 → bump innerKey),不在 composable 里做 modelValue watch。
// - **change 回调走 dispatchTransaction 而不是 doc 监听**:dispatchTransaction
//   是 ProseMirror 唯一的状态变更入口,docChanged 是它的字段;走这里能拿到 tr 全貌,
//   后续 hljs class 注入、selection 跟踪都从 tr 上取,而不是再起一个 plugin。
// - **viewRef 用 shallowRef**:EditorView 是巨型对象,Vue 深响应化代理它会爆栈
//   (proxy 拦截 EditorState.tr 等内部属性触发自身 invalidate 循环)。shallowRef
//   只跟踪引用变化,内部属性 Vue 不进 reactive。
// - **destroy 在 onBeforeUnmount**:onUnmounted 时 DOM 已经被 Vue 拆掉,
//   view.destroy() 内部 DOMObserver 还想读 view.dom 属性会报 null。

import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import type { Plugin, Transaction } from 'prosemirror-state'
import type { Node as PMNode, Schema } from 'prosemirror-model'
import { SKIP_CONTENT_EMIT } from '../editor/transactionMeta'
import { setInitialViewportHint, refreshViewport } from '../nodes/viewportPlugin'
import { findScrollAncestor } from './scrollUtils'

export interface UseProseMirrorOptions {
  /** Schema 实例 —— caller 在 editor/schema.ts 装配后传进来。 */
  schema: Schema
  /** 初始 doc。string 走 fromMarkdown,Node 直接用。 */
  initialDoc: PMNode | string
  /** caller 提供的 markdown → doc 适配函数;只在 initialDoc 是 string 时调用。
   *  返回 PMNode（同步）或 Promise<PMNode>（C1: 大文档走 Worker 异步 parse）。 */
  fromMarkdown?: (md: string, schema: Schema) => PMNode | Promise<PMNode>
  /** 全部 ProseMirror 插件(history / keymap / inputrules / 自定义...)按 caller 给的顺序灌入。 */
  plugins: Plugin[]
  /**
   * 文档变化回调。每次 dispatchTransaction 后,如果 tr.docChanged === true 就触发。
   * caller 拿到 doc 自己 toMarkdown 序列化。
   */
  onChange?: (doc: PMNode, tr: Transaction) => void
  /**
   * 选区或文档变化回调。用于光标状态这类 UI-only 信息,不参与 markdown 回写。
   */
  onSelectionChange?: (view: EditorView, tr: Transaction) => void
  /**
   * EditorView 创建完成后的钩子。caller 用来做"挂上 view 后立刻 focus"或者
   * "挂上 view 后重打 hljs class"这种一次性副作用。
   * 此时 viewRef.value 已写入,DOM 已挂载。
   */
  onReady?: (view: EditorView) => void
  /**
   * 大文档(> 2000 行)异步加载完成后的钩子。onReady 时 view 还是空 paragraph,
   * 真实 doc 在双 rAF 后才 view.updateState。此回调在 updateState 后立即触发,
   * caller 用来关闭 loading 遮罩。小文档不触发此回调。
   */
  onLargeDocReady?: () => void
  /**
   * 只读模式。true 时 EditorView.editable 返回 false,ProseMirror 不响应任何
   * 编辑操作(键盘输入 / 粘贴 / 拖放均被忽略)。用于示例文档等不允许直接修改的场景。
   */
  editable?: boolean
}

export interface UseProseMirrorReturn {
  /** 把这个 ref 绑到模板里要承载编辑器的 div 上。EditorView 会在 onMounted 时往里挂 contentDOM。 */
  containerRef: Ref<HTMLElement | null>
  /** 当前 EditorView。在 onMounted 之前是 null;onBeforeUnmount 后置 null。 */
  viewRef: ShallowRef<EditorView | null>
  /** 安全获取当前 view —— 销毁后返回 null,caller 不用自己判 null。 */
  getView: () => EditorView | null
  /**
   * 动态切换只读。view 已挂载时调 `view.setProps({ editable })`;未挂载 no-op
   * (下次 mount 会用 `opts.editable` 初值)。用于示例文档等"挂载后才进入只读"的场景。
   */
  setReadOnly: (readOnly: boolean) => void
  /**
   * 视口滚动归零。view.dom 自身不带 overflow(PM 的 .ProseMirror 是 contentEditable
   * 而非 scroll container),真实滚动容器是上层 (App.vue / index.vue 上的 `overflow-auto`)
   * 包装 div。这里沿祖先链 walk 到第一个 overflow:auto/scroll 的元素,scrollTop = 0。
   * 找不到候选时不报错(no-op),留给 vue 层处理。
   */
  resetScrollToTop: () => void
  /**
   * 视口滚动恢复到指定 px(切标签保留滚动位置)。与 resetScrollToTop 同一个滚动容器,
   * 只是把 0 换成传入值。Step 3 每标签 EditorState 保留用。
   */
  restoreScrollTop: (px: number) => void
}

export function useProseMirror(opts: UseProseMirrorOptions): UseProseMirrorReturn {
  const containerRef = ref<HTMLElement | null>(null)
  const viewRef = shallowRef<EditorView | null>(null)

  onMounted(() => {
    const container = containerRef.value
    if (!container) {
      console.warn('[useProseMirror] containerRef 未挂载,跳过 EditorView 创建')
      return
    }

    // 大文档(> 2000 行):先创建空 doc 的 view,再异步解析真实 doc。
    // 避免同步 fromMarkdown 阻塞主线程数百毫秒,让 UI 先渲染编辑器容器。
    const isLargeStringDoc = typeof opts.initialDoc === 'string'
      && opts.initialDoc.split('\n').length > 2000

    let doc: PMNode
    if (typeof opts.initialDoc === 'string') {
      if (isLargeStringDoc) {
        // 先用空 paragraph 占位,让 view 立即可交互
        doc = opts.schema.node('doc', null, [opts.schema.node('paragraph')])
      } else {
        // 非大文档：fromMarkdown 同步返回 PMNode。
        // 大文档（返回 Promise）走 isLargeStringDoc 分支的 rAF 异步路径。
        doc = opts.fromMarkdown
          ? opts.fromMarkdown(opts.initialDoc, opts.schema) as PMNode
          : (() => { throw new Error('[useProseMirror] initialDoc 是 string 但未提供 fromMarkdown') })()
      }
    } else {
      doc = opts.initialDoc
    }

    const state = EditorState.create({
      schema: opts.schema,
      doc,
      plugins: opts.plugins,
    })

    const view = new EditorView(container, {
      state,
      editable: () => opts.editable ?? true,
      // 走自定义 dispatchTransaction —— 既应用到 view,又把 tr 喂给 onChange。
      // 不在这里序列化为 markdown,留给 caller(它有 schema 上下文)。
      dispatchTransaction(tr) {
        const next = view.state.apply(tr)
        view.updateState(next)
        // SKIP_CONTENT_EMIT:进入编辑态这类瞬时结构变更(image→源码文本)不应
        // 触发内容回写 —— 详见 editor/transactionMeta.ts。选区回调照常走。
        // 源码编辑 session 活跃时的转义补偿由 EditorInner.vue 的 onChange 自行处理
        // (用占位符绕过 toMarkdown 对源码文本的转义),此处不再拦截。
        if (tr.docChanged && opts.onChange && !tr.getMeta(SKIP_CONTENT_EMIT)) {
          opts.onChange(next.doc, tr)
        }
        if ((tr.docChanged || tr.selectionSet) && opts.onSelectionChange) {
          opts.onSelectionChange(view, tr)
        }
      },
    })

    viewRef.value = view
    opts.onReady?.(view)

    // C1: 大文档异步解析。双 rAF 让浏览器先 paint 空编辑器 + loading 遮罩,
    // 再调 fromMarkdown。fromMarkdown 可能返回 Promise(Worker parse),
    // Promise.resolve 统一处理 sync / async 两种返回。
    if (isLargeStringDoc && opts.fromMarkdown && typeof opts.initialDoc === 'string') {
      const md = opts.initialDoc
      // 保存初始 state 引用——异步链完成前若 modelValue watch 已调
      // view.updateState（用户快速切了 tab），view.state !== initialState → 中止
      const initialState = state
      requestAnimationFrame(() => {
        if (view.isDestroyed) return
        requestAnimationFrame(() => {
          if (view.isDestroyed) return
          const result = opts.fromMarkdown!(md, opts.schema)
          Promise.resolve(result).then(realDoc => {
            if (view.isDestroyed) return
            // 冷启动竞态守卫：若 view.state 已被 modelValue watch 替换
            // （用户在 rAF / Worker 期间切到另一个文件），中止加载初始大文档
            if (view.state !== initialState) return
            // C1: 预设窄 viewport hint，避免 updateState 时为整个大文档构建装饰
            setInitialViewportHint({ from: 0, to: 5000 })
            const newState = EditorState.create({
              schema: opts.schema,
              doc: realDoc,
              plugins: opts.plugins,
            })
            setInitialViewportHint(null)
            view.updateState(newState)
            // view factory 的 rAF 在空段落时就跑过了；updateState 换成真实 doc
            // 后需手动刷新 viewport
            requestAnimationFrame(() => refreshViewport(view))
            opts.onLargeDocReady?.()
          })
        })
      })
    }
  })

  onBeforeUnmount(() => {
    const view = viewRef.value
    if (view) {
      view.destroy()
      viewRef.value = null
    }
  })

  function getView(): EditorView | null {
    return viewRef.value
  }

  function setReadOnly(readOnly: boolean): void {
    const view = viewRef.value
    if (!view) return
    view.setProps({ editable: () => !readOnly })
  }

  function resetScrollToTop(): void {
    const view = viewRef.value
    if (!view) return
    const target = findScrollAncestor(view.dom)
    if (target) target.scrollTop = 0
  }

  function restoreScrollTop(px: number): void {
    const view = viewRef.value
    if (!view) return
    const target = findScrollAncestor(view.dom)
    if (target) target.scrollTop = px
  }

  return { containerRef, viewRef, getView, setReadOnly, resetScrollToTop, restoreScrollTop }
}
