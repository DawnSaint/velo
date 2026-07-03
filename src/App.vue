<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount, provide, computed } from 'vue'
import { MessageSquare } from '@lucide/vue'
import { useEditorStore } from '@/stores/editor'
import { useDocumentStore } from '@/stores/document'
import { useOutlineStore } from '@/stores/outline'
import { useExportStore } from '@/stores/export'
import { useWorkspaceStore, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX } from '@/stores/workspace'
import { useRecentFilesStore } from '@/stores/recentFiles'
import { loadSettings, saveSettings, loadOutlineState, saveOutlineState, loadWorkspaces, saveWorkspacePatch, readSampleContent, isFirstRun, type PersistedSettings } from '@/stores/persistence'
import ProseMirrorEditor from '@/components/ProseMirrorEditor/index.vue'
import SourceModeEditor from '@/components/SourceModeEditor.vue'
import { captureAnchor, applyAnchor } from '@/components/crossModeSync'
import { createPmBackend, createCmBackend } from '@/components/ProseMirrorEditor/findreplace/backend'
import { findIntentKey } from '@/components/ProseMirrorEditor/findreplace/findIntent'
import EditorSettings from '@/components/EditorSettings.vue'
import Sidebar from '@/components/Sidebar/Sidebar.vue'
import FileActionsPanel from '@/components/FileActionsPanel.vue'
import DraftRecoveryDialog from '@/components/DraftRecoveryDialog.vue'
import WelcomeDialog from '@/components/WelcomeDialog.vue'
import QuickOpenPanel from '@/components/QuickOpenPanel.vue'
import CommandPalettePanel from '@/components/CommandPalettePanel.vue'
import WorkspaceSearchPanel from '@/components/WorkspaceSearchPanel.vue'
import RecentFilesButton from '@/components/RecentFilesButton.vue'
import ActivityBar, { type ActivityBarItem } from '@/components/ActivityBar.vue'
import WindowControls from '@/components/WindowControls.vue'
import StatusBar from '@/components/StatusBar.vue'
import { clearAll as clearQuickOpenIndex, invalidate as invalidateQuickOpenIndex } from '@/utils/quickOpenIndex'
import type { CommandPaletteItem } from '@/utils/commandPalette'
import { basenameOfPath, normalizeDisplayPath } from '@/utils/statusPath'
import {
  revealWorkspaceSearchMatch,
  type WorkspaceSearchHit,
} from '@/utils/workspaceSearch'
import { DEFAULT_CURSOR_POSITION, type CursorPosition } from '@/utils/editorCursor'
import { useResizeSplitter } from '@/composables/useResizeSplitter'
import { SAMPLE, findSample } from '@/utils/samples'
import { mark, measure, report } from '@/utils/perf'
import veloLogo from '@/assets/Velo.png'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { confirm } from '@/tauri/dialog'
import { isTauri, invoke } from '@tauri-apps/api/core'
import {
  getCurrentWindowLabel,
  newAppWindow,
  takeWindowCliArgs,
  type CliArgsPayload,
} from '@/tauri/window'

const tauri = isTauri()
const isDev = import.meta.env.DEV
const MAIN_WINDOW_LABEL = 'main'

const store = useEditorStore()
const documentStore = useDocumentStore()
const outlineStore = useOutlineStore()
const exportStore = useExportStore()
const workspaceStore = useWorkspaceStore()
const recentFilesStore = useRecentFilesStore()

// 启动时装入空白内容；真实内容由工作区恢复 / 欢迎对话框 / CLI 参数加载。
documentStore.init('')

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
const welcomeVisible = ref(false)
// sample 走 Vite 动态 ?raw —— 编译进 JS chunk,任何环境(dev web / dev Tauri /
// release)都可用,不存在"读不到"的可能。保留 ref 是为了未来按构建类型关闭
// (例如 SSR / 移动端),当前永远 true。
const samplesAvailable = ref(true)

void initSettings()
  .finally(() => { settingsReady.value = true; mark('settings-ready') })
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
    mark('code-block-ready')
  })
  .catch((err) => {
    // shiki 加载失败也别卡白屏,翻 ready 让 PM mount,plugin 内置 catch 会
    // 输出 warn,代码块走 SCSS 默认色(降级)
    console.warn('[App] shiki highlighter 预加载失败,降级到默认色:', err)
    codeBlockReady.value = true
    mark('code-block-ready')
  })

type LeftPanelView = 'fileActions' | 'sidebar' | 'settings' | null
const leftPanelView = ref<LeftPanelView>(null)
const sidebarRef = ref<InstanceType<typeof Sidebar> | null>(null)

// ========== 侧栏可拖拽 + 自动收起(v0.5.5)==========
// sidebarWidthRef 是 UI 层镜像,composable 在拖拽中写入此 ref(rAF 节流);
// commit 时再调 workspaceStore.setSidebarWidth 写回 store(per-workspace 持久化)。
//
// **双阈值 + 死区 snap(v0.5.5 后期调整)**:A = DRAG_COLLAPSE_BELOW(80),B = SIDEBAR_WIDTH_MIN(200)。
//   - [0, A)        : drag-collapse 区,侧栏隐藏;onCommit 不写 store(瞬时值)。
//   - [A, B] 死区   : 视觉宽度强制 = B(80-200 之间的瞬时值不在屏幕上出现,避免
//                     "线从中间位置开始动"的视觉错位 —— 用户报告的根因);
//                     onCommit 写 B 到 store。
//   - (B, MAX]      : 正常稳定区,视觉宽度 = raw,onCommit 写 raw。
// 用户拖回 [A, MAX] 时 onDragReopen 让侧栏按 snapshot 视图重新出现,继续拖拽。
//
// 两种自动收起:
//   - 拖拽宽度 < 80 → onDragCollapse 收起;拖回 >= 80 → onDragReopen 重开
//   - 窗口宽度 < AUTO_COLLAPSE_BELOW(608 = 48 + 200 + 360)→ onCollapse 收起
//   - 双击 splitter → onCollapse 收起
//
// 拖拽下界 min:0,composable 不耦合阈值;App.vue 的 onCommit 决定 raw 落不落盘。
// store + composable 双层防御保证合法稳定值在 [B, MAX] 内。
//
// displaySidebarWidth 拿的是"用户看到的宽度":
//   - 侧栏收起:0
//   - 侧栏可见:Math.max(sidebarWidthRef.value, SIDEBAR_WIDTH_MIN) —— 死区 snap 到 B,
//     解决"线从中间位置开始动"。
//
// drag-reopen snapshot(v0.5.5):onDragCollapse 触发时把"收起前用户正在看的视图"
// (sidebar / settings)记到 dragCollapseRestoreView,onDragReopen 时还原。
// 关键:只在拖拽过程中还原 —— 拖拽结束后清空,避免下次普通点击 ActivityBar 误把
// 侧栏强行重开(参见 isDragging watcher 末尾的复位)。
// 双阈值:A = DRAG_COLLAPSE_BELOW(80,左),B = SIDEBAR_WIDTH_MIN(200,右)。
// 窗口 resize 兜底阈值:ActivityBar 48 + 侧栏最小 200 + 编辑器最小 360 = 608。
const AUTO_COLLAPSE_BELOW = SIDEBAR_WIDTH_MIN + 48 + 360
const DRAG_COLLAPSE_BELOW = 80
// drag-reopen snapshot:onDragCollapse 触发时把"当前 view"存到这里,
// onDragReopen 时还原。null 表示"本次拖拽还没收过侧栏"。isDragging watcher
// 在拖拽开始/结束时清空,保证非拖拽场景下该变量无副作用。
const dragCollapseRestoreView = ref<LeftPanelView | null>(null)
const sidebarWidthRef = ref<number>(workspaceStore.sidebarWidth)
const sidebarSplitter = useResizeSplitter({
  width: sidebarWidthRef,
  min: 0,
  max: SIDEBAR_WIDTH_MAX,
  onCommit: (n) => {
    // 双阈值 + 死区 snap:
    //   n < A(80)         : collapse 区,onCommit 不写(store 保留上次稳定值)
    //   n in [A, B]       : 死区,写 B(200)到 store —— release 时停在 B
    //   n > B             : 稳定区,写 n 到 store
    // 这样 deadzone [80, 200) 在屏幕上根本看不见(侧栏宽度在视觉上
    // 死区 snap 到 B),也避开了用户报告的"线从中间位置开始动"问题。
    if (n < DRAG_COLLAPSE_BELOW) return
    workspaceStore.setSidebarWidth(Math.max(n, SIDEBAR_WIDTH_MIN))
  },
  collapseBelow: AUTO_COLLAPSE_BELOW,
  onCollapse: () => { leftPanelView.value = null },
  dragCollapseBelow: DRAG_COLLAPSE_BELOW,
  onDragCollapse: () => {
    // 收起前先 snapshot 当前 view(sidebar / settings),出区时用 onDragReopen 还原。
    // 这里在 leftPanelView 已经非空时 snapshot,因为 startDrag 的前提就是侧栏可见
    // (splitter 本身 v-if="leftPanelView" 才渲染),所以此处拿到的值一定是有效视图。
    dragCollapseRestoreView.value = leftPanelView.value
    leftPanelView.value = null
  },
  onDragReopen: () => {
    // 拖回阈值之上,恢复 drag-collapse 之前用户正在看的视图。
    // restore view 是 null 的话什么都不做(理论上 startDrag 已保证非 null,
    // 但加一层防御:用户可能已经手动用 ActivityBar 切了别的)。
    if (dragCollapseRestoreView.value) leftPanelView.value = dragCollapseRestoreView.value
  },
})
// 切换 workspace 时,store 的 sidebarWidth 变了 → 同步到 UI ref
watch(() => workspaceStore.sidebarWidth, (n) => {
  sidebarWidthRef.value = n
})
// 拖拽开始 → 同步 sidebarWidthRef 为 store 当前值(composable 用此值做 dragStartWidth)。
// 不放在 isDragging 的普通 watch 里是因为 store 值可能在拖拽间变化(虽然不常见),
// 每次拖拽开始时强制同步一次最安全。
//
// 拖拽开始 / 结束 → 清空 dragCollapseRestoreView。关键:即便 onDragCollapse 触发后
// 用户没把鼠标拖回阈值之上就 release,这个值也会被清掉,避免下次手动点 ActivityBar
// 切到新视图时,被一个陈旧的 snapshot 误导触发 onDragReopen 把不该开的东西开回来。
//
// **注意**:这一处不再做 sidebarWidthRef = store 的同步 —— 那个同步必须在
// startDrag 之前**同步**完成,但 watcher 是 async(flush: 'pre'),startDrag 读
// opts.width.value 在 watcher 跑之前。所以同步挪到 onSplitterMouseDown 包装层
// (见下方),在 startDrag 调用前同步完成。
watch(() => sidebarSplitter.isDragging.value, (dragging, was) => {
  if (dragging !== was) dragCollapseRestoreView.value = null
})

// mousedown 包装:在调 composable.startDrag 之前先把 sidebarWidthRef 同步到
// store 的稳定值(snapped,死区已 snap 到 B)。否则 startDrag 读 opts.width.value
// 拿到的是上一轮 drag 留下的 raw 值(可能落在死区 [A, B] 内),dragStartWidth 偏小,
// 用户必须额外移动 (B - lastRaw) 像素才能让 pendingNext 跨过 B —— 表现为"线不跟手,
// 鼠标和线有 ~80px 距离"。
//
// 同步写在包装层而不是 startDrag 内,是因为 composable 是通用的,不该耦合 App.vue
// 的 snap 语义;sync 放调用方最干净。store 自身已 clamp 到 [B, MAX],workspace 切换
// / 程序 setSidebarWidth 的更新由上面的 workspaceStore.sidebarWidth watcher 处理。
function onSplitterMouseDown(e: MouseEvent) {
  sidebarWidthRef.value = workspaceStore.sidebarWidth
  sidebarSplitter.startDrag(e)
}
// 真正给模板用的显示宽度:见顶部注释
//
// 死区 snap 是关键:在拖拽中或 reopen 后,siderbarWidthRef 可能落在 [A, B] 死区
// (例如用户拖到 150 但视觉应该停在 B=200)。displaySidebarWidth 把任何 < B 的值
// snap 到 B,这样视觉宽度与 splitter 位置始终 >= B,鼠标与线对齐。
//
// 注意:不用"是否拖拽中"分支(siderbarWidthRef vs store)——onCommit 已经把死区
// 内的 raw 写成了 B,store 总是 >= B;sidebarWidthRef 在死区内也只是临时值,
// display snap 一下就行,不需要切源。简化后只有一个表达式。
const displaySidebarWidth = computed(() => {
  if (!leftPanelView.value) return 0
  return Math.max(sidebarWidthRef.value, SIDEBAR_WIDTH_MIN)
})

// 将 dark class 同步到 <html>，使 Tailwind dark: 变体全局生效。
watch(
  () => store.darkMode,
  (val) => {
    document.documentElement.classList.toggle('dark', val)
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
    if (e.startupMode === 'last-file' || e.startupMode === 'new-doc') store.startupMode = e.startupMode
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
      startupMode: store.startupMode,
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

// ========== 工作区持久化(v0.5.0) ==========
// 启动时把磁盘上 active root + per-workspace 状态灌进 workspaceStore。
// 后续任意状态变化 → 500ms debounce 落盘。
const debouncedWorkspaceSave = debounce(() => {
  void saveWorkspacePatch(workspaceStore.snapshotActiveForPersistence())
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

// ========== 欢迎对话框 ==========
function onWelcomeBlank() {
  welcomeVisible.value = false
  documentStore.newDoc()
}
function onWelcomeOpenFile() {
  welcomeVisible.value = false
  documentStore.open()
}
function onWelcomeSample(key: string) {
  welcomeVisible.value = false
  void loadSample(key)
}

/**
 * 装载示例文档(只读)。sample 走 Vite 动态 ?raw import(拆 chunk,用才下载),字符串
 * 编译进 bundle —— 磁盘无文件实体,用户无法修改,reinstall 跟随应用走。失败静默
 * (null 不进 loadContent);sample.md 里的 Velo.png 占位由下方 replace 换成打包后的
 * veloLogo URL(?raw 字符串不被 Vite 资源重写)。
 */
async function loadSample(key: string) {
  const entry = findSample(key)
  if (!entry) return
  const content = await readSampleContent(key)
  if (content === null) return
  // sample.md 以 ?raw 字符串编译进 bundle,Vite 不重写其中的 Velo.png,
  // release 下该路径不在 dist → 404。替换成显式 import 过的 veloLogo(Vite 会打包+hash 改名)。
  const resolved = content.replace(
    'Velo.png',
    new URL(veloLogo, window.location.href).href,
  )
  documentStore.loadContent(resolved, null, true)
  // currentFilePath 为 null,设虚拟名让顶栏 / 状态栏 / 关闭拦截显示有意义的标题。
  documentStore.virtualFileName = `示例 — ${entry.label}`
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
const cursorPosition = ref<CursorPosition>(DEFAULT_CURSOR_POSITION)
function updateCursorPosition(position: CursorPosition) {
  cursorPosition.value = position
}
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

// ========== Ctrl+P 查找文件(v0.5.2)==========
// 工作区维度的快速打开面板,与 FindReplace 视觉档次对齐但独立浮层。
// 无工作区时 onKeydown 直接 return(对齐 ROADMAP 问答约定的"静默无反应"语义)。
const quickOpenOpen = ref(false)
const commandPaletteOpen = ref(false)
const workspaceSearchOpen = ref(false)
const workspaceSearchInitialQuery = ref('')

function openWorkspaceSearch() {
  const sel = currentSelectionText()
  workspaceSearchInitialQuery.value = sel
  quickOpenOpen.value = false
  commandPaletteOpen.value = false
  findOpen.value = false
  workspaceSearchOpen.value = true
}

function openQuickOpen() {
  if (!workspaceStore.activeRoot) return
  commandPaletteOpen.value = false
  workspaceSearchOpen.value = false
  findOpen.value = false
  quickOpenOpen.value = true
}

function openCommandPalette() {
  quickOpenOpen.value = false
  workspaceSearchOpen.value = false
  findOpen.value = false
  commandPaletteOpen.value = true
}

function selectAndRevealWorkspaceSearchMatch(be: ReturnType<typeof activeBackend>, from: number, to: number) {
  revealWorkspaceSearchMatch(be, from, to)
}

async function selectWorkspaceSearchHit(hit: WorkspaceSearchHit): Promise<boolean> {
  let be = activeBackend()
  if (!be) return false

  if (documentStore.sourceMode) {
    const matches = be.findMatches(hit.query, hit.options)
    const match = matches[hit.matchOrdinal]
    if (match) {
      selectAndRevealWorkspaceSearchMatch(be, match.from, match.to)
      return true
    }
    const rawText = be.getRangeText(hit.rawFrom, hit.rawTo)
    if (rawText === hit.matchText) {
      selectAndRevealWorkspaceSearchMatch(be, hit.rawFrom, hit.rawTo)
      return true
    }
    return false
  }

  const pmMatches = be.findMatches(hit.query, hit.options)
  const pmMatch = pmMatches[hit.matchOrdinal]
  if (pmMatches.length === hit.fileMatchCount && pmMatch) {
    selectAndRevealWorkspaceSearchMatch(be, pmMatch.from, pmMatch.to)
    return true
  }

  return false
}

async function openWorkspaceSearchResult(hit: WorkspaceSearchHit) {
  if (!(await documentStore.confirmDiscardIfDirty())) return
  const ok = await documentStore.openPath(hit.fullPath)
  if (!ok) return
  workspaceStore.setLastFile(hit.fullPath)
  await nextTick()
  const selected = await selectWorkspaceSearchHit(hit)
  if (!selected) console.warn('[WorkspaceSearch] 结果已过期,无法定位选区:', hit)
  workspaceSearchOpen.value = false
}

const activeActivity = computed<ActivityBarItem | null>(() => {
  if (workspaceSearchOpen.value) return 'search'
  if (leftPanelView.value === 'fileActions') return 'fileActions'
  if (leftPanelView.value === 'settings') return 'settings'
  if (leftPanelView.value === 'sidebar') return workspaceStore.sidebarTab
  return null
})

function showFileActionsPanel() {
  workspaceSearchOpen.value = false
  leftPanelView.value = 'fileActions'
}

function toggleFileActionsPanel() {
  workspaceSearchOpen.value = false
  leftPanelView.value = leftPanelView.value === 'fileActions' ? null : 'fileActions'
}

function showSidebarTab(tab: 'files' | 'outline') {
  workspaceSearchOpen.value = false
  workspaceStore.setSidebarTab(tab)
  leftPanelView.value = 'sidebar'
}

function toggleSidebarTab(tab: 'files' | 'outline') {
  workspaceSearchOpen.value = false
  if (leftPanelView.value === 'sidebar' && workspaceStore.sidebarTab === tab) {
    leftPanelView.value = null
    return
  }
  workspaceStore.setSidebarTab(tab)
  leftPanelView.value = 'sidebar'
}

function showSettingsPanel() {
  workspaceSearchOpen.value = false
  leftPanelView.value = 'settings'
}

function toggleSettingsPanel() {
  workspaceSearchOpen.value = false
  leftPanelView.value = leftPanelView.value === 'settings' ? null : 'settings'
}

function toggleWorkspaceSearchFromActivity() {
  if (workspaceSearchOpen.value) workspaceSearchOpen.value = false
  else openWorkspaceSearch()
}

/** 顶栏"打开文件夹"按钮:弹原生目录选择对话框,选中后切到该工作区。
 *  与 FileTree 内空态按钮共用一个 workspaceStore.pickWorkspace,UI 入口
 *  上提到顶栏后,FileTree 顶部"更换工作区"按钮移除(v0.5.1,避免与本按钮重复)。 */
async function createNewAppWindow(payload?: Partial<CliArgsPayload>) {
  if (!tauri) return
  try {
    await newAppWindow(payload)
  }
  catch (e) {
    console.error('创建新窗口失败', e)
  }
}

function openFolderAsWorkspace() {
  void workspaceStore.pickWorkspace()
}

async function openRecentFile(path: string) {
  if (!(await documentStore.confirmDiscardIfDirty())) return
  const ok = await documentStore.openPath(path)
  if (!ok) return
  workspaceStore.setLastFile(path)
}

async function openSample(key: string) {
  await loadSample(key)
}

const commandPaletteItems = computed<CommandPaletteItem[]>(() => {
  const needWorkspace = !workspaceStore.activeRoot
  const items: CommandPaletteItem[] = [
    {
      id: 'file.new',
      title: '新建文件',
      subtitle: '创建一份未保存的新 Markdown 文档',
      shortcut: 'Ctrl+N',
      group: 'app',
      keywords: ['new file', 'new document', 'markdown'],
      run: () => documentStore.newDoc(),
    },
    ...(tauri ? [{
      id: 'window.new',
      title: '新窗口',
      subtitle: '打开一个独立的 Velo 窗口',
      shortcut: 'Ctrl+Shift+N',
      group: 'app' as const,
      keywords: ['new window'],
      run: () => createNewAppWindow(),
    }] : []),
    {
      id: 'file.open',
      title: '打开文件',
      subtitle: '从磁盘选择一个 Markdown 文件',
      shortcut: 'Ctrl+O',
      group: 'app',
      keywords: ['open file'],
      run: () => documentStore.open(),
    },
    {
      id: 'file.save',
      title: '保存',
      subtitle: documentStore.currentFilePath ? normalizeDisplayPath(documentStore.currentFilePath) : '未命名文件会进入另存为',
      shortcut: 'Ctrl+S',
      group: 'app',
      keywords: ['save file'],
      run: () => documentStore.save(),
    },
    {
      id: 'file.saveAs',
      title: '另存为',
      subtitle: '选择新位置保存当前文档',
      shortcut: 'Ctrl+Shift+S',
      group: 'app',
      keywords: ['save as'],
      run: () => documentStore.saveAs(),
    },
    {
      id: 'file.export',
      title: exportStore.exporting ? '导出中…' : '导出',
      subtitle: '导出为 HTML 或 PDF',
      shortcut: 'Ctrl+Shift+E',
      group: 'app',
      keywords: ['export', 'html', 'pdf'],
      disabled: exportStore.exporting,
      disabledReason: '导出中…',
      run: () => exportStore.exportDocument(),
    },
    {
      id: 'edit.find',
      title: '查找',
      subtitle: '在当前文档中查找',
      shortcut: 'Ctrl+F',
      group: 'app',
      keywords: ['find', 'search current file'],
      run: () => openFind(),
    },
    {
      id: 'edit.replace',
      title: '替换',
      subtitle: '在当前文档中查找并替换',
      shortcut: 'Ctrl+H',
      group: 'app',
      keywords: ['replace'],
      run: () => openReplace(),
    },
    {
      id: 'editor.toggleSource',
      title: documentStore.sourceMode ? '切换到所见即所得' : '切换源码模式',
      subtitle: documentStore.sourceMode ? '返回 ProseMirror 所见即所得编辑器' : '使用源码模式编辑 Markdown',
      shortcut: 'Ctrl+`',
      group: 'app',
      keywords: ['source mode', 'wysiwyg', 'markdown source'],
      run: () => documentStore.toggleSourceMode(),
    },
    {
      id: 'view.fileActions',
      title: '显示文件操作',
      subtitle: '打开左侧的新建、打开、保存、导出入口',
      group: 'app',
      keywords: ['file actions', 'sidebar'],
      run: () => showFileActionsPanel(),
    },
    {
      id: 'settings.open',
      title: '打开设置',
      subtitle: '调整编辑器外观和行为',
      group: 'app',
      keywords: ['settings', 'preferences'],
      run: () => showSettingsPanel(),
    },
    {
      id: 'workspace.openFolder',
      title: '打开文件夹作为工作区',
      subtitle: '选择一个目录作为当前工作区',
      group: 'workspace',
      keywords: ['open folder', 'workspace'],
      run: () => openFolderAsWorkspace(),
    },
    {
      id: 'workspace.quickOpen',
      title: '快速打开文件',
      subtitle: '在当前工作区中按文件名查找 Markdown',
      shortcut: 'Ctrl+P',
      group: 'workspace',
      keywords: ['quick open', 'file search'],
      disabled: needWorkspace,
      disabledReason: '需要先打开工作区',
      run: () => openQuickOpen(),
    },
    {
      id: 'workspace.search',
      title: '搜索工作区',
      subtitle: '全文搜索当前工作区中的 Markdown',
      shortcut: 'Ctrl+Shift+F',
      group: 'workspace',
      keywords: ['workspace search', 'search all files'],
      disabled: needWorkspace,
      disabledReason: '需要先打开工作区',
      run: () => openWorkspaceSearch(),
    },
    {
      id: 'workspace.files',
      title: '显示工作区文件',
      subtitle: '打开左侧文件树',
      group: 'workspace',
      keywords: ['file tree', 'explorer', 'workspace files'],
      disabled: needWorkspace,
      disabledReason: '需要先打开工作区',
      run: () => showSidebarTab('files'),
    },
    {
      id: 'workspace.outline',
      title: '显示大纲',
      subtitle: '打开当前文档的大纲视图',
      group: 'workspace',
      keywords: ['outline', 'headings'],
      run: () => showSidebarTab('outline'),
    },
    {
      id: 'workspace.close',
      title: '关闭工作区',
      subtitle: workspaceStore.activeRoot ? normalizeDisplayPath(workspaceStore.activeRoot) : '当前没有打开的工作区',
      group: 'workspace',
      keywords: ['close workspace'],
      disabled: needWorkspace,
      disabledReason: '当前没有打开的工作区',
      run: () => workspaceStore.closeWorkspace(),
    },
  ]

  if (samplesAvailable.value) {
    items.push({
      id: `sample:${SAMPLE.key}`,
      title: SAMPLE.label,
      subtitle: `示例文档 — ${SAMPLE.description}`,
      group: 'app',
      icon: 'source',
      keywords: ['sample', SAMPLE.label, SAMPLE.description],
      run: () => openSample(SAMPLE.key),
    })
  }

  for (const entry of recentFilesStore.entries.slice(0, 12)) {
    const displayPath = normalizeDisplayPath(entry.path)
    items.push({
      id: `recent:${entry.path}`,
      title: `打开最近文件: ${basenameOfPath(entry.path)}`,
      subtitle: displayPath,
      group: 'recent',
      keywords: ['recent file', entry.path, displayPath],
      run: () => openRecentFile(entry.path),
    })
  }

  return items
})

// 全局 Ctrl/Cmd+S / Ctrl/Cmd+F / Ctrl/Cmd+H
//
// 必须 capture 阶段 + preventDefault 才能压过浏览器自己的 Ctrl+F (find in page)。
// 浏览器在 keydown 冒泡结束后才决定是否开内置 find,我们在 capture 阶段就
// preventDefault,事件到达目标元素前 default action 已被标记为取消。
// stopPropagation 防止冒泡到其他 window/document 上的扩展 / 第三方脚本再开一次。
function onKeydown(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey)) return
  const target = e.target as HTMLElement | null
  // 焦点在 FindReplace / 工作区搜索 / 命令面板里 → 让面板自己处理(避免双触发)
  if (target?.closest('[data-fr-panel], [data-workspace-search-panel], [data-command-palette-panel]')) return
  const k = e.key.toLowerCase()
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
    void createNewAppWindow()
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
    // Ctrl+Shift+F 工作区全文搜索(v0.5.2):无工作区静默,对齐 Ctrl+P。
    if (!workspaceStore.activeRoot) return
    e.preventDefault()
    e.stopPropagation()
    if (workspaceSearchOpen.value) workspaceSearchOpen.value = false
    else openWorkspaceSearch()
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
  else if (k === 'p' && e.shiftKey) {
    e.preventDefault()
    e.stopPropagation()
    if (commandPaletteOpen.value) commandPaletteOpen.value = false
    else openCommandPalette()
  }
  else if (k === 'p' && !e.shiftKey) {
    // Ctrl+P 查找文件(v0.5.2):无工作区静默 —— 用户从顶栏 / 文件树空态自行进入。
    // toggle 语义:已开 → 关,未开 → 开。
    if (!workspaceStore.activeRoot) return
    e.preventDefault()
    e.stopPropagation()
    quickOpenOpen.value = !quickOpenOpen.value
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

// ========== 工作区根目录 fs.watch(v0.5.0)==========
//
// 单 recursive 句柄挂在 activeRoot。回调拿 watch event 推断脏目录,
// 100ms debounce 后让 Sidebar.refreshDir 重拉那棵子树。**不做 path diff**,
// 重拉整 dir 简单可靠,目录中数十个文件 readDir < 5ms。
//
// 与"当前文件 watch"(documentStore.startWatchOf)共存:当前文件也落在根树
// 下,会收到两份事件 —— 但 documentStore 内 `disk === lastSavedContent`
// 短路 + externalCheckInFlight 重入保护已足够去重,不需要在此特殊处理。
//
// 网络盘 / 同步工具的 notify-rs 漏报:window-focus 兜底已覆盖当前文件;
// 工作区根侧没有等价兜底(代价高 —— 重新整树 walk),v0.5.0 接受这个限制,
// 用户切回应用时手动点工作区刷新按钮(后续版本再补)。
import { watch as watchFs, type UnwatchFn as FsUnwatchFn } from '@/tauri/fs'

let workspaceUnwatch: FsUnwatchFn | null = null
const dirtyDirs = new Set<string>()
const pendingSidebarDirtyDirs = new Set<string>()
let dirtyFlushTimer: ReturnType<typeof setTimeout> | null = null

async function flushPendingSidebarDirtyDirs() {
  if (leftPanelView.value !== 'sidebar' || workspaceStore.sidebarTab !== 'files') return
  if (pendingSidebarDirtyDirs.size === 0) return
  await nextTick()
  const sidebar = sidebarRef.value
  if (!sidebar) return
  const dirs = Array.from(pendingSidebarDirtyDirs)
  pendingSidebarDirtyDirs.clear()
  for (const d of dirs) {
    sidebar.refreshDir(d)
  }
}

function scheduleDirtyFlush() {
  if (dirtyFlushTimer) return
  dirtyFlushTimer = setTimeout(() => {
    dirtyFlushTimer = null
    const dirs = Array.from(dirtyDirs)
    dirtyDirs.clear()
    const sidebar = sidebarRef.value
    for (const d of dirs) {
      if (sidebar) sidebar.refreshDir(d)
      else pendingSidebarDirtyDirs.add(d)
    }
    void flushPendingSidebarDirtyDirs()
    // Ctrl+P 索引也作废 —— 任何脏目录事件视为索引失效,下次面板打开重扫(v0.5.2)
    invalidateQuickOpenIndex(workspaceStore.activeRoot)
  }, 120)
}

/** 从 fs.watch 事件中的路径反推所属目录,以便定位要刷新哪棵子树。 */
function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i <= 0 ? p : p.slice(0, i)
}

async function startWorkspaceWatch(root: string) {
  await stopWorkspaceWatch()
  if (!tauri) return
  try {
    workspaceUnwatch = await watchFs(
      root,
      (event) => {
        const paths = Array.isArray(event.paths) ? event.paths : []
        for (const p of paths) {
          dirtyDirs.add(dirnameOf(p))
        }
        // 极端情况下没解析到 path,至少刷一下根
        if (paths.length === 0) dirtyDirs.add(root)
        scheduleDirtyFlush()
      },
      { recursive: true, delayMs: 150 },
    )
  }
  catch (e) {
    console.error('工作区 watch 启动失败', e)
  }
}

async function stopWorkspaceWatch() {
  if (!workspaceUnwatch) return
  try { await workspaceUnwatch() }
  catch (e) { console.warn('工作区 watch 停止失败', e) }
  workspaceUnwatch = null
}

// activeRoot 变化:重建 watch。先 stop 后 start,沿用 documentStore.startWatchOf
// 的 race 容忍策略 —— 用户快速切换工作区时,新 watch 句柄会赢,旧的就算回调
// 漏过来也只是多刷一次树,无副作用。
watch(() => workspaceStore.activeRoot, async (r) => {
  // 切工作区 → 清掉旧 root 的延迟目录刷新,Ctrl+P 缓存整张表清掉
  // (新工作区不复用旧索引,且旧路径上的 watch 已停)。
  pendingSidebarDirtyDirs.clear()
  clearQuickOpenIndex()
  if (r) await startWorkspaceWatch(r)
  else await stopWorkspaceWatch()
})

watch(
  [() => leftPanelView.value, () => workspaceStore.sidebarTab],
  () => { void flushPendingSidebarDirtyDirs() },
)

// 当前打开文件变化 → 同步到 workspaceStore.lastFile,用户切回工作区时能恢复。
// 无活跃工作区时 setLastFile 内部直接 return,不污染状态。
watch(() => documentStore.currentFilePath, (p) => {
  workspaceStore.setLastFile(p)
})

// ========== 草稿定时落盘 ==========
// dirty 时每 DRAFT_SAVE_INTERVAL_MS 写一份到 appDataDir/drafts/,崩溃 / 强杀时
// 下次启动能恢复。store 自己已经在 save() / saveAs() 成功后清掉了,这里只管"周期"。
const DRAFT_SAVE_INTERVAL_MS = 30_000
let draftTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  // Vue 已把 App.vue 根挂上 DOM —— 打 mark(后续 await 链路里的 keydown 挂载
  // 等不能推迟到这里之后,见 0-pre 注释)。
  mark('mounted')
  // 0-pre) 关键:keydown 监听必须在第一个 await 之前挂上。
  //   启动期 await 一堆(读盘、invoke、openPath),用户在 await 期间按 Ctrl+F
  //   浏览器自己的 find 会先开 —— handler 还没挂就拦不住了。capture 阶段
  //   + preventDefault 是另一道保险,见 onKeydown 注释。
  window.addEventListener('keydown', onKeydown, { capture: true })

  // F12 打开 WebView DevTools —— Cargo.toml 开了 `devtools` feature,release 包也能用。
  // tauri command `open_devtools` 在 src-tauri/src/lib.rs 注册。dev 环境 Vite/浏览器
  // 自带 F12,这里 invoke 会失败,catch 掉就行。
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F12' && tauri) {
      e.preventDefault()
      void invoke('open_devtools').catch(() => { /* dev 环境无此 command,忽略 */ })
    }
  })

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

  let windowLabel: string | null = null
  let initialPayload: CliArgsPayload = { files: [], dirs: [] }
  if (tauri) {
    try {
      windowLabel = getCurrentWindowLabel()
      documentStore.setDraftScope(windowLabel)
      initialPayload = await takeWindowCliArgs(windowLabel)
    }
    catch (e) {
      console.error('读取窗口启动参数失败', e)
    }
  }

  // 0.1) 工作区状态(v0.5.6):activeRoot 是当前窗口 runtime 状态。
  // main 冷启动且没有 CLI dir 时,才把 persisted active 当作恢复 hint;
  // 动态窗口默认不继承其它窗口的 active,避免新空窗口自动打开别的工作区。
  const workspacesLoaded = await loadWorkspaces()
  const shouldRestoreActive = !tauri || (windowLabel === MAIN_WINDOW_LABEL && !initialPayload.dirs?.[0])
  if (workspacesLoaded) workspaceStore.loadFrom(workspacesLoaded, { restoreActive: shouldRestoreActive })

  await recentFilesStore.hydrate()

  // 0.15) 示例文档可见性 —— Vite ?raw 任何环境都可读,恒为 true。
  //       这里保留赋值是为了未来如果按平台关闭示例入口时单点改这里。
  samplesAvailable.value = true

  const initialDir = initialPayload.dirs?.[0]
  if (initialDir) workspaceStore.setActiveRoot(initialDir)
  const initialFile = initialPayload.files?.[0]
  if (initialFile) await documentStore.openPath(initialFile)

  // 首次启动且无 CLI 参数 → 弹出欢迎对话框
  if (!initialFile && !initialDir && await isFirstRun()) {
    welcomeVisible.value = true
  }

  // 无 CLI 参数 + 非首次启动:按 editor.startupMode 决定打开内容。
  //   - 'last-file'(默认):尝试打开全局最近文件(recentFilesStore 已在 0.1 hydrate);
  //     文件已不存在时 openPath 返回 false,静默保留空白文档。
  //   - 'new-doc':保留 init('') 的空白文档,不做任何事。
  // CLI 打开文件 / 目录时跳过,避免覆盖显式启动意图。
  if (!initialFile && !initialDir && store.startupMode === 'last-file') {
    const lastPath = recentFilesStore.entries[0]?.path
    if (lastPath) await documentStore.openPath(lastPath)
  }

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
      () => store.startupMode,
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

  // 工作区状态变化 → debounce 落当前窗口 active workspace 的 patch,不全量覆盖其它窗口的 roots。
  watch(
    () => [workspaceStore.activeRoot, workspaceStore.workspaces, workspaceStore.sidebarTab] as const,
    () => { debouncedWorkspaceSave() },
    { deep: true },
  )

  // 1.5) 扫一遍 appDataDir/drafts/,把"上一会话留下的"草稿装进 store。
  //      必须在启动 payload 打开文件之后,让 currentDraftId 能排除当前文档草稿。
  await documentStore.loadRecoverableDrafts()

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
  if (draftTimer) {
    clearInterval(draftTimer)
    draftTimer = null
  }
  if (dirtyFlushTimer) {
    clearTimeout(dirtyFlushTimer)
    dirtyFlushTimer = null
  }
  void stopWorkspaceWatch()
  window.removeEventListener('keydown', onKeydown, { capture: true })
  window.removeEventListener('blur', onWindowBlur)
  window.removeEventListener('focus', onWindowFocus)
})

// ========== 性能打点收口 ==========
// editorRef 首次非 null = ProseMirrorEditor 实际 mount 完成。
// 这是首屏"可交互"的真正终点 —— 在此之前 codeBlockReady 已 ready 但 PM 还没挂。
// 触发点:一次 watch(editorRef) → mark + measure 全链路 + report 一次。
let perfReported = false
watch(editorRef, (v) => {
  if (!v || perfReported) return
  perfReported = true
  mark('editor-mounted')
  measure('settings', 'script-start', 'settings-ready')
  measure('shiki', 'settings-ready', 'code-block-ready')
  measure('app-mount', 'script-start', 'mounted')
  measure('pm-mount', 'code-block-ready', 'editor-mounted')
  measure('total-tti', 'script-start', 'editor-mounted')
  report('editor-ready')
}, { flush: 'post' })
</script>

<template>
  <div
    :class="{ 'dark': store.darkMode }"
    :style="{ '--md-primary-color': store.primaryColor }"
    class="flex h-screen flex-col text-gray-900 dark:text-gray-100"
  >
    <!-- 顶栏 -->
    <header class="flex items-center justify-between gap-3 border-b border-gray-200 bg-white pl-3 text-gray-700 dark:border-gray-800 dark:bg-[#111] dark:text-gray-300">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <img :src="veloLogo" alt="Velo" class="h-6 w-6">
        <span data-tauri-drag-region class="ml-2 flex min-w-0 items-baseline gap-1.5 truncate text-sm text-gray-400" :title="documentStore.currentFilePath ?? ''">
          <span class="truncate">{{ documentStore.fileName }}</span>
          <span v-if="documentStore.readOnly" class="shrink-0 text-xs">（只读）</span>
          <span v-if="documentStore.dirty" class="shrink-0">•</span>
        </span>
        <span data-tauri-drag-region class="ml-2 h-8 min-w-6 flex-1" />
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <!-- 最近文件 -->
        <RecentFilesButton
          :entries="recentFilesStore.entries"
          @open-recent="openRecentFile"
        />
        <!-- 开发模式：手动打开欢迎对话框 -->
        <button
          v-if="isDev"
          type="button"
          class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          title="打开欢迎对话框"
          @click="welcomeVisible = true"
        >
          <MessageSquare :size="16" />
        </button>
        <span class="mx-2 h-5 w-px bg-gray-200 dark:bg-gray-700" />
        <WindowControls v-if="tauri" />
      </div>
    </header>

    <!-- 主体 -->
    <div class="flex flex-1 overflow-hidden">
      <ActivityBar
        :active="activeActivity"
        @select-file-actions="toggleFileActionsPanel"
        @select-files="toggleSidebarTab('files')"
        @select-outline="toggleSidebarTab('outline')"
        @select-search="toggleWorkspaceSearchFromActivity"
        @select-settings="toggleSettingsPanel"
      />

      <!-- 左侧功能区(v0.5.5:宽度由 splitter 决定,w-64/w-0 二元切换弃用)。
           外层 aside 保持挂载,只在收起时宽度归 0;Sidebar 走 KeepAlive,
           避免 ActivityBar 收起 / settings 切换 / auto-collapse 后重新展开 files
           时销毁 FileTree 并触发根目录 loading。splitter 仍随 leftPanelView 隐藏,
           避免 0 宽侧栏旁出现孤立分隔线。 -->
      <aside
        class="shrink-0 overflow-hidden"
        :style="{ width: `${displaySidebarWidth}px` }"
      >
        <div class="h-full overflow-hidden">
          <KeepAlive>
            <Sidebar
              v-if="leftPanelView === 'sidebar'"
              ref="sidebarRef"
              :model-value="documentStore.content"
              :file-path="documentStore.currentFilePath"
            />
          </KeepAlive>
          <FileActionsPanel
            v-if="leftPanelView === 'fileActions'"
            :is-tauri="tauri"
            :exporting="exportStore.exporting"
            :samples-available="samplesAvailable"
            @new-doc="documentStore.newDoc()"
            @new-window="createNewAppWindow()"
            @open-file="documentStore.open()"
            @open-folder="openFolderAsWorkspace()"
            @save="documentStore.save()"
            @save-as="documentStore.saveAs()"
            @export="exportStore.exportDocument()"
            @open-sample="(name) => openSample(name)"
          />
          <EditorSettings v-if="leftPanelView === 'settings'" />
        </div>
      </aside>

      <!-- 侧栏分隔条(v0.5.5):4px 透明点击热区(w-1) + 左贴边 1px 线;
           hover/drag 时向左右各扩 1px(3px)并上主题色(--md-primary-color)。
           CSS 规则见下方 <style> 块,因为 Tailwind 不便表达 ::before 视觉层
           与透明命中区分离的组合,直接写 CSS 更清晰。
           收起时不渲染,避免 0 宽侧栏旁出现孤立 1px 条。 -->
      <div
        v-if="leftPanelView"
        class="velo-splitter w-1 shrink-0 cursor-col-resize bg-transparent"
        :class="{ 'velo-splitter-dragging': sidebarSplitter.isDragging.value }"
        data-testid="sidebar-splitter"
        @mousedown="onSplitterMouseDown"
        @dblclick="sidebarSplitter.onSplitterDoubleClick"
      />

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
          :read-only="documentStore.readOnly"
          @update:model-value="documentStore.setContent"
          @cursor-position-change="updateCursorPosition"
        />
        <SourceModeEditor
          v-else
          ref="srcRef"
          v-model:find-open="findOpen"
          :model-value="documentStore.content"
          :dark-mode="store.darkMode"
          :read-only="documentStore.readOnly"
          @update:model-value="documentStore.setContent"
          @cursor-position-change="updateCursorPosition"
        />
      </template>
    </div>

    <StatusBar
      :active-root="workspaceStore.activeRoot"
      :known-roots="workspaceStore.knownRoots"
      :current-file-path="documentStore.currentFilePath"
      :content="documentStore.content"
      :dirty="documentStore.dirty"
      :source-mode="documentStore.sourceMode"
      :read-only="documentStore.readOnly"
      :read-only-locked="documentStore.readOnlyLocked"
      :cursor="cursorPosition"
      @pick-workspace="() => void workspaceStore.pickWorkspace()"
      @set-active-root="workspaceStore.setActiveRoot"
      @toggle-source-mode="documentStore.toggleSourceMode()"
      @toggle-read-only="documentStore.readOnly = !documentStore.readOnly"
    />

    <!-- 首次启动欢迎对话框：新建 / 打开文件 / 浏览示例文档 -->
    <WelcomeDialog
      :visible="welcomeVisible"
      :samples-available="samplesAvailable"
      @create-blank="onWelcomeBlank"
      @open-file="onWelcomeOpenFile"
      @open-sample="onWelcomeSample"
    />

    <!-- 崩溃恢复弹窗:启动时如果 appDataDir/drafts/ 里有上一会话留下的草稿就弹出 -->
    <DraftRecoveryDialog
      :drafts="documentStore.pendingRecoveryDrafts"
      :visible="documentStore.pendingRecoveryDrafts.length > 0"
      @recover="(id) => void documentStore.recoverDraft(id)"
      @discard="(id) => void documentStore.discardDraft(id)"
      @dismiss="documentStore.dismissRecoveryDialog()"
    />

    <!-- Ctrl+P 查找文件浮层(v0.5.2):工作区维度,与 FindReplace 独立。
         v-if 控制实例存活 —— 关闭即销毁,下次打开重新拉索引(配合 quickOpenIndex 缓存). -->
    <QuickOpenPanel
      v-if="quickOpenOpen"
      :open="quickOpenOpen"
      @update:open="(v) => quickOpenOpen = v"
    />

    <!-- Ctrl+Shift+P 命令面板(v0.5.7):全局操作入口,复用 QuickOpen 的顶部浮层体验。 -->
    <CommandPalettePanel
      v-if="commandPaletteOpen"
      :open="commandPaletteOpen"
      :items="commandPaletteItems"
      @update:open="(v) => commandPaletteOpen = v"
    />

    <!-- Ctrl+Shift+F 全文搜索浮层(v0.5.2):实时 JS 扫描工作区 .md,点击结果由 App.vue 统一打开并选区。 -->
    <WorkspaceSearchPanel
      v-if="workspaceSearchOpen"
      :open="workspaceSearchOpen"
      :root="workspaceStore.activeRoot"
      :initial-query="workspaceSearchInitialQuery"
      @update:open="(v) => workspaceSearchOpen = v"
      @open-result="openWorkspaceSearchResult"
    />
  </div>
</template>

<style>
/* 侧栏分隔条视觉(v0.5.5)。
 * 4px 透明点击热区 + 左贴边 ::before 1px 线(gray-200 light / gray-800 dark);
 * hover 或 .velo-splitter-dragging 时视觉线向左右各扩 1px(3px) + 主题色(--md-primary-color)。
 * 不用 Tailwind arbitrary 值表达这套 ::before + transition + 主题色的组合,
 * 直接 CSS 更清晰,且样式只在 App.vue 一处用到,无需抽组件。
 */
.velo-splitter {
  position: relative;
  z-index: 1;
}
.velo-splitter::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 1px;
  pointer-events: none;
  background-color: #e5e7eb; /* gray-200 */
  transition: left 120ms ease, width 120ms ease;
}
.dark .velo-splitter::before {
  background-color: #1f2937; /* gray-800 */
}
.velo-splitter:hover::before,
.velo-splitter.velo-splitter-dragging::before {
  left: -1px;
  width: 3px;
  background-color: var(--md-primary-color, #1F71D9);
}
</style>
