<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { useDocumentStore } from '@/stores/document'
import { useOutlineStore } from '@/stores/outline'
import { loadSettings, saveSettings, loadOutlineState, saveOutlineState, type PersistedSettings } from '@/stores/persistence'
import MilkdownEditor from '@/components/MilkdownEditor/index.vue'
import EditorSettings from '@/components/EditorSettings.vue'
import EditorOutline from '@/components/EditorOutline.vue'
import DraftRecoveryDialog from '@/components/DraftRecoveryDialog.vue'
import sampleMd from '@/assets/sample.md?raw'
import veloLogo from '@/assets/Velo.png'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { confirm } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'

const store = useEditorStore()
const documentStore = useDocumentStore()
const outlineStore = useOutlineStore()

// 同步把初始 sample 装入 store —— 必须早于 MilkdownEditor 子组件 mount，
// 这样子组件第一次拿到的 props.modelValue 就是 sampleMd 而非空串
documentStore.init(sampleMd)

const showOutline = ref(false)
const showSettings = ref(false)

// 将 dark class 同步到 <html>，使 Tailwind dark: 变体全局生效；
// 同时把暗色状态推到原生窗口，让 title bar 跟着变
watch(
  () => store.darkMode,
  (val) => {
    document.documentElement.classList.toggle('dark', val)
    void invoke('set_window_theme', { theme: val ? 'dark' : 'light' }).catch(() => {})
    // 通知带自管渲染的 NodeView（mermaid）刷新主题 —— ProseMirror 不会因
    // 这次类名切换产生 transaction，nodeView.update() 不会触发，得我们主动喊
    window.dispatchEvent(new CustomEvent('velo:theme-change'))
  },
  { immediate: true },
)

// 简单 debounce：用于自动保存
function debounce<T extends (...args: never[]) => void>(fn: T, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

const autoSave = debounce(() => {
  if (!documentStore.dirty || !documentStore.currentFilePath) return
  void documentStore.save()
}, 1000)

// 启用自动保存时：内容变化后 1s 静默写盘
watch(
  [() => documentStore.autoSaveEnabled, () => documentStore.content],
  ([enabled]) => {
    if (enabled) autoSave()
  },
)

// ========== 用户设置持久化 ==========
// 启动时从 appDataDir 读 json 覆盖 store,任何设置字段变化 → 500ms debounce 后写回。
// 失败一律不抛:首次启动 / 文件被删 / 解析错 都回到默认值继续运行。
async function initSettings() {
  const loaded = await loadSettings()
  if (!loaded) return
  const e = loaded.editor
  if (e) {
    if (typeof e.fontSize === 'string') store.fontSize = e.fontSize
    if (typeof e.primaryColor === 'string') store.primaryColor = e.primaryColor
    if (typeof e.fontFamily === 'string') store.fontFamily = e.fontFamily
    if (typeof e.codeBlockTheme === 'string') store.codeBlockTheme = e.codeBlockTheme
    if (typeof e.isMacCodeBlock === 'boolean') store.isMacCodeBlock = e.isMacCodeBlock
    if (typeof e.darkMode === 'boolean') store.darkMode = e.darkMode
  }
  const d = loaded.document
  if (d) {
    if (typeof d.autoSaveEnabled === 'boolean') documentStore.autoSaveEnabled = d.autoSaveEnabled
    if (typeof d.autoSaveOnBlur === 'boolean') documentStore.autoSaveOnBlur = d.autoSaveOnBlur
  }
}

function snapshotSettings(): PersistedSettings {
  return {
    version: 1,
    editor: {
      fontSize: store.fontSize,
      primaryColor: store.primaryColor,
      fontFamily: store.fontFamily,
      codeBlockTheme: store.codeBlockTheme,
      isMacCodeBlock: store.isMacCodeBlock,
      darkMode: store.darkMode,
    },
    document: {
      autoSaveEnabled: documentStore.autoSaveEnabled,
      autoSaveOnBlur: documentStore.autoSaveOnBlur,
    },
  }
}

const debouncedSettingsSave = debounce(() => {
  void saveSettings(snapshotSettings())
}, 500)

// ========== 大纲折叠状态持久化 ==========
// 启动时把磁盘上 path → keys 映射灌进 outlineStore,后续 setKeysFor → 500ms debounce 落盘。
// 必须在 CLI args 之前 load,这样 CLI 打开文件时,EditorOutline 的 filePath watch
// 能从已就绪的 store 读到该文件的折叠状态 —— 否则首屏打开 = 全展开。
const debouncedOutlineSave = debounce(() => {
  void saveOutlineState({
    version: 1,
    files: outlineStore.snapshot(),
  })
}, 500)

// 失焦保存：window blur 时静默写盘
// 注意：弹原生 save/open dialog 也会触发 webview blur —— 用 savingOnBlur
// 做重入保护，防止 saveAs dialog 弹出后又被 blur 触发出第二个 dialog
let savingOnBlur = false
async function onWindowBlur() {
  if (!documentStore.autoSaveOnBlur || !documentStore.dirty) return
  if (savingOnBlur) return
  savingOnBlur = true
  try { await documentStore.save() }
  finally { savingOnBlur = false }
}

// 重新获得焦点：可能是 git pull / 外部编辑器刚保存了文件 —— 主动核对一次。
// fs:watch 在网络盘 / 原子 rename / 某些同步工具下会漏报，focus 兜底。
function onWindowFocus() {
  void documentStore.checkExternalChange()
}

// ========== 查找替换 (v0.3.1) ==========
// 状态全在 App.vue 一份,v-model:find-open 透传到 MilkdownEditor 再到 FindReplace。
// 顶栏按钮的 active 样式、Ctrl+F 打开、X / Esc 关闭、按钮再点关闭 —— 全部
// 直接改 findOpen 这一份,不存在 mirror。
const milkdownRef = ref<InstanceType<typeof MilkdownEditor> | null>(null)
const findOpen = ref(false)
// 一次性的初始参数:openFind / openReplace 时由 App.vue 写入,
// FindReplace 内部 watch open → 读这两个初始化。后续用户改 query 不影响这里。
const findInitialQuery = ref('')
const findInitialShowReplace = ref(false)

function currentSelectionText(): string {
  const view = milkdownRef.value?.getEditorView()
  if (!view) return ''
  const { from, to } = view.state.selection
  if (from === to) return ''
  // '\n' 隔开:多行选区能正常拿来搜
  return view.state.doc.textBetween(from, to, '\n', '\n')
}

function openFind() {
  findInitialQuery.value = currentSelectionText()
  findInitialShowReplace.value = false
  findOpen.value = true
}

function openReplace() {
  findInitialQuery.value = currentSelectionText()
  findInitialShowReplace.value = true
  findOpen.value = true
}

function toggleFind() {
  if (findOpen.value) findOpen.value = false
  else openFind()
}

// 全局 Ctrl/Cmd+S / Ctrl/Cmd+F / Ctrl/Cmd+H
//
// 必须 capture 阶段 + preventDefault 才能压过浏览器自己的 Ctrl+F (find in page)。
// 浏览器在 keydown 冒泡结束后才决定是否开内置 find,我们在 capture 阶段就
// preventDefault,事件到达目标元素前 default action 已被标记为取消。
// stopPropagation 防止冒泡到其他 window/document 上的扩展 / 第三方脚本再开一次。
function onKeydown(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey)) return
  const target = e.target as HTMLElement | null
  // 焦点在 FindReplace 面板里 → 让面板自己处理(避免双触发)
  if (target?.closest('[data-fr-panel]')) return
  const k = e.key.toLowerCase()
  if (k === 's') {
    e.preventDefault()
    e.stopPropagation()
    void documentStore.save()
  }
  else if (k === 'f') {
    e.preventDefault()
    e.stopPropagation()
    openFind()
  }
  else if (k === 'h') {
    e.preventDefault()
    e.stopPropagation()
    openReplace()
  }
}

let unlistenCli: UnlistenFn | null = null

// ========== 草稿定时落盘 ==========
// dirty 时每 DRAFT_SAVE_INTERVAL_MS 写一份到 appDataDir/drafts/,崩溃 / 强杀时
// 下次启动能恢复。store 自己已经在 save() / saveAs() 成功后清掉了,这里只管"周期"。
const DRAFT_SAVE_INTERVAL_MS = 30_000
let draftTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  // 0-pre) 关键:keydown 监听必须在第一个 await 之前挂上。
  //   启动期 await 一堆(读盘、invoke、openPath),用户在 await 期间按 Ctrl+F
  //   浏览器自己的 find 会先开 —— handler 还没挂就拦不住了。capture 阶段
  //   + preventDefault 是另一道保险,见 onKeydown 注释。
  window.addEventListener('keydown', onKeydown, { capture: true })

  // 0) 加载持久化的设置 / 大纲状态 —— 必须在 CLI args 之前完成,
  //    否则 CLI 打开文件时,EditorOutline 的 filePath watch 读到的 store 是空的,
  //    首屏就会"丢失"该文件的折叠状态。loadFrom / initSettings 失败一律不抛,
  //    不会阻塞后续步骤。
  await initSettings()
  const outlineLoaded = await loadOutlineState()
  if (outlineLoaded?.files) outlineStore.loadFrom(outlineLoaded.files)

  // 0.25) 启动草稿定时器:dirty 状态下每 30s 落一份;clean 时 store 内部直接 return。
  //      失败仅日志,不抛 —— 草稿写盘不能阻塞主流程。
  //      注意:draft 落盘 / 恢复扫描必须放 CLI 打开文件之后(见下面 1.5)。
  draftTimer = setInterval(() => {
    void documentStore.saveCurrentDraft()
  }, DRAFT_SAVE_INTERVAL_MS)

  // 0.5) 设置变化 → 落盘的 watch。必须在 load 之后挂,否则 load 自身会触发写盘。
  watch(
    [
      () => store.fontSize,
      () => store.primaryColor,
      () => store.fontFamily,
      () => store.codeBlockTheme,
      () => store.isMacCodeBlock,
      () => store.darkMode,
      () => documentStore.autoSaveEnabled,
      () => documentStore.autoSaveOnBlur,
    ],
    () => { debouncedSettingsSave() },
  )
  watch(
    () => outlineStore.collapsedByPath,
    () => { debouncedOutlineSave() },
    { deep: true },
  )

  // 1) 冷启动:Rust setup() 阶段把 argv 中的文件路径暂存了下来(没法直接 emit
  //    因为彼时前端的 listen() 还没挂上)。前端挂载完成后主动来拉一次。
  let cliFirst: string | undefined
  try {
    const initial = await invoke<string[]>('get_cli_args')
    cliFirst = initial?.[0]
    if (cliFirst) await documentStore.openPath(cliFirst)
  }
  catch (e) {
    console.error('读取启动 CLI 参数失败', e)
  }

  // 1.5) 扫一遍 appDataDir/drafts/,把"上一会话留下的"草稿装进 store。
  //
  //      必须在 CLI 打开文件 *之后*:loadRecoverableDrafts 用 currentDraftId()
  //      派生 id 排除"当前文档的草稿",而 currentDraftId 又以 currentFilePath
  //      为输入。如果在 openPath 之前调,currentFilePath 还是 null,filter
  //      只能排除 'untitled',CLI 即将打开的那个文件的草稿就会留在列表里,
  //      用户点"恢复"会把刚 load 进来的磁盘内容直接覆盖回那份草稿。
  //      现在 currentFilePath 要么是 null(无 CLI)要么是 cliFirst(有 CLI),
  //      filter 都能正确排除当前文档。
  await documentStore.loadRecoverableDrafts()

  // 2) 二次启动:现有实例已就绪,Rust 直接 emit,这里 listen 接住
  unlistenCli = await listen<string[]>('cli-args', async (e) => {
    const first = e.payload?.[0]
    if (!first) return
    if (!(await documentStore.confirmDiscardIfDirty())) return
    void documentStore.openPath(first)
  })

  // 3) keydown 监听已在最前面(0-pre)挂上 —— 启动期 await 期间也要能拦 Ctrl+F

  // 4) 失焦自动保存 + 重新聚焦时核对磁盘
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('focus', onWindowFocus)

  // 5) 关闭拦截:脏 → 弹原生确认
  const win = getCurrentWindow()
  await win.onCloseRequested(async (event) => {
    if (!documentStore.dirty) return
    event.preventDefault()
    const wantSave = await confirm(
      `「${documentStore.fileName}」有未保存的修改，是否保存？`,
      { title: '未保存的修改', kind: 'warning' },
    )
    if (wantSave) {
      // 关键:save 可能因为用户取消另存为对话框 / 写盘失败而返回 false。
      // 此时 *不能* destroy,否则用户的修改就丢了。
      const ok = await documentStore.save()
      if (ok) await win.destroy()
      return
    }
    const discard = await confirm('放弃修改并直接关闭？', {
      title: '确认关闭',
      kind: 'warning',
    })
    if (discard) await win.destroy()
  })
})

onBeforeUnmount(() => {
  unlistenCli?.()
  if (draftTimer) {
    clearInterval(draftTimer)
    draftTimer = null
  }
  window.removeEventListener('keydown', onKeydown, { capture: true })
  window.removeEventListener('blur', onWindowBlur)
  window.removeEventListener('focus', onWindowFocus)
})
</script>

<template>
  <div
    :class="{ 'dark': store.darkMode }"
    :style="{ '--md-primary-color': store.primaryColor }"
    class="flex h-screen flex-col bg-[#f5f5f5] text-gray-900 transition-colors dark:bg-[#1a1a1a] dark:text-gray-100"
  >
    <!-- 顶栏 -->
    <header class="flex items-center justify-between gap-3 px-6 py-3">
      <div class="flex min-w-0 items-center gap-2">
        <button
          class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          :class="{ 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300': showOutline }"
          title="大纲"
          @click="showOutline = !showOutline"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
        </button>
        <h1 class="flex shrink-0 items-center text-lg font-bold tracking-tight">
          <img :src="veloLogo" alt="Velo" class="h-6 w-6">
          <span :style="{ color: store.primaryColor }">elo Editor</span>
        </h1>
        <span class="ml-2 truncate text-sm text-gray-400" :title="documentStore.currentFilePath ?? ''">
          {{ documentStore.fileName }}{{ documentStore.dirty ? ' •' : '' }}
        </span>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <!-- 新建 -->
        <button
          class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          title="新建 (Ctrl+N)"
          @click="documentStore.newDoc()"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="12" y1="10" x2="12" y2="16" /></svg>
        </button>
        <!-- 打开 -->
        <button
          class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          title="打开 (Ctrl+O)"
          @click="documentStore.open()"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
        </button>
        <!-- 保存 -->
        <button
          class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          title="保存 (Ctrl+S)"
          @click="documentStore.save()"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>
        </button>
        <!-- 另存为 -->
        <button
          class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          title="另存为 (Ctrl+Shift+S)"
          @click="documentStore.saveAs()"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
        </button>
        <span class="mx-1 h-5 w-px bg-gray-200 dark:bg-gray-700" />
        <!-- 搜索(Ctrl+F) — toggle:点一次开,再点一次关。active 样式跟设置按钮一样 -->
        <button
          class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          :class="{ 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300': findOpen }"
          title="搜索 (Ctrl+F)"
          @click="toggleFind"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
        <button
          class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          :class="{ 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300': showSettings }"
          title="设置"
          @click="showSettings = !showSettings"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
        </button>
      </div>
    </header>

    <!-- 主体 -->
    <div class="flex flex-1 overflow-hidden">
      <!-- 大纲面板 -->
      <aside
        class="outline-panel shrink-0 overflow-hidden border-gray-200 bg-[#f5f5f5] dark:border-gray-800 dark:bg-[#1a1a1a]"
        :class="showOutline ? 'w-64' : 'w-0'"
      >
        <EditorOutline
          :model-value="documentStore.content"
          :file-path="documentStore.currentFilePath"
        />
      </aside>

      <!-- 编辑器区域 -->
      <MilkdownEditor
        ref="milkdownRef"
        v-model:find-open="findOpen"
        :find-initial-query="findInitialQuery"
        :find-initial-show-replace="findInitialShowReplace"
        :model-value="documentStore.content"
        :font-family="store.fontFamily"
        :font-size="store.fontSize"
        :primary-color="store.primaryColor"
        :is-mac-code-block="store.isMacCodeBlock"
        :dark-mode="store.darkMode"
        @update:model-value="documentStore.setContent"
      />

      <!-- 设置面板 -->
      <aside
        class="settings-panel shrink-0 overflow-hidden border-gray-200 bg-[#f5f5f5] dark:border-gray-800 dark:bg-[#1a1a1a]"
        :class="showSettings ? 'w-64' : 'w-0'"
      >
        <EditorSettings />
      </aside>
    </div>

    <!-- 崩溃恢复弹窗:启动时如果 appDataDir/drafts/ 里有上一会话留下的草稿就弹出 -->
    <DraftRecoveryDialog
      :drafts="documentStore.pendingRecoveryDrafts"
      :visible="documentStore.pendingRecoveryDrafts.length > 0"
      @recover="(id) => void documentStore.recoverDraft(id)"
      @discard="(id) => void documentStore.discardDraft(id)"
      @dismiss="documentStore.dismissRecoveryDialog()"
    />
  </div>
</template>
