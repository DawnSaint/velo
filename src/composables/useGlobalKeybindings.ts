// 全局快捷键注册与分发
//
// 两类 keydown listener:
//   1. onKeydown —— Ctrl/Cmd 组合键(S/F/H/N/O/E/P/R/` 等),capture 阶段
//      + preventDefault 压过浏览器内置 find-in-page / 刷新。
//   2. onFKey —— F11 全屏 / F8 专注 / F9 打字机 / F12 DevTools
//
// 注册时机:composable 的 onMounted(Vue FIFO,先于 App.vue onMounted 执行)。
// keydown 监听必须在启动期 await 链路(读盘、invoke、openPath)之前挂上 ——
// 否则用户在 await 期间按 Ctrl+F 浏览器自己的 find 会先开,handler 还没挂
// 就拦不住了。capture 阶段 + preventDefault 是另一道保险。

import { onMounted, onBeforeUnmount, type Ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useDocumentStore } from '@/stores/document'
import { useExportStore } from '@/stores/export'
import { useWorkspaceStore } from '@/stores/workspace'

export function useGlobalKeybindings(opts: {
  tauri: boolean
  quickCommandOpen: Ref<boolean>
  quickCommandInitialQuery: Ref<string>
  createNewAppWindow: () => void
  openFind: () => void
  openReplace: () => void
  openWorkspaceSearch: () => void
  openCommandPalette: () => void
  openQuickOpen: () => void
  toggleFullscreen: () => void
  toggleFocusMode: () => void
  toggleTypewriterMode: () => void
}): void {
  const documentStore = useDocumentStore()
  const exportStore = useExportStore()
  const workspaceStore = useWorkspaceStore()
  const { tauri } = opts

  // 全局 Ctrl/Cmd+S / Ctrl/Cmd+F / Ctrl/Cmd+H
  //
  // 必须 capture 阶段 + preventDefault 才能压过浏览器自己的 Ctrl+F (find in page)。
  // 浏览器在 keydown 冒泡结束后才决定是否开内置 find,我们在 capture 阶段就
  // preventDefault,事件到达目标元素前 default action 已被标记为取消。
  // stopPropagation 防止冒泡到其他 window/document 上的扩展 / 第三方脚本再开一次。
  function onKeydown(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey)) return
    const k = e.key.toLowerCase()
    // Ctrl+F(capture 阶段)无条件 preventDefault —— 必须先压过 webview 内置的
    // "find in page" 搜索框,再决定行为分发:焦点在 FindReplace 内 → 让面板处理
    // (closest 命中,return);否则 → 走下面的 openFind。不能在 closest 检查之后
    // 再 preventDefault,否则焦点在面板内时 return 时 default action 还没被
    // 拦,WebView2 仍会弹内置搜索框。
    if (k === 'f' && !e.shiftKey) e.preventDefault()
    const target = e.target as HTMLElement | null
    // 焦点在 FindReplace / 命令面板里 → 让面板自己处理(避免双触发)。
    // WorkspaceSearchPanel 不挂这条:它的输入框只接 ArrowUp/Down/Enter/Esc,
    // 不抢 Ctrl+F / Ctrl+Shift+F 等全局快捷键 —— 焦点在搜索框内仍允许触发
    // 文档级查找、再次激活搜索等动作。
    if (target?.closest('[data-fr-panel], [data-quick-command-panel]')) return
    if (k === 's' && e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      void documentStore.saveAs()
    }
    else if (k === 's') {
      e.preventDefault()
      e.stopPropagation()
      void documentStore.save()
    }
    else if (k === 'n' && e.shiftKey) {
      if (!tauri) return
      e.preventDefault()
      e.stopPropagation()
      void opts.createNewAppWindow()
    }
    else if (k === 'n') {
      e.preventDefault()
      e.stopPropagation()
      documentStore.newDoc()
    }
    else if (k === 'o') {
      e.preventDefault()
      e.stopPropagation()
      void documentStore.open()
    }
    else if (k === 'f' && e.shiftKey) {
      // Ctrl+Shift+F 工作区全文搜索(v0.5.2,v0.6.x 改为侧栏 tab):无工作区静默。
      // 不 toggle —— 已在 search tab 时也不关闭;有选区时把内容塞进搜索框。
      if (!workspaceStore.activeRoot) return
      e.preventDefault()
      e.stopPropagation()
      opts.openWorkspaceSearch()
    }
    else if (k === 'f') {
      e.preventDefault()
      e.stopPropagation()
      opts.openFind()
    }
    else if (k === 'h') {
      e.preventDefault()
      e.stopPropagation()
      opts.openReplace()
    }
    else if (k === '`') {
      e.preventDefault()
      e.stopPropagation()
      documentStore.toggleSourceMode()
    }
    else if (k === 'e' && e.shiftKey) {
      // 导出(Ctrl/Cmd+Shift+E):走原生 saveDialog 多 filter(HTML / PDF)
      e.preventDefault()
      e.stopPropagation()
      void exportStore.exportDocument()
    }
    else if (k === 'p' && e.shiftKey) {
      // Ctrl+Shift+P 命令模式(v0.6.2):已开在同模式 → 关,否则切到 '>' 命令模式
      e.preventDefault()
      e.stopPropagation()
      if (opts.quickCommandOpen.value && opts.quickCommandInitialQuery.value === '>') opts.quickCommandOpen.value = false
      else opts.openCommandPalette()
    }
    else if (k === 'p' && !e.shiftKey) {
      // Ctrl+P 查找文件(v0.6.2):无工作区静默;已开在同模式 → 关,否则切到 '' 文件模式
      if (!workspaceStore.activeRoot) return
      e.preventDefault()
      e.stopPropagation()
      if (opts.quickCommandOpen.value && opts.quickCommandInitialQuery.value === '') opts.quickCommandOpen.value = false
      else opts.openQuickOpen()
    }
    else if (k === 'r' && e.shiftKey) {
      // 阅读模式 toggle(Ctrl/Cmd+Shift+R):复用 Ctrl+Shift+R 这个本属浏览器硬刷新
      // 的快捷键 —— 应用层 capture 阶段 preventDefault 让 webview 永远拿不到刷新信号。
      // 与下文 Ctrl+R / F5 拦截配合,桌面 markdown editor 下不存在"误刷新丢未保存"的路径。
      e.preventDefault()
      e.stopPropagation()
      documentStore.readOnly = !documentStore.readOnly
    }
  }

  // F11 切全屏 + F12 打开 WebView DevTools —— Cargo.toml 开了 `devtools` feature,release 包也能用。
  // tauri command `open_devtools` 在 src-tauri/src/lib.rs 注册。dev 环境 Vite/浏览器
  // 自带 F12,这里 invoke 会失败,catch 掉就行。
  function onFKey(e: KeyboardEvent) {
    if (e.key === 'F11' && tauri) {
      e.preventDefault()
      void opts.toggleFullscreen()
      return
    }
    if (e.key === 'F8') {
      e.preventDefault()
      opts.toggleFocusMode()
      return
    }
    if (e.key === 'F9') {
      e.preventDefault()
      opts.toggleTypewriterMode()
      return
    }
    if (e.key === 'F12' && tauri) {
      e.preventDefault()
      void invoke('open_devtools').catch(() => { /* dev 环境无此 command,忽略 */ })
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeydown, { capture: true })
    window.addEventListener('keydown', onFKey)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown, { capture: true })
    window.removeEventListener('keydown', onFKey)
  })
}
