<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount, provide } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { useDocumentStore } from '@/stores/document'
import { useOutlineStore } from '@/stores/outline'
import { useExportStore } from '@/stores/export'
import { loadSettings, saveSettings, loadOutlineState, saveOutlineState, type PersistedSettings } from '@/stores/persistence'
import ProseMirrorEditor from '@/components/ProseMirrorEditor/index.vue'
import SourceModeEditor from '@/components/SourceModeEditor.vue'
import { captureAnchor, applyAnchor } from '@/components/crossModeSync'
import { createPmBackend, createCmBackend } from '@/components/ProseMirrorEditor/findreplace/backend'
import { findIntentKey } from '@/components/ProseMirrorEditor/findreplace/findIntent'
import EditorSettings from '@/components/EditorSettings.vue'
import EditorOutline from '@/components/EditorOutline.vue'
import ExportButton from '@/components/ExportButton.vue'
import DraftRecoveryDialog from '@/components/DraftRecoveryDialog.vue'
// import sampleMdRaw from '@/assets/sample-code.md?raw'
import sampleMdRaw from '@/assets/sample.md?raw'
import veloLogo from '@/assets/Velo.png'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { confirm } from '@tauri-apps/plugin-dialog'
import { invoke, isTauri } from '@tauri-apps/api/core'

const tauri = isTauri()

const store = useEditorStore()
const documentStore = useDocumentStore()
const outlineStore = useOutlineStore()
const exportStore = useExportStore()

const sampleMd = sampleMdRaw.replace(
  '/src/assets/Velo.png',
  new URL(veloLogo, window.location.href).href,
)
// 同步把初始 sample 装入 store —— 必须早于 ProseMirrorEditor 子组件 mount,
// 这样子组件第一次拿到的 props.modelValue 就是 sampleMd 而非空串
documentStore.init(sampleMd)

// store hydrate + shiki highlighter ready 必须在 ProseMirrorEditor 子组件
// mount **之前**完成,否则首屏代码块会闪两遍:
//
//  1) PM mount → code_block 节点进入 DOM → plugin `decorations(state)` 第一
//     次跑,此时 plugin state.highlighter 还是 null(因为 view 工厂里的
//     `await getHighlighter()` 还在异步路上)→ buildDecorations 走
//     `if (!lang || !hl) return`,**不写任何 token inline style**。
//     此时 pre/span 只继承 SCSS 默认 `color: var(--shiki-light)` = #24292e
//     (近黑) → 用户看到"先黑色"。
//  2) `await getHighlighter()` resolve → `dispatch setMeta({ highlighter: hl })`
//     → plugin state apply → `decorations(state)` 第二次跑,这次 hl 非空 →
//     写出正确 token inline style → 颜色变 → **闪烁**。
//
// 解法:在 `settingsReady` 之上再叠一层 `codeBlockReady`,**等 highlighter
// 装好再翻**。`PM v-if="codeBlockReady"` → PM mount 时 shiki 已就绪,plugin
// view 工厂 attach 后 `getHighlighter(light, dark)` 走 cached promise 同步
// resolve → `dispatch setMeta` 同步发生 → plugin state.highlighter 立刻
// ready → `decorations(state)` 第一次跑就有 token style → 零闪烁。
//
// 失败一律不抛(首次启动 / 文件被删 / 解析错 → settingsReady 立即 true,
// store 走 DEFAULT,继续往后等 getHighlighter resolve → codeBlockReady 翻
// true → PM mount,行为一致,不会卡白屏)。
const settingsReady = ref(false)
const codeBlockReady = ref(false)

void initSettings()
  .finally(() => { settingsReady.value = true })
  .then(async () => {
    // 等 settings hydrate 完再读 store 主题(此时是用户值,可能不是 DEFAULT)
    const { getHighlighter, ensureTheme, BASELINE_LANGS, DEFAULT_LIGHT_THEME, DEFAULT_DARK_THEME } = await import(
      '@/components/ProseMirrorEditor/nodes/CodeBlockLangs'
    )
    const { extractLangsFromDoc } = await import(
      '@/components/ProseMirrorEditor/editor/markdownIO'
    )
    const light = store.codeLightTheme || DEFAULT_LIGHT_THEME
    const dark = store.codeDarkTheme || DEFAULT_DARK_THEME
    // 预扫 doc 用到的 lang + 5 项 BASELINE 兜底(去重)→ createHighlighter
    // 只装这一小撮 grammar,首屏 ~5-8 个 lang × ~200KB ≈ 1-1.6MB,远小于
    // 旧版"30 个 lang 全装" ~6MB。doc 里没出现 / 用户后续切换的 lang
    // 由 plugin getTokensSync 走 ensureLanguage 异步追加。
    const usedLangs = extractLangsFromDoc(documentStore.content)
    const bootstrapLangs = [...new Set([...usedLangs, ...BASELINE_LANGS])]
    // 装用户主题 + 预扫 lang;singleton 若已被占,这里 getHighlighter 拿到旧
    // hl,ensureTheme 补装用户主题。两条路都确保 highlighter 装好用户主题 +
    // 预扫 lang。
    await getHighlighter(bootstrapLangs, light, dark)
    await ensureTheme(light)
    await ensureTheme(dark)
    codeBlockReady.value = true
  })
  .catch((err) => {
    // shiki 加载失败也别卡白屏,翻 ready 让 PM mount,plugin 内置 catch 会
    // 输出 warn,代码块走 SCSS 默认色(降级)
    console.warn('[App] shiki highlighter 预加载失败,降级到默认色:', err)
    codeBlockReady.value = true
  })

const showOutline = ref(false)
const showSettings = ref(false)

// 将 dark class 同步到 <html>，使 Tailwind dark: 变体全局生效；
// 同时把暗色状态推到原生窗口，让 title bar 跟着变
watch(
  () => store.darkMode,
  (val) => {
    document.documentElement.classList.toggle('dark', val)
    if (tauri) {
      void invoke('set_window_theme', { theme: val ? 'dark' : 'light' }).catch(() => {})
    }
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
    if (typeof e.isMacCodeBlock === 'boolean') store.isMacCodeBlock = e.isMacCodeBlock
    if (typeof e.darkMode === 'boolean') store.darkMode = e.darkMode
    if (typeof e.codeLightTheme === 'string') store.codeLightTheme = e.codeLightTheme
    if (typeof e.codeDarkTheme === 'string') store.codeDarkTheme = e.codeDarkTheme
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
      isMacCodeBlock: store.isMacCodeBlock,
      darkMode: store.darkMode,
      codeLightTheme: store.codeLightTheme,
      codeDarkTheme: store.codeDarkTheme,
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
// 状态全在 App.vue 一份,v-model:find-open 透传到 ProseMirrorEditor 再到 FindReplace。
// 顶栏按钮的 active 样式、Ctrl+F 打开、X / Esc 关闭、按钮再点关闭 —— 全部
// 直接改 findOpen 这一份,不存在 mirror。
const editorRef = ref<InstanceType<typeof ProseMirrorEditor> | null>(null)
// 源代码模式编辑器 ref —— 跨模式光标/滚动同步要读 CM6 view(见 watch(sourceMode))
const srcRef = ref<InstanceType<typeof SourceModeEditor> | null>(null)
const findOpen = ref(false)
// 查找替换的"用户意图" —— 上提到 App.vue 并 provide,两份 FindReplace(PM / CM6)
// inject 共享。切模式时 PM 份卸载、CM6 份新挂,意图在这里存活 → query 不丢。
// matches / currentIndex 不上提(模式相关,新挂载时重算)。
const findQuery = ref('')
const findReplacement = ref('')
const findCaseSensitive = ref(false)
const findWholeWord = ref(false)
const findRegex = ref(false)
const findShowReplace = ref(false)
provide(findIntentKey, {
  query: findQuery,
  replacement: findReplacement,
  caseSensitive: findCaseSensitive,
  wholeWord: findWholeWord,
  regex: findRegex,
  showReplace: findShowReplace,
})

function currentSelectionText(): string {
  // 源代码模式从 CM6 取选区文本,WYSIWYG 从 PM 取 —— 都经后端 getSelectionText,
  // 与 FindReplace 用同一套抽象。空选区返回 ''。
  const be = activeBackend()
  return be ? be.getSelectionText() : ''
}

/** 当前活跃编辑器的查找替换后端(sourceMode → CM6,否则 PM)。null 表示未就绪。 */
function activeBackend() {
  if (documentStore.sourceMode) {
    const v = srcRef.value?.view
    return v ? createCmBackend(v) : null
  }
  const v = editorRef.value?.getEditorView()
  return v ? createPmBackend(v) : null
}

// ========== 跨模式光标 + 浏览状态同步 ==========
// toggleSourceMode() 翻转 sourceMode → v-if 互换两个编辑器,两边卸载重挂,
// 光标/滚动在 DOM 层丢失。这里在翻转**前**(flush:'pre',出方向组件尚未卸载)
// 从出方向 view 抓文本锚点,翻转后(nextTick,入方向 onMounted 已建 view)应用。
// 最佳努力:定位失败静默放弃。三个切换入口(Ctrl+` / 工具栏 / Esc)都走
// sourceMode 翻转,此 watch 单点覆盖,无需改调用点。
watch(
  () => documentStore.sourceMode,
  async (now, prev) => {
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

// 打开查找:从当前活跃编辑器选区取初始 query。
// - 面板当前关着 → 完整重置意图(query=选区、选项清零、替换文清空),再 open。
// - 面板已开(焦点在编辑器时又按 Ctrl+F)→ 只重填 query,保留用户辛苦切的选项
//   (与旧 watch(initialQuery) 语义一致)。findOpen 已 true 不变,FindReplace 的
//   query watcher 会自动重算。
function openFind() {
  const sel = currentSelectionText()
  if (!findOpen.value) {
    findQuery.value = sel
    findReplacement.value = ''
    findCaseSensitive.value = false
    findWholeWord.value = false
    findRegex.value = false
    findShowReplace.value = false
    findOpen.value = true
  }
  else {
    findQuery.value = sel
  }
}

function openReplace() {
  const sel = currentSelectionText()
  if (!findOpen.value) {
    findQuery.value = sel
    findReplacement.value = ''
    findCaseSensitive.value = false
    findWholeWord.value = false
    findRegex.value = false
    findShowReplace.value = true
    findOpen.value = true
  }
  else {
    findQuery.value = sel
  }
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

  // 0) 加载大纲折叠状态 —— 必须早于 CLI 打开文件,
  //    否则 CLI 打开文件时,EditorOutline 的 filePath watch 读到的 store 是空的,
  //    首屏就会"丢失"该文件的折叠状态。loadFrom 失败一律不抛,
  //    不会阻塞后续步骤。
  //
  // 注意:initSettings() 已提前到 setup() 顶层 await(见上方),目的是让
  // store.codeLightTheme / codeDarkTheme 在 ProseMirrorEditor 子组件 mount
  // **之前**就被用户设置覆盖,CodeHighlightWidget plugin view 工厂 attach
  // 时拿到正确主题调 getHighlighter(light, dark),shiki 一次性装对 → 首屏
  // 零闪烁。dev web 端 loadSettings() 因 isTauri() 守门返回 null,顶层
  // await 立即 resolve,无副作用。
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
      () => store.isMacCodeBlock,
      () => store.darkMode,
      () => store.codeLightTheme,
      () => store.codeDarkTheme,
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
  //    dev web 端(无 Tauri runtime)→ tauri=false,直接跳过整段,跟 persistence
  //    load/save 的 isTauri 守门一致。`invoke` 在 web 端调会 throw
  //    `Cannot read properties of undefined (reading 'invoke')` 因为
  //    window.__TAURI_INTERNALS__ 没注入。
  if (tauri) {
    let cliFirst: string | undefined
    try {
      const initial = await invoke<string[]>('get_cli_args')
      cliFirst = initial?.[0]
      if (cliFirst) await documentStore.openPath(cliFirst)
    }
    catch (e) {
      console.error('读取启动 CLI 参数失败', e)
    }
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

  // 2) 二次启动:现有实例已就绪,Rust 直接 emit,这里 listen 接住。
  //    dev web 端 listen 也会 throw(__TAURI_INTERNALS__ undefined),加 tauri
  //    守门。这行如果 throw 会让 onMounted async 函数 reject,后续 4.5 段
  //    "切代码主题" watch 就挂不上 —— dev web 端切主题失败的根因。
  if (tauri) {
    unlistenCli = await listen<string[]>('cli-args', async (e) => {
      const first = e.payload?.[0]
      if (!first) return
      if (!(await documentStore.confirmDiscardIfDirty())) return
      void documentStore.openPath(first)
    })
  }

  // 3) keydown 监听已在最前面(0-pre)挂上 —— 启动期 await 期间也要能拦 Ctrl+F

  // 4) 失焦自动保存 + 重新聚焦时核对磁盘
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('focus', onWindowFocus)

  // 4.5) 代码块主题切换:用户改 store.codeLightTheme / codeDarkTheme →
  //  ensureTheme 异步追加 → dispatch setMeta({ highlighter, lightTheme, darkTheme })
  // → plugin state apply → buildDecorations 重新跑 → token inline style 用新主题色重写。
  // 跟 darkMode toggle 的纯 CSS 路径正交,这条要主动 rebuild(新主题 hex 变了)。
  //
  // **首屏零闪烁**:`getHighlighter` 是 singleton,第一次调用决定装哪两个
  // 主题,后续只能 loadTheme 追加(会再触发一次 rebuild → 视觉闪)。所以
  // 启动期 settings 加载提前到 App.vue setup 顶层 await(见 setup 顶部),
  // ProseMirrorEditor 子组件 mount 时 store.codeLightTheme / codeDarkTheme
  // 已经是用户值;plugin view 工厂 attach 后从 store 读 → getHighlighter(
  // light, dark) 一次性装对。**这里 watch 不开 immediate** —— 首次由 view
  // 工厂的 getHighlighter 触发,本 watch 只管"用户后续改"。
  const { ensureTheme: ensureShikiTheme } = await import(
    '@/components/ProseMirrorEditor/nodes/CodeBlockLangs'
  )
  const { codeHighlightKey } = await import(
    '@/components/ProseMirrorEditor/nodes/CodeHighlightWidget'
  )
  watch(
    () => [store.codeLightTheme, store.codeDarkTheme] as const,
    async ([light, dark]) => {
      const view = editorRef.value?.getEditorView()
      if (!view || view.isDestroyed) return
      const hl = await ensureShikiTheme(light)
      await ensureShikiTheme(dark)
      if (view.isDestroyed) return
      view.dispatch(view.state.tr.setMeta(codeHighlightKey, {
        highlighter: hl,
        lightTheme: light,
        darkTheme: dark,
      }))
    },
  )

  // 5) 关闭拦截:脏 → 弹原生确认。dev web 端没有 Tauri runtime,getCurrentWindow
  //    / onCloseRequested / confirm 这些 Tauri 同步 API 一调就 throw,所以整段
  //    用 tauri 守门跳过;浏览器自带 beforeunload 弹原生确认(用户没要求,本项目
  //    不做)。保存可能因为用户取消另存为对话框 / 写盘失败而返回 false —— 此时
  //    *不能* destroy,否则用户的修改就丢了。
  if (tauri) {
    const win = getCurrentWindow()
    await win.onCloseRequested(async (event) => {
      if (!documentStore.dirty) return
      event.preventDefault()
      const wantSave = await confirm(
        `「${documentStore.fileName}」有未保存的修改，是否保存？`,
        { title: '未保存的修改', kind: 'warning' },
      )
      if (wantSave) {
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
  }
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
        <!-- 导出 (Ctrl+Shift+E) -->
        <ExportButton />
        <span class="mx-1 h-5 w-px bg-gray-200 dark:bg-gray-700" />
        <!-- 搜索(Ctrl+F) — toggle:点一次开,再点一次关。active 样式跟设置按钮一样 -->
        <button
          class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          :class="{
            'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300': findOpen,
          }"
          title="搜索 (Ctrl+F)"
          @click="toggleFind"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
        <!-- 源代码模式 (Ctrl+\`) -->
        <button
          class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          :class="{ 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300': documentStore.sourceMode }"
          title="源代码模式 (Ctrl+\`)"
          @click="documentStore.toggleSourceMode()"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
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
      <!--
        v-if="codeBlockReady" 守门:**shiki highlighter 装好用户主题**后才
        mount ProseMirrorEditor。PM mount 时 plugin state.highlighter 立即
        ready → `decorations(state)` 第一次跑就写正确 token inline style
        → 首屏零闪烁。单纯守 settingsReady(只等 store hydrate)不够 —— PM
        mount 早于 `await getHighlighter()` resolve,plugin 第一次跑
        decorations 时 hl 仍是 null,代码块先按 SCSS 默认色渲染,等
        setMeta 触发后才有 token 色 → 用户看到"先默认后用户"闪烁。
      -->
      <template v-if="codeBlockReady">
        <ProseMirrorEditor
          v-if="!documentStore.sourceMode"
          ref="editorRef"
          v-model:find-open="findOpen"
          :model-value="documentStore.content"
          :font-family="store.fontFamily"
          :font-size="store.fontSize"
          :primary-color="store.primaryColor"
          :is-mac-code-block="store.isMacCodeBlock"
          :dark-mode="store.darkMode"
          @update:model-value="documentStore.setContent"
        />
        <SourceModeEditor
          v-else
          ref="srcRef"
          v-model:find-open="findOpen"
          :model-value="documentStore.content"
          :dark-mode="store.darkMode"
          @update:model-value="documentStore.setContent"
        />
      </template>

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
