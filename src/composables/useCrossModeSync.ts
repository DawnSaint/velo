// 跨模式光标 + 浏览状态同步 + 行号模式会话
//
// 三套逻辑:
//   1. toggleSourceMode() 翻转 sourceMode → v-if 互换两个编辑器,两边卸载重挂,
//      光标/滚动在 DOM 层丢失。在翻转**前**(flush:'pre',出方向组件尚未卸载)
//      从出方向 view 抓文本锚点,翻转后(nextTick,入方向 onMounted 已建 view)应用。
//   2. : 行号模式会话(lineSession):输入 : 时记原模式 + 光标锚点(不切源码,只收起面板 +
//      显示 hint);用户敲行号时才切源码(switched=true)。Enter 确认(留源码)、Esc/离开/关闭
//      取消(恢复光标 + 切回原模式)。pendingPreview 缓冲"切源码中"已敲的行号,CM6 挂载后由本
//      watch 补跳。pendingLineRestore 用于取消切回 WYSIWYG 时用原锚点覆盖 anchor 恢复。
//   3. 标题跳转(WYSIWYG 走 DOM / 源码走 raw markdown 行定位),命令面板 @ 符号模式 +
//      Breadcrumbs 点击复用。

import { nextTick, ref, watch, type Ref } from 'vue'
import { TextSelection } from 'prosemirror-state'
import { useDocumentStore } from '@/stores/document'
import { captureAnchor, applyAnchor, type CrossModeAnchor } from '@/components/crossModeSync'
import { revealHeadingInDom, findHeadingRawOffset, findLineOffset } from '@/utils/revealHeading'
import { cmLineHighlightEffect } from '@/components/ProseMirrorEditor/findreplace/cmLineHighlight'
import type { FindReplaceBackend } from '@/components/ProseMirrorEditor/findreplace/backend'
import type { HeadingBreadcrumb } from '@/utils/breadcrumbs'
import ProseMirrorEditor from '@/components/ProseMirrorEditor/index.vue'
import SourceModeEditor from '@/components/SourceModeEditor.vue'

export function useCrossModeSync(opts: {
  editorRef: Ref<InstanceType<typeof ProseMirrorEditor> | null>
  srcRef: Ref<InstanceType<typeof SourceModeEditor> | null>
  quickCommandOpen: Ref<boolean>
  getActiveBackend: () => FindReplaceBackend | null
}) {
  const documentStore = useDocumentStore()
  const { editorRef, srcRef, quickCommandOpen, getActiveBackend } = opts

  // 对象包装:空文档锚点为 null 也不漏(避免 fallthrough 到正常 anchor 恢复)
  const lineSession = ref<{
    originalMode: boolean
    pmAnchor: CrossModeAnchor | null  // WYSIWYG 原锚点(切回时恢复)
    cmPos: number  // 源码原光标(源码下取消恢复,不 focus 避免抢输入框)
    pendingPreview: number | null
    switched: boolean  // 是否切过源码(WYSIWYG→source)
  } | null>(null)
  const pendingLineRestore = ref<{ anchor: CrossModeAnchor | null } | null>(null)

  watch(
    () => documentStore.sourceMode,
    async (now, prev) => {
      // 1. : 取消恢复:切回 WYSIWYG 时用原锚点(而非当前 CM6 光标,它在预览行)
      if (pendingLineRestore.value) {
        const a = pendingLineRestore.value.anchor
        pendingLineRestore.value = null
        await nextTick()
        if (!now && a) applyAnchor(editorRef.value?.getEditorView(), 'pm', a)
        return
      }
      // 2. : 行号 live-preview:切源码挂载后补跳用户已敲的行号(跳过 anchor 恢复)
      if (lineSession.value && lineSession.value.pendingPreview != null) {
        const n = lineSession.value.pendingPreview
        lineSession.value.pendingPreview = null
        await nextTick()
        if (now) applyLinePreview(n)
        return
      }
      // 3. 正常跨模式光标恢复(原行为)
      // 出方向:prev=true 曾是源码(CM6 出),prev=false 曾是 WYSIWYG(PM 出)
      const anchor = prev
        ? captureAnchor(srcRef.value?.view, 'cm')
        : captureAnchor(editorRef.value?.getEditorView(), 'pm')
      await nextTick()
      if (!anchor) return // 抓不到(空文档 / 极短)→ 静默放弃
      // 入方向:now=true 进源码(CM6 入),now=false 进 WYSIWYG(PM 入)
      if (now) applyAnchor(srcRef.value?.view, 'cm', anchor)
      else applyAnchor(editorRef.value?.getEditorView(), 'pm', anchor)
    },
    { flush: 'pre' },
  )

  // 统一命令面板 @ 符号模式 + Breadcrumbs 点击跳转:跳转到当前文档指定标题。
  // WYSIWYG 走 DOM(与 EditorOutline 同款 revealHeadingInDom),source 走 raw markdown
  // 行定位 → CM6 doc offset(源码文档即原始 markdown,offset == pos)→ backend 跳转。
  //
  // **WYSIWYG 选区同步**:revealHeadingInDom 返回命中的标题 DOM 元素后,
  // 用 view.posAtDOM 把 PM 选区设到标题开头,再 focus。否则 focus 会触发浏览器
  // 把旧选区滚入视口,标题被滚走 → 高亮一闪而过(命令面板 / 面包屑都踩此坑)。
  function onRevealHeading({ level, displayText }: { level: number, displayText: string }) {
    if (documentStore.sourceMode) {
      const offset = findHeadingRawOffset(documentStore.content, level, displayText)
      if (offset < 0) return
      const be = getActiveBackend()
      if (!be) return
      be.setSelection(offset, offset)
      be.scrollMatchIntoView(offset)
      be.focus()
      return
    }
    const el = revealHeadingInDom(level, displayText)
    const view = editorRef.value?.getEditorView()
    if (el && view) {
      const pos = view.posAtDOM(el, 0)
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))))
    }
    view?.focus()
  }

  function onBreadcrumbReveal(h: HeadingBreadcrumb) {
    onRevealHeading({ level: h.level, displayText: h.text })
  }

  // 统一命令面板 : 行号模式:实时滚动 + 高亮第 N 行,跨模式会话恢复。
  // 行号是源码概念。输入 : 时只收起面板 + 显示 hint(onLineEnter 记原模式 + 锚点,不切源码);
  // 用户敲行号时才切源码(CM6 doc === raw markdown,offset == pos)+ 实时 setSelection +
  // 滚动 + 行高亮(cmLineHighlightEffect)。Enter 确认(留源码)、Esc/离开/关闭 取消(恢复)。
  function onLineEnter() {
    if (lineSession.value) return
    const originalMode = documentStore.sourceMode
    const pmAnchor = originalMode ? null : captureAnchor(editorRef.value?.getEditorView(), 'pm')
    const cmPos = originalMode ? (srcRef.value?.view?.state.selection.main.head ?? 0) : 0
    lineSession.value = { originalMode, pmAnchor, cmPos, pendingPreview: null, switched: false }
  }

  /** 把第 N 行滚到中线 + 高亮。CM6 未就绪(切源码中)返回 false,交由 sync watch 补跳。 */
  function applyLinePreview(n: number): boolean {
    const view = srcRef.value?.view
    const be = getActiveBackend()
    if (!view || !be || !documentStore.sourceMode) return false
    const offset = findLineOffset(documentStore.content, n)
    be.setSelection(offset, offset)
    be.scrollMatchIntoView(offset)
    view.dispatch({ effects: cmLineHighlightEffect.of(n) })
    return true
  }

  function onLinePreview(n: number | null) {
    const s = lineSession.value
    if (!s) return
    if (n == null) {
      srcRef.value?.view?.dispatch({ effects: cmLineHighlightEffect.of(null) })
      s.pendingPreview = null
      return
    }
    if (documentStore.sourceMode) {
      // 已在源码:直接跳(applyLinePreview 不 focus,不抢输入框)
      if (applyLinePreview(n)) s.pendingPreview = null
      else s.pendingPreview = n
    } else {
      // WYSIWYG:敲了行号才切源码;sync watch 挂载后补跳
      s.pendingPreview = n
      s.switched = true
      documentStore.toggleSourceMode()
    }
  }

  function onLineConfirm() {
    // 留在源码模式,光标已在预览行;清高亮
    srcRef.value?.view?.dispatch({ effects: cmLineHighlightEffect.of(null) })
    lineSession.value = null
  }

  function onLineCancel() {
    const s = lineSession.value
    if (!s) return
    lineSession.value = null
    srcRef.value?.view?.dispatch({ effects: cmLineHighlightEffect.of(null) })
    if (s.switched) {
      // 切过源码(原 WYSIWYG)→ 切回 + 恢复原 PM 锚点(sync watch 用 pendingLineRestore 覆盖)
      pendingLineRestore.value = { anchor: s.pmAnchor }
      documentStore.toggleSourceMode()
    } else if (s.originalMode) {
      // 原是源码、预览过 → 恢复原 CM6 光标(setSelection 不 focus,避免抢输入框)
      const be = getActiveBackend()
      if (be) {
        be.setSelection(s.cmPos, s.cmPos)
        be.scrollMatchIntoView(s.cmPos)
      }
    }
    // else: 只打了 : 未切未预览 → 无需恢复
  }

  // 面板关闭兜底:面板是 v-if 卸载,open watcher 来不及发 line-cancel(尤其输入框失焦时
  // Esc 走 onGlobalKeydown 只 close)。这里单点监听 quickCommandOpen 落 false,
  // 若 : 会话仍在 → 跑取消恢复。已 emit 过 line-cancel 的话 lineSession 已清,no-op。
  watch(quickCommandOpen, (open) => {
    if (!open && lineSession.value) onLineCancel()
  })

  return {
    onRevealHeading,
    onBreadcrumbReveal,
    onLineEnter,
    onLinePreview,
    onLineConfirm,
    onLineCancel,
  }
}
