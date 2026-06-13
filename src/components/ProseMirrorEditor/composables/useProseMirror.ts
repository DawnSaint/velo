// 替代 @milkdown/vue 的 useEditor() + <Milkdown />。
//
// 旧 Milkdown 路径里:`useEditor((root) => Editor.make().config(...).use(...))` 把
// 创建/销毁/挂载交给 @milkdown/vue,容器由 <Milkdown /> 提供。
// 这里直接走裸 ProseMirror:caller 提供 schema / plugins / 初始 doc / change 回调,
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

export interface UseProseMirrorOptions {
  /** Schema 实例 —— caller 在 editor/schema.ts 装配后传进来。 */
  schema: Schema
  /** 初始 doc。string 走 fromMarkdown,Node 直接用。 */
  initialDoc: PMNode | string
  /** caller 提供的 markdown → doc 适配函数;只在 initialDoc 是 string 时调用。 */
  fromMarkdown?: (md: string, schema: Schema) => PMNode
  /** 全部 ProseMirror 插件(history / keymap / inputrules / 自定义...)按 caller 给的顺序灌入。 */
  plugins: Plugin[]
  /**
   * 文档变化回调。每次 dispatchTransaction 后,如果 tr.docChanged === true 就触发。
   * caller 拿到 doc 自己 toMarkdown 序列化。
   */
  onChange?: (doc: PMNode, tr: Transaction) => void
  /**
   * EditorView 创建完成后的钩子。caller 用来做"挂上 view 后立刻 focus"或者
   * "挂上 view 后重打 hljs class"这种一次性副作用。
   * 此时 viewRef.value 已写入,DOM 已挂载。
   */
  onReady?: (view: EditorView) => void
}

export interface UseProseMirrorReturn {
  /** 把这个 ref 绑到模板里要承载编辑器的 div 上。EditorView 会在 onMounted 时往里挂 contentDOM。 */
  containerRef: Ref<HTMLElement | null>
  /** 当前 EditorView。在 onMounted 之前是 null;onBeforeUnmount 后置 null。 */
  viewRef: ShallowRef<EditorView | null>
  /** 安全获取当前 view —— 销毁后返回 null,caller 不用自己判 null。 */
  getView: () => EditorView | null
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

    const doc = typeof opts.initialDoc === 'string'
      ? opts.fromMarkdown
        ? opts.fromMarkdown(opts.initialDoc, opts.schema)
        : (() => { throw new Error('[useProseMirror] initialDoc 是 string 但未提供 fromMarkdown') })()
      : opts.initialDoc

    const state = EditorState.create({
      schema: opts.schema,
      doc,
      plugins: opts.plugins,
    })

    const view = new EditorView(container, {
      state,
      // 走自定义 dispatchTransaction —— 既应用到 view,又把 tr 喂给 onChange。
      // 不在这里序列化为 markdown,留给 caller(它有 schema 上下文)。
      dispatchTransaction(tr) {
        const next = view.state.apply(tr)
        view.updateState(next)
        if (tr.docChanged && opts.onChange) {
          opts.onChange(next.doc, tr)
        }
      },
    })

    viewRef.value = view
    opts.onReady?.(view)
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

  return { containerRef, viewRef, getView }
}
