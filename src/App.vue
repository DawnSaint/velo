<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, provide, computed } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { useDocumentStore } from '@/stores/document'
import { useOutlineStore } from '@/stores/outline'
import { useExportStore } from '@/stores/export'
import { useWorkspaceStore, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX } from '@/stores/workspace'
import type { SidebarTab } from '@/stores/persistence'
import { useRecentFilesStore } from '@/stores/recentFiles'
import { useVersionHistoryStore } from '@/stores/versionHistory'
import { useFoldStore } from '@/stores/folding'
import { loadSettings, saveSettings, loadOutlineState, saveOutlineState, loadFoldState, saveFoldState, loadWorkspaces, saveWorkspacePatch, type PersistedSettings } from '@/stores/persistence'
import {
  getHighlighter,
  ensureTheme,
  BASELINE_LANGS,
  DEFAULT_LIGHT_THEME,
  DEFAULT_DARK_THEME,
} from '@/components/ProseMirrorEditor/nodes/CodeBlockLangs'
import { extractLangsFromDoc } from '@/components/ProseMirrorEditor/editor/markdownIO'
import { codeHighlightKey } from '@/components/ProseMirrorEditor/nodes/CodeHighlightWidget'
import { lineNumbersKey } from '@/components/ProseMirrorEditor/nodes/CodeLineNumberWidget'
import { cjkSpacingKey } from '@/components/ProseMirrorEditor/plugins/cjkLetterSpacing'
import { autoPairKey } from '@/components/ProseMirrorEditor/plugins/autoPair'
import { cjkAutoFormatKey } from '@/components/ProseMirrorEditor/plugins/cjkAutoFormat'
import { schema } from '@/components/ProseMirrorEditor/editor/schema'
import { cmdFormatCJKDocument } from '@/components/ProseMirrorEditor/editor/shortcuts/commands/cjkCommands'
import ProseMirrorEditor from '@/components/ProseMirrorEditor/index.vue'
import SourceModeEditor from '@/components/SourceModeEditor.vue'
import { useWorkspaceWatch } from '@/composables/useWorkspaceWatch'
import { useCommandPaletteItems } from '@/composables/useCommandPaletteItems'
import { useWorkspaceSearch } from '@/composables/useWorkspaceSearch'
import { useGlobalKeybindings } from '@/composables/useGlobalKeybindings'
import { useCrossModeSync } from '@/composables/useCrossModeSync'
import { useUpdater } from '@/composables/useUpdater'
import { useZoom } from '@/composables/useZoom'
import { createPmBackend, createCmBackend } from '@/components/ProseMirrorEditor/findreplace/backend'
import { findIntentKey } from '@/components/ProseMirrorEditor/findreplace/findIntent'
import SettingsPage from '@/components/settings/SettingsPage.vue'
import { registerBuiltinSettingsGroups } from '@/components/settings/registerGroups'
import { getSettingsGroups } from '@/components/settings/registry'
import Sidebar from '@/components/Sidebar/Sidebar.vue'
import DiffView from '@/components/DiffView.vue'
import WelcomeDialog from '@/components/WelcomeDialog.vue'
import QuickCommandPanel from '@/components/QuickCommandPanel.vue'
import TabBar from '@/components/TabBar.vue'
import Breadcrumbs from '@/components/Breadcrumbs.vue'
import ActivityBar, { type ActivityBarItem } from '@/components/ActivityBar.vue'
import FileMenuButton from '@/components/FileMenuButton.vue'
import { ChevronDown } from '@lucide/vue'
import WindowControls from '@/components/WindowControls.vue'
import StatusBar from '@/components/StatusBar.vue'
import ToastContainer from '@/components/ToastContainer.vue'
import ZoomIndicator from '@/components/ZoomIndicator.vue'
import { DEFAULT_CURSOR_POSITION, type CursorPosition } from '@/utils/editorCursor'
import type { HeadingBreadcrumb } from '@/utils/breadcrumbs'
import { useResizeSplitter } from '@/components/ProseMirrorEditor/composables/useResizeSplitter'
import { NodeSelection } from 'prosemirror-state'
import { resolveImageAssetAbsPath, dirnameSync } from '@/utils/imagePath'
import { mark, measure, report } from '@/utils/perf'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isTauri } from '@tauri-apps/api/core'
import {
  getCurrentWindowLabel,
  newAppWindow,
  takeWindowCliArgs,
  type CliArgsPayload,
} from '@/tauri/window'

import { isMacOS as isMacOSPlatform } from '@/utils/platform'
const tauri = isTauri()
// macOS 检测:仅桌面端生效,浏览器 dev 模式不走此分支。
// UA 比 navigator.platform 更稳定(platform 已 deprecated)。
const isMacOS = tauri && isMacOSPlatform
const MAIN_WINDOW_LABEL = 'main'

const store = useEditorStore()
const documentStore = useDocumentStore()
const outlineStore = useOutlineStore()
const foldStore = useFoldStore()
const exportStore = useExportStore()
const workspaceStore = useWorkspaceStore()
const recentFilesStore = useRecentFilesStore()
const versionHistoryStore = useVersionHistoryStore()

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
// 标签恢复完成标志:Phase 1(createTabsFromPaths)或 fallback init 后置 true。
// 守门编辑器/WelcomeDialog,避免启动期先显示“未命名”Tab 再跳变为恢复的 Tab。
const tabsReady = ref(false)
void initSettings()
  .finally(() => { settingsReady.value = true; mark('settings-ready') })
  .then(async () => {
    // 等 settings hydrate 完再读 store 主题(此时是用户值,可能不是 DEFAULT)
    // 空字符串(NO_THEME) → 用 DEFAULT 装 highlighter(shiki createHighlighter
    // 需要至少一个合法主题),渲染时 getTokensSync 会据此跳过。
    const light = store.codeLightTheme || DEFAULT_LIGHT_THEME
    const dark = store.codeDarkTheme || DEFAULT_DARK_THEME
    // createHighlighter 是 singleton,本次调用的 lang 集合决定终身装哪些 grammar
    // (ensureLanguage 只能 append,不能改这次 freeze 的集合)。首屏 ~11 项
    // BASELINE × ~200KB ≈ 2.2MB,远小于旧版"30 个 lang 全装" ~6MB。
    // 注意冷启动时 documentStore.content 还是空白/首屏示例,extractLangsFromDoc
    // 扫不出真实文件 —— 首屏零闪烁全靠 BASELINE 兜底,这是 baseline 的根本意义。
    // doc 里没出现 / 用户后续切换的 lang 由 plugin getTokensSync 走
    // ensureLanguage 异步追加(该语言代码块首帧闪黑一次,之后缓存不再闪)。
    const usedLangs = extractLangsFromDoc(documentStore.content)
    const bootstrapLangs = [...new Set([...usedLangs, ...BASELINE_LANGS])]
    // 装用户主题 + 预扫 lang;singleton 若已被占,这里 getHighlighter 拿到旧
    // hl,ensureTheme 补装用户主题。两条路都确保 highlighter 装好用户主题 +
    // 预扫 lang。
    await getHighlighter(bootstrapLangs, light, dark)
    await ensureTheme(light)
    await ensureTheme(dark)
    // markdown grammar 已纳入 BASELINE_LANGS,随 getHighlighter(bootstrapLangs,...)
    // 同步装好(即使用户秒切源码模式也命中缓存无需等待),无需再 fire-and-forget 预装。
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

// 设置页不再挤在左侧栏(#settings-panel 重做):改为整页接管编辑器主区域。
// leftPanelView 只剩 'sidebar'(文件树 / 大纲 / 搜索 / 资产);设置走 settingsOpen/Active。
type LeftPanelView = 'sidebar' | null
const leftPanelView = ref<LeftPanelView>(null)
// 设置 tab 两态:settingsOpen = tab 是否存在于 TabBar(持久,切文档 tab 不消失);
// settingsActive = tab 是否激活(编辑器显示设置页 vs 文档)。切换文档 tab 只失活
// 不关闭(X / 中键 / Escape 才真正关)。像文档 tab 一样可后台保留。
const settingsOpen = ref(false)
const settingsActive = ref(false)
// 注册内置设置分组(编辑器 / 外观 / 文档 / 系统);幂等,HMR 安全。
registerBuiltinSettingsGroups()
// 当前激活的设置分组 id。状态提升到 App.vue,保证设置失活再激活后能记住上次选中的类目。
// 注册后必有至少一组(editor),取首个作默认值。
const settingsActiveGroupId = ref<string>(getSettingsGroups()[0]?.id ?? '')
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
// (sidebar)记到 dragCollapseRestoreView,onDragReopen 时还原。
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
  // 大文档拖拽卡顿优化:拖拽期间冻结 .velo-editor 内容宽度,避免每帧 text reflow。
  // 原理见 index.scss 的 body.velo-dragging-sidebar 规则注释。
  if (dragging) {
    const editorEl = document.querySelector('.velo-editor')
    if (editorEl) {
      const w = (editorEl as HTMLElement).getBoundingClientRect().width
      document.body.style.setProperty('--velo-drag-editor-width', `${w}px`)
      document.body.classList.add('velo-dragging-sidebar')
    }
  } else {
    document.body.classList.remove('velo-dragging-sidebar')
    document.body.style.removeProperty('--velo-drag-editor-width')
  }
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
// darkMode 是 computed：themeMode='system' 时跟随 systemDarkMode（由下方
// matchMedia listener 维护），否则由 themeMode 直接决定。
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

// 主题色 CSS 变量同步到 <html>。**必须在 setup 顶层注册(不能放 onMounted 内)**:
// 编辑器 mount 由 codeBlockReady 守门(见上方注释),是一条独立于 onMounted 多个
// await 的异步链。若 watcher 放在 onMounted 内,loadOutline / loadFold /
// loadWorkspace 等 await 可能比 initSettings + shiki 更慢,导致编辑器已 mount、
// 文档已用 SCSS fallback 色(#333 近黑)渲染后,watcher 才注册并 immediate 触发
// → 首屏闪一遍"默认黑 → 主题色"。放顶层 + immediate:true:init 用 DEFAULT,
// hydrate 后 store 变化同步触发 watcher 设上用户值,此变化发生在 codeBlockReady
// 翻 true 之前 → 首帧即正确色,零闪烁。
// 主题色同步到 document.documentElement:表格拾取条 / insert dot / guide line 等
// position:fixed 浮层挂在 document.body 上,是 App 根 div 的兄弟节点,无法继承
// 根 div 上设置的 --md-primary-color。提到 <html> 后全页面所有元素都能读到。
watch(
  () => store.primaryColor,
  (color) => { document.documentElement.style.setProperty('--md-primary-color', color) },
  { immediate: true },
)

// 文档内容色(--md-doc-primary-color):默认不跟随主题色,文档内容用各规则兜底的
// 默认色;用户开启 "主题色影响文档颜色" 后才把主色灌进这个变量。提到 <html> 后
// .velo-editor 内的文档规则都能读到;关闭时 removeProperty 让 var() 走 fallback。
watch(
  [() => store.primaryColor, () => store.themeColorAffectsDoc],
  ([color, affects]) => {
    if (affects) document.documentElement.style.setProperty('--md-doc-primary-color', color)
    else document.documentElement.style.removeProperty('--md-doc-primary-color')
  },
  { immediate: true },
)

// 跟随系统深浅色：监听 prefers-color-scheme 媒体查询，实时更新 store.systemDarkMode。
// darkMode computed 会自动响应 → 上方 watch 触发 .dark class 切换。
const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
store.systemDarkMode = darkMediaQuery.matches
const onSystemThemeChange = (e: MediaQueryListEvent) => {
  store.systemDarkMode = e.matches
}
darkMediaQuery.addEventListener('change', onSystemThemeChange)

// 字号变化时通知表格浮层重定位 —— dot/handle 挂在 document.body 上,
// 不继承编辑器 font-size,字号变化后表格行高/列宽撑大但浮层不跟,需主动触发 repositionDots。
watch(
  () => store.fontSize,
  () => window.dispatchEvent(new CustomEvent('velo:font-size-change')),
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
  void documentStore.save('auto')
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
//
// hydrate / snapshot 逻辑下沉到各自 store(editorStore / documentStore),
// App.vue 只做泛化分发 —— 新增设置字段时改 store + persistence.ts 类型即可,不需要改这里。
async function initSettings() {
  const loaded = await loadSettings()
  if (!loaded) return
  store.hydrateSettings(loaded.editor)
  documentStore.hydrateSettings(loaded.document)
}

function snapshotSettings(): PersistedSettings {
  return {
    version: 1,
    editor: store.snapshotSettings(),
    document: documentStore.snapshotSettings(),
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

// ========== 块级折叠状态持久化(v0.5.12) ==========
// 形态对齐 outline:启动 load,后续 plugin view hook diff 同步 store → 500ms debounce 落盘。
// 必须早于 CLI 打开文件,fold 灌入逻辑依赖 store 已就绪(EditorInner.vue 的
// currentFilePath watch 调 foldKeysToPositions 拿 store keys)。
const debouncedFoldSave = debounce(() => {
  void saveFoldState({
    version: 1,
    files: foldStore.snapshot(),
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
  try { await documentStore.save('blur') }
  finally { savingOnBlur = false }
}

// 重新获得焦点：可能是 git pull / 外部编辑器刚保存了文件 —— 主动核对一次。
// fs:watch 在网络盘 / 原子 rename / 某些同步工具下会漏报，focus 兜底。
function onWindowFocus() {
  void documentStore.checkExternalChange()
}

// webview 刷新 / 页面卸载前静默落盘草稿 + workspace 状态(Hot Exit)。
// Tauri 的 onCloseRequested 只管窗口关闭,不覆盖 F5 / Ctrl+R webview 刷新;
// pagehide 在 Tauri webview reload / 导航离开时触发。fire-and-forget 落盘 ——
// Tauri IPC 在 pagehide 期间仍可用,microtask 内完成写盘。
function onPageHide() {
  void documentStore.saveAllDrafts()
  void saveWorkspacePatch(workspaceStore.snapshotActiveForPersistence())
}

// ========== 空状态(无标签)入口 ==========
function onWelcomeBlank() {
  documentStore.newDoc()
}
function onWelcomeOpenFile() {
  documentStore.open()
}

// ========== 查找替换 (v0.3.1) ==========
// 状态全在 App.vue 一份,v-model:find-open 透传到 ProseMirrorEditor 再到 FindReplace。
// 顶栏按钮的 active 样式、Ctrl+F 打开、X / Esc 关闭、按钮再点关闭 —— 全部
// 直接改 findOpen 这一份,不存在 mirror。
const editorRef = ref<InstanceType<typeof ProseMirrorEditor> | null>(null)
// 源代码模式编辑器 ref —— 跨模式光标/滚动同步要读 CM6 view(见 watch(sourceMode))
const srcRef = ref<InstanceType<typeof SourceModeEditor> | null>(null)
const findOpen = ref(false)

// ========== 全屏模式(F11) ==========
// OS 级全屏,窗口填满整个屏幕。F11 切换,命令面板也提供入口。
// isFullscreen 是 UI 层镜像,onResized 时同步(用户可能用 OS 手段退出全屏)。
const isFullscreen = ref(false)

// ========== 窗口最前 ==========
// OS 级 always-on-top,窗口浮在所有普通窗口之上。文件菜单 toggle,命令面板也提供入口。
// isAlwaysOnTop 是 UI 层镜像,与全屏一样不做持久化(运行时态,重启回到默认 false)。
const isAlwaysOnTop = ref(false)

// ========== 专注模式(F8) ==========
// 编辑器级视觉模式:当前段落外内容降透明度,帮助聚焦当前段落。
// 独立于全屏(可叠加),不持久化(运行时态,重启回到默认 false)。
// 文件菜单 toggle + F8 快捷键 + 命令面板入口。
const focusMode = ref(false)

function toggleFocusMode() {
  focusMode.value = !focusMode.value
}

// ========== 打字机模式(F9) ==========
// 编辑器级行为模式:光标锁定在视口垂直中线,键入 / 移动时文档在光标下滚动。
// 独立于专注模式(可叠加),不持久化(运行时态,重启回到默认 false)。
// 文件菜单 toggle + F9 快捷键 + 命令面板入口。镜像 focusMode 的运行时态范式。
const typewriterMode = ref(false)

function toggleTypewriterMode() {
  typewriterMode.value = !typewriterMode.value
}
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
const headingContext = ref<HeadingBreadcrumb[]>([])
function updateHeadingContext(chain: HeadingBreadcrumb[]) {
  headingContext.value = chain
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


// 打开查找:从当前活跃编辑器选区取初始 query。
// - 面板当前关着 → 完整重置意图(query=选区、选项清零、替换文清空),再 open。
// - 面板已开(焦点在编辑器时又按 Ctrl+F)→ 只重填 query,保留用户辛苦切的选项
//   (与旧 watch(initialQuery) 语义一致)。findOpen 已 true 不变,FindReplace 的
//   query watcher 会自动重算。
function openFind() {
  // 设置页激活时 Ctrl+F / 命令面板「查找」→ focus 设置搜索框，
  // 不设 findOpen=true，避免切回文档 tab 时 FindReplace 自动弹出。
  if (settingsActive.value) {
    document.querySelector<HTMLInputElement>('[data-settings-search-input]')?.focus()
    return
  }
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
  if (settingsActive.value) {
    document.querySelector<HTMLInputElement>('[data-settings-search-input]')?.focus()
    return
  }
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

// ========== 统一命令面板(v0.6.2)==========
// 合并原 Ctrl+P 查找文件 + Ctrl+Shift+P 命令面板:单一浮层,首字符分发模式
// ('' = file,'>' = command;后续 @ / # / : 各自提交接入)。无工作区时 Ctrl+P
// 仍静默(对齐原 ROADMAP 问答约定),Ctrl+Shift+P 命令面板在无工作区时仍可开
// (workspace 类命令 disabled 保留可见)。
const quickCommandOpen = ref(false)
const quickCommandInitialQuery = ref('')
// 模式切换用 mount key:面板已开时再按 Ctrl+P / Ctrl+Shift+P 切到另一模式,
// 靠 bump key 强制 remount 让新 initialQuery 生效(open watcher 只在 false→true 触发)。
const quickCommandMountKey = ref(0)

function showQuickCommand(prefix: string) {
  quickCommandInitialQuery.value = prefix
  quickCommandMountKey.value++
  quickCommandOpen.value = true
}

function openQuickOpen() {
  if (!workspaceStore.activeRoot) return
  findOpen.value = false
  showQuickCommand('')
}

function openCommandPalette() {
  findOpen.value = false
  showQuickCommand('>')
}




// active 高亮回显当前侧栏视图(files/outline/search/assets)。设置激活时侧栏
// 遵循 sidebarTab:outline/assets 显示空态(无文档上下文),files/search 正常渲染。
// 齿轮不参与 active 高亮,设置激活态由 TabBar 设置 tab 表达(原始语义)。
const activeActivity = computed<ActivityBarItem | null>(() => {
  if (leftPanelView.value === 'sidebar') return workspaceStore.sidebarTab
  return null
})

// 隐藏当前 active 入口时收起侧栏(v0.6.1):避免「面板还开着但无 active 按钮」的悬空态。
// 例:用户正看大纲,右键菜单勾掉大纲 → 大纲按钮消失,面板也该同步收起。
// watch 布尔源:仅在「active 项是否被隐藏」状态翻转时 fire,避免数组 deep watch 的多余触发。
watch(() => {
  const a = activeActivity.value
  return a ? store.isActivityBarItemHidden(a) : false
}, (hidden) => {
  if (hidden) leftPanelView.value = null
})

// 设置 tab 后台保留:切文档标签 / 从文件树开文件时只失活设置(不关闭 tab),
// 让设置像文档 tab 一样可后台保留。打开设置本身不动 activeId,不会触发此 watch;
// 只有用户主动切标签 / 开文件时才 fire。特殊:关掉最后一个文档 tab(activeId 变空)
// 时若设置 tab 还开着,应自动激活设置(像 closeTab 激活相邻 tab 一样)。
watch(() => documentStore.activeId, () => {
if (documentStore.tabs.length === 0 && settingsOpen.value) {
settingsActive.value = true
}
else if (settingsActive.value) {
settingsActive.value = false
}
// 切 tab 时自动关闭 diff 视图:diff 绑定的是上一个文件的快照,换文件后无意义
if (versionHistoryStore.diffViewActive) {
versionHistoryStore.closeDiffView()
}
})

function showSidebarTab(tab: SidebarTab) {
  workspaceStore.setSidebarTab(tab)
  leftPanelView.value = 'sidebar'
}

function toggleSidebarTab(tab: SidebarTab) {
  if (leftPanelView.value === 'sidebar' && workspaceStore.sidebarTab === tab) {
    leftPanelView.value = null
    return
  }
  workspaceStore.setSidebarTab(tab)
  leftPanelView.value = 'sidebar'
}

// ActivityBar 齿轮 / 命令面板「打开设置」:只打开或激活,不负责关闭。
// 无设置 tab → 新开并激活;已存在但失活 → 重新激活;已激活 → no-op(保持)。
// 关闭设置只走 TabBar 设置 tab 的 X / 中键 / Escape,齿轮不参与关闭。
function showSettingsPanel() {
settingsOpen.value = true
settingsActive.value = true
// 默认收起侧栏:设置类目改为设置页顶部 Tab 切换,不再需要借住大纲区域导航;
// 用户可随时点 ActivityBar 功能按钮重新展开侧栏浏览文件树 / 搜索等。
leftPanelView.value = null
}

// 彻底关闭设置 tab(X / 中键):tab 从 TabBar 消失,回到当前文档。
function closeSettings() {
settingsOpen.value = false
settingsActive.value = false
}

// ActivityBar 功能按钮(files/outline/search/assets)统一入口。
// 设置激活时也走正常 toggle:点当前 active tab(如 outline)收起侧栏,点其他
// tab 切换侧栏内容但设置保持激活(编辑器区仍是 SettingsPage)。用户不会因
// 点侧栏功能按钮而意外离开设置 —— 只有点文件树里的文件 / 切文档 tab 才失活设置。
function onSelectSidebarActivity(tab: SidebarTab) {
  toggleSidebarTab(tab)
}

/** Sidebar 内 WorkspaceSearchPanel emit('update:open', false):收起侧栏,
 *  与用户点 ActivityBar 已激活的搜索图标等价(X / Esc 走同一路径)。 */
function onWorkspaceSearchClose() {
  leftPanelView.value = null
}

/** 资产面板:点击图片条目 → 在 PM doc 中找到第 occurrence 个 src 匹配的 image 节点,
 *  NodeSelection 选中 + scrollIntoView + 聚焦编辑器。
 *  源码模式下无 PM view,静默跳过(资产面板本身仍可用,只是点击不定位)。 */
function onLocateImage(src: string, occurrence: number) {
  const view = editorRef.value?.getEditorView()
  if (!view || view.isDestroyed) return
  let count = 0
  let targetPos = -1
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && (node.attrs.src as string) === src) {
      if (count === occurrence) {
        targetPos = pos
        return false
      }
      count++
    }
    return true
  })
  if (targetPos < 0) return
  const tr = view.state.tr.setSelection(NodeSelection.create(view.state.doc, targetPos))
  tr.scrollIntoView()
  view.dispatch(tr)
  view.focus()
}

/** 资产面板:复制/移动图片到工作区 assets/<docName>/ 后,重写 PM doc 中
 *  所有引用该图片的 image 节点 src。setNodeMarkup 不改变文档大小,pos 无偏移。
 *  newSrc 为空串时表示图片被删除 → delete 对应 image 节点(倒序删防 pos 偏移)。
 *  事务触发正常 onChange → documentStore.content 更新 → autosave。
 *  源码模式下无 PM view,静默跳过(文件操作已完成,切回 WYSIWYG 后 src 仍是旧的,
 *  属于已知限制 —— 与 locate-image 同款策略)。 */
function onReorganizeAsset(payload: { oldAbsPath: string; newSrc: string; mode: 'copy' | 'move' }) {
  const view = editorRef.value?.getEditorView()
  if (!view || view.isDestroyed) return
  const { oldAbsPath, newSrc } = payload
  const currentFilePath = documentStore.currentFilePath

  const matches: { pos: number; nodeSize: number }[] = []
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image') {
      const nodeAbsPath = resolveImageAssetAbsPath(node.attrs.src as string, currentFilePath)
      if (nodeAbsPath.replace(/\\/g, '/') === oldAbsPath.replace(/\\/g, '/')) {
        matches.push({ pos, nodeSize: node.nodeSize })
      }
    }
    return true
  })

  if (matches.length === 0) return

  const tr = view.state.tr
  if (newSrc === '') {
    // 删除：倒序 delete 防 pos 偏移
    for (let i = matches.length - 1; i >= 0; i--) {
      tr.delete(matches[i].pos, matches[i].pos + matches[i].nodeSize)
    }
  } else {
    // 重写 src：setNodeMarkup 不改变文档大小，pos 无偏移
    for (const { pos } of matches) {
      const node = tr.doc.nodeAt(pos)
      if (node) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: newSrc })
      }
    }
  }
  view.dispatch(tr)
}

/** TabBar 标签右键菜单「在文件树中显示」:切到 files tab + 展开到该文件 +
 * 短暂蓝高亮。TabBar 不持有 sidebarRef,emit 上来由 App.vue 拼装。 */
function revealFileInTree(filePath: string) {
  if (!filePath) return
  workspaceStore.setSidebarTab('files')
  leftPanelView.value = 'sidebar'
  void sidebarRef.value?.revealFile(filePath)
}

/** 点文档 tab 时:侧栏已显示文件树则自动展开目录 + 定位高亮(active 态由
 *  FileTree 的 activeFile computed 跟 currentFilePath 自动同步,无需额外处理)。
 *  不切 tab 不强制开侧栏 —— 仅在 files 视图已可见时才触发。
 *  不加蓝高亮闪 —— 仅展开目录 + 滚动到该行,active 背景色足够。 */
function onTabClicked(filePath: string) {
  if (!filePath) return
  if (leftPanelView.value !== 'sidebar' || workspaceStore.sidebarTab !== 'files') return
  void sidebarRef.value?.revealFile(filePath, { flash: false })
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

async function toggleFullscreen() {
  if (!tauri) return
  try {
    const win = getCurrentWindow()
    const next = !await win.isFullscreen()
    await win.setFullscreen(next)
    isFullscreen.value = next
  }
  catch (e) {
    console.error('切换全屏失败', e)
  }
}

async function toggleAlwaysOnTop() {
  if (!tauri) return
  try {
    const win = getCurrentWindow()
    const next = !await win.isAlwaysOnTop()
    await win.setAlwaysOnTop(next)
    isAlwaysOnTop.value = next
  }
  catch (e) {
    console.error('切换窗口最前失败', e)
  }
}

function openFolderAsWorkspace() {
  void workspaceStore.pickWorkspace()
}

async function openRecentFile(path: string) {
  const ok = await documentStore.openPathInTab(path)
  if (!ok) return
  workspaceStore.setLastFile(path)
}

// ========== composable: 跨模式同步 + 行号模式 ==========
const { onRevealHeading, onBreadcrumbReveal, onLineEnter, onLinePreview, onLineConfirm, onLineCancel } = useCrossModeSync({
  editorRef,
  srcRef,
  quickCommandOpen,
  getActiveBackend: activeBackend,
})

// ========== 自动更新 ==========
// 启动后静默检查一次,有更新走 Toast 提示(不自动下载)。10s 延迟避开首屏 busy 链路。
const { autoCheck: autoCheckUpdate } = useUpdater()

// ========== 编辑器缩放(v0.7.12) ==========
// watch editorStore.zoomLevel 变化时调 Tauri setWebviewZoom。
// 快捷键(zoomCommands)和设置面板(EditorGroup)只改 store,IPC 出口收敛于此。
useZoom()

// ========== composable: 工作区搜索编排 ==========
const {
  workspaceSearchInitialQuery,
  workspaceSearchScopeDir,
  workspaceSearchReplaceStatus,
  workspaceSearchRerunToken,
  openWorkspaceSearch,
  openGlobalSearchFromFind,
  openWorkspaceSearchResult,
  onSearchInFolder,
  onWorkspaceSearchClearScope,
  onWorkspaceSearchApplyReplace,
} = useWorkspaceSearch({
  leftPanelView,
  quickCommandOpen,
  findOpen,
  showSidebarTab,
  getActiveBackend: activeBackend,
  currentSelectionText,
})

// ========== CJK 智能排版格式化 ==========
// 通过命令面板(Ctrl+Shift+P)或快捷键(Ctrl+Shift+L)触发,格式化全文。
function formatCJK() {
  const view = editorRef.value?.getEditorView()
  if (!view || view.isDestroyed) return
  cmdFormatCJKDocument(schema)(view.state, view.dispatch.bind(view), view)
  view.focus()
}

// ========== composable: 命令面板项 ==========
const commandPaletteItems = useCommandPaletteItems({
  tauri,
  isFullscreen,
  isAlwaysOnTop,
  focusMode,
  typewriterMode,
  createNewAppWindow,
  toggleFullscreen,
  toggleAlwaysOnTop,
  toggleFocusMode,
  toggleTypewriterMode,
  openFind,
  openReplace,
  openVersionHistory: () => void versionHistoryStore.openVersionHistory(),
  showSettingsPanel,
  openFolderAsWorkspace,
  openQuickOpen,
  openWorkspaceSearch,
  showSidebarTab,
  openRecentFile,
  formatCJK,
})

// ========== composable: 全局快捷键 ==========
useGlobalKeybindings({
  tauri,
  quickCommandOpen,
  quickCommandInitialQuery,
  createNewAppWindow,
  openFind,
  openReplace,
  openWorkspaceSearch,
  openCommandPalette,
  openQuickOpen,
  showSettingsPanel,
  toggleFullscreen,
  toggleFocusMode,
  toggleTypewriterMode,
})

// ========== composable: 工作区 fs.watch ==========
useWorkspaceWatch({
  tauri,
  sidebarRef,
  leftPanelView,
})

// 当前打开文件变化 → 同步到 workspaceStore.lastFile,用户切回工作区时能恢复。
// 无活跃工作区时 setLastFile 内部直接 return,不污染状态。
watch(() => documentStore.currentFilePath, (p) => {
  workspaceStore.setLastFile(p)
})

// 标签集合(openFilePaths)与当前 active 标签路径变化 → 同步到 active workspace
// 的 openTabs + activeTab(v0.6.x)。workspaceStore 内跨 root 自动过滤,App.vue 不需要
// 关心当前 activeRoot 是否仍是 1)。已有 workspaceStore deep watcher 1205-1209 接
// debouncedWorkspaceSave,无需新 debounce。这里不传 currentFilePath 把 active tab
// 标识为绝对路径——当 active 是空白标签或 sample 时,setOpenTabsForActiveWorkspace
// 内部传 null 落盘,与 lastFile 自然分离(后者同样被 setLastFile 写回 active doc 的
// currentFilePath,语义不同)。
watch(
  [() => documentStore.openFilePaths, () => documentStore.currentFilePath] as const,
  ([paths, active]) => {
    workspaceStore.setOpenTabsForActiveWorkspace(
      paths,
      active,
    )
  },
)

// ========== 草稿落盘 ==========
// dirty 时每 DRAFT_SAVE_INTERVAL_MS 写一份到 appDataDir/drafts/,崩溃 / 强杀时
// 下次启动能恢复。store 自己已经在 save() / saveAs() 成功后清掉了,这里只管"周期"。
//
// 除了 30s 定时器,还叠加一个 content 变化 → 2s debounce 的即时落盘:用户编辑后
// 不用等 30s,2s 内没有新按键就先落一份。这样即使用户编辑后立即关闭窗口 /
// 刷新 webview(pagehide 异步 IO 不可靠),草稿也已经在磁盘上了。30s 定时器
// 仍保留作为长会话兜底(用户持续编辑不停止时 2s debounce 会不断重置)。
const DRAFT_SAVE_INTERVAL_MS = 30_000
const DRAFT_DEBOUNCE_MS = 2_000
let draftTimer: ReturnType<typeof setInterval> | null = null
const debouncedDraftSave = debounce(() => {
  void documentStore.saveAllDrafts()
}, DRAFT_DEBOUNCE_MS)

onMounted(async () => {
  // Vue 已把 App.vue 根挂上 DOM —— 打 mark(后续 await 链路里的 keydown 挂载
  // 等不能推迟到这里之后,见 0-pre 注释)。
  mark('mounted')
  // keydown 监听已由 useGlobalKeybindings composable 在其 onMounted 中注册
  // (Vue FIFO,先于本 onMounted 执行),确保在启动期 await 链路之前挂上。

  // 全屏状态初始化 + resize 同步:用户可能用 OS 手段退出全屏(Esc / 鼠标手势),
  // onResized 时重新查 isFullscreen 保持 UI 镜像与实际一致。
  if (tauri) {
    const fullscreenWin = getCurrentWindow()
    try { isFullscreen.value = await fullscreenWin.isFullscreen() }
    catch { /* 权限异常时保持 false */ }
    try { isAlwaysOnTop.value = await fullscreenWin.isAlwaysOnTop() }
    catch { /* 权限异常时保持 false */ }
    void fullscreenWin.onResized(() => {
      void fullscreenWin.isFullscreen()
        .then(v => { isFullscreen.value = v })
        .catch(() => {})
    })
  }

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

  const foldLoaded = await loadFoldState()
  if (foldLoaded?.files) foldStore.loadFrom(foldLoaded.files)

  let windowLabel: string | null = null
  let initialPayload: CliArgsPayload = { files: [], dirs: [] }
  if (tauri) {
    try {
      windowLabel = getCurrentWindowLabel()
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
  // CLI 带文件时也不恢复持久化工作区:用户右键 MD 文件打开 Velo,期望看到该文件
  // 的父目录作为工作区,而不是上次的某个工作区。
  const shouldRestoreActive = !tauri || (windowLabel === MAIN_WINDOW_LABEL && !initialPayload.dirs?.[0] && !initialPayload.files?.[0])

  // 关键:loadFrom 之后**立即**把 openTabs + activeTab 拍快照到本地。
  // 原因:下面 startup 段(CLI initialFile / startupMode='last-file')会调
  // openPathInTab,触发"documentStore → workspaceStore" 的 watcher 把
  // activeWorkspace.openTabs 覆盖成当前 documents 状态(只剩 1 个)。
  // 此时再读 activeWorkspace.openTabs 就丢了。用本地副本绕开这个 race。
  let persistedOpenTabs: string[] = []
  let persistedActiveTab: string | null = null
  if (workspacesLoaded) workspaceStore.loadFrom(workspacesLoaded, { restoreActive: shouldRestoreActive })
  if (shouldRestoreActive && workspaceStore.activeRoot) {
    persistedOpenTabs = (workspaceStore.activeWorkspace.openTabs ?? []).slice()
    persistedActiveTab = workspaceStore.activeWorkspace.activeTab ?? null
  }

  // Phase 1: 立即创建标签条目(只设 currentFilePath 供 TabBar 显示文件名),
  // 不读盘。用户先看到 Tab 标题,内容异步加载。Phase 2 fire-and-forget 不阻塞
  // onMounted 后续步骤(recentFiles hydrate / CLI / draft 等)。
  if (shouldRestoreActive && persistedOpenTabs.length > 0) {
    documentStore.createTabsFromPaths(persistedOpenTabs, persistedActiveTab)
    tabsReady.value = true
    void documentStore.loadContentIntoTabs(persistedOpenTabs, { silent: true })
  }

  await recentFilesStore.hydrate()

  const initialDir = initialPayload.dirs?.[0]
  const initialFile = initialPayload.files?.[0]

  // CLI 目录(文件夹右键菜单「在 Velo 中打开」):设为工作区根 + 展开 files 侧栏,
  // 让用户直接在文件树中选择文件,而非面对一个空白未命名 Tab。
  if (initialDir) {
    workspaceStore.setActiveRoot(initialDir)
    workspaceStore.setSidebarTab('files')
    leftPanelView.value = 'sidebar'
  }

  // CLI 文件(MD 文件右键菜单「在 Velo 中打开」):打开文件 + 把父目录设为工作区根
  // + 展开 files 侧栏。无 initialDir 时才从文件推父目录(目录 + 文件混杂时目录已设为
  // 根,文件仅作为当前文档)。
  if (initialFile) {
    if (!initialDir) {
      const parentDir = dirnameSync(initialFile)
      if (parentDir) {
        workspaceStore.setActiveRoot(parentDir)
        workspaceStore.setSidebarTab('files')
        leftPanelView.value = 'sidebar'
      }
    }
    await documentStore.openPathInTab(initialFile)
  }

  // 无 CLI 参数 + 非首次启动:按 editor.startupMode 决定打开内容。
  //   - 'last-file'(默认):尝试打开全局最近文件(recentFilesStore 已在 0.1 hydrate);
  //     文件已不存在时 openPath 返回 false,静默保留空白文档。
  //   - 'new-doc':保留 init('') 的空白文档,不做任何事。
  // CLI 打开文件 / 目录时跳过,避免覆盖显式启动意图。
  //
  // shouldRestoreActive 守门:只有 main 冷启动才走 last-file 恢复。动态窗口
  // (菜单栏"新窗口" / 二次启动 single-instance)语义上就是"空窗口起步",即使
  // startupMode='last-file'也不该拉 recent file —— 否则每次新建窗口都会先蹦出
  // 一个用户的最近文档,违背"新窗口空白"的预期。CLI payload 显式路由的单个文件
  // / 目录由上方 initialFile / initialDir 处理,不走此路径。
  //
  // **persistedOpenTabs.length === 0 守门**:有工作区持久化标签时跳过 last-file
  // 单文件打开,已由上方 Phase 1 (createTabsFromPaths) 立即创建全部标签条目 +
  // Phase 2 (loadContentIntoTabs) 异步加载内容。无持久化标签时仍走 last-file
  // 作 fallback(打开最近文件到单一标签)。
  //
  // 走 loadContentIntoTabs 而非 openPathInTab:统一草稿恢复路径 —— 即使无 workspace,
  // fallback 草稿(_no_workspace)也能被检出并恢复。
  if (shouldRestoreActive && !initialFile && !initialDir && persistedOpenTabs.length === 0 && store.startupMode === 'last-file') {
    const lastPath = recentFilesStore.entries[0]?.path
    if (lastPath) {
      documentStore.createTabsFromPaths([lastPath], lastPath)
      void documentStore.loadContentIntoTabs([lastPath])
    }
  }

  // Fallback: 没有持久化标签且没有 CLI / last-file 打开文件时,创建空白标签。
  // init 幂等(已有标签则 no-op)。所有启动路径汇合于此设 tabsReady=true,
  // Phase 1 已设的重复赋值无害。守门编辑器/WelcomeDialog 不再闪"未命名" Tab。
  if (documentStore.tabs.length === 0) documentStore.init('')
  tabsReady.value = true

  // 0.25) 启动草稿定时器:dirty 状态下每 30s 落一份;clean 时 store 内部直接 return。
  //      失败仅日志,不抛 —— 草稿写盘不能阻塞主流程。
  //      注意:draft 落盘 / 恢复扫描必须放 CLI 打开文件之后(见下面 1.5)。
  draftTimer = setInterval(() => {
    void documentStore.saveAllDrafts()
  }, DRAFT_SAVE_INTERVAL_MS)

  // 0.26) content 变化 → 2s debounce 落盘草稿(即时保护)。
  //      30s 定时器是长会话兜底;这里覆盖"编辑后短时间内关闭 / 刷新"场景。
  //      dirty 时 debounce 触发 saveCurrentDraft,clean 时 store 内部直接 return。
  //      必须在 load 之后挂,否则启动恢复 loadContentIntoTabs 装载内容时会误触发。
  watch(
    () => documentStore.content,
    () => { debouncedDraftSave() },
  )

  // 0.5) 设置变化 → 落盘的 watch。必须在 load 之后挂,否则 load 自身会触发写盘。
  // deep watch store 的 snapshot —— 新增设置字段时不需要在这里加 watch 源,
  // store 的 snapshotSettings 已经覆盖所有持久化字段。
  watch(
    [() => store.snapshotSettings(), () => documentStore.snapshotSettings()],
    () => { debouncedSettingsSave() },
    { deep: true },
  )
  watch(
    () => outlineStore.collapsedByPath,
    () => { debouncedOutlineSave() },
    { deep: true },
  )

  watch(
    () => foldStore.collapsedByPath,
    () => { debouncedFoldSave() },
    { deep: true },
  )

  // 工作区状态变化 → debounce 落当前窗口 active workspace 的 patch,不全量覆盖其它窗口的 roots。
  watch(
    () => [workspaceStore.activeRoot, workspaceStore.workspaces, workspaceStore.sidebarTab] as const,
    () => { debouncedWorkspaceSave() },
    { deep: true },
  )

  // 3) keydown 监听已在最前面(0-pre)挂上 —— 启动期 await 期间也要能拦 Ctrl+F

  // 4) 失焦自动保存 + 重新聚焦时核对磁盘 + webview 卸载前落盘草稿
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener('pagehide', onPageHide)

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
  //  light, dark) 一次性装对。**这里 watch 不开 immediate** —— 首次由 view
  //  工厂的 getHighlighter 触发,本 watch 只管"用户后续改"。
  //
  // **ensureTheme 必须在 view 检查之前**:设置页激活时 PM 编辑器已卸载
  // (v-if/v-else 接管编辑器区域),view 为 null。若提前 return 跳过 ensureTheme,
  // 新主题 hex 不会被装入 highlighter —— 切回文档 tab 时 PM 重挂载,state.init
  // 从 store 读到新主题名但 hl 未 loaded → token color undefined → 全黑。
  // 先 ensureTheme 再判 view:PM 卸载期间主题已预装,切回时首帧即正确色。
  watch(
    () => [store.codeLightTheme, store.codeDarkTheme] as const,
    async ([light, dark]) => {
      const hl = await ensureTheme(light)
      await ensureTheme(dark)
      const view = editorRef.value?.getEditorView()
      if (!view || view.isDestroyed) return
      view.dispatch(view.state.tr.setMeta(codeHighlightKey, {
        highlighter: hl,
        lightTheme: light,
        darkTheme: dark,
      }))
    },
  )

  // 4.5.x) WYSIWYG 代码块行号(v0.5.11):用户改 store.showCodeLineNumbers →
  // dispatch setMeta(lineNumbersKey, { enabled }) → plugin.decorations()
  // 重跑(enabled=true 挂 widget / false 返回 DecorationSet.empty)。
  // 不开 immediate:plugin state.init 已从 store 同步读初值(见
  // CodeLineNumberWidget.ts 的 makeInitialState),首挂时开关状态已就位。
  // 本 watch 只管"用户后续改"。
  watch(
    () => store.showCodeLineNumbers,
    (enabled) => {
      const view = editorRef.value?.getEditorView()
      if (!view || view.isDestroyed) return
      view.dispatch(view.state.tr.setMeta(lineNumbersKey, { enabled }))
    },
  )

  // 4.5.x.x) CJK 字间距(v0.7.7):用户改 store.cjkLetterSpacing →
  // dispatch setMeta(cjkSpacingKey, { enabled }) → plugin.decorations()
  // 重跑(enabled=true 挂 .cjk-spacing Decoration.inline / false 返回 empty)。
  // 不开 immediate:plugin state.init 已从 store 同步读初值,首挂时开关状态已就位。
  watch(
    () => store.cjkLetterSpacing,
    (enabled) => {
      const view = editorRef.value?.getEditorView()
      if (!view || view.isDestroyed) return
      view.dispatch(view.state.tr.setMeta(cjkSpacingKey, { enabled }))
    },
  )

// 4.5.x.x.x) 括号自动配对 + 智能引号(v0.7.7):
// autoPairEnabled / smartQuoteConversion.auto / cjkCornerQuotes 变化 →
// dispatch setMeta(autoPairKey, { ... }) → plugin state.apply 更新开关。
// 智能引号逻辑已合并到 autoPairPlugin 内部，独立于 autoPairEnabled。
watch(
() => ({
enabled: store.autoPairEnabled,
smartQuoteConversion: store.cjkFormatting.smartQuoteConversion.auto,
cjkCornerQuotes: store.cjkFormatting.cjkCornerQuotes,
}),
(cfg) => {
const view = editorRef.value?.getEditorView()
if (!view || view.isDestroyed) return
view.dispatch(view.state.tr.setMeta(autoPairKey, cfg))
},
{ deep: true },
)

// 4.5.x.x.x.x) 中文排版实时格式化(v0.7.7):全角标点 + 中英文间距 + 破折号。
// 读 .auto（输入时自动校准层），.format 由 cjkFormatter 库在格式化命令时读取。
watch(
() => ({
cjkEnglishSpacing: store.cjkFormatting.cjkEnglishSpacing.auto,
fullwidthPunctuation: store.cjkFormatting.fullwidthPunctuation.auto,
dashConversion: store.cjkFormatting.dashConversion.auto,
}),
(cfg) => {
const view = editorRef.value?.getEditorView()
if (!view || view.isDestroyed) return
view.dispatch(view.state.tr.setMeta(cjkAutoFormatKey, cfg))
},
{ deep: true },
)


  // 5) Hot Exit 关闭:窗口关闭时静默落盘所有脏标签的草稿,不弹确认框。
  //    下次打开同一工作区时,loadContentIntoTabs 优先读草稿恢复(dirty=true),
  //    用户接着干即可 —— VSCode Hot Exit 语义。
  //    dev web 端无 Tauri runtime,onCloseRequested 会 throw,整段 tauri 守门跳过。
  if (tauri) {
    const win = getCurrentWindow()
    await win.onCloseRequested(async (event) => {
      const dirtyCount = documentStore.tabs.filter(t => t.dirty).length
      if (dirtyCount === 0) return
      // 有未保存修改 → 落盘草稿后直接关闭,不弹 dialog
      event.preventDefault()
      await documentStore.saveAllDrafts()
      await win.destroy()
    })
  }

  // 6) 启动后静默检查更新(10s 延迟避开首屏 busy 链路)。fire-and-forget,不阻塞。
  if (tauri) {
    setTimeout(() => { void autoCheckUpdate() }, 10_000)
  }
})

onBeforeUnmount(() => {
if (draftTimer) {
clearInterval(draftTimer)
draftTimer = null
}
// keydown / dirtyFlushTimer / stopWorkspaceWatch 的清理已由各 composable 的 onBeforeUnmount 接管
window.removeEventListener('blur', onWindowBlur)
window.removeEventListener('focus', onWindowFocus)
window.removeEventListener('pagehide', onPageHide)
darkMediaQuery.removeEventListener('change', onSystemThemeChange)
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
    class="flex h-screen flex-col text-gray-900 dark:text-gray-100"
  >
    <header
      class="flex h-9.5 shrink-0 items-stretch bg-[var(--surface-0)] text-gray-700 dark:text-gray-300"
      :data-tauri-drag-region="isMacOS || undefined"
    >
      <!-- macOS 交通灯避让区:overlay 标题栏下交通灯浮在 header 左上角,
           留出 78px 空白让按钮不被遮挡;同时作为窗口拖拽热区。 -->
      <div
        v-if="isMacOS"
        data-tauri-drag-region
        class="shrink-0"
        style="width: 78px"
      />
      <!-- 点击在按钮正下方展开文件下拉面板。 -->
      <div class="flex shrink-0 items-center justify-center w-11">
        <FileMenuButton
          :is-tauri="tauri"
          :exporting="exportStore.exporting"
          :recent-entries="recentFilesStore.entries"
          :always-on-top="isAlwaysOnTop"
          :focus-mode="focusMode"
          :typewriter-mode="typewriterMode"
          :has-document="!settingsActive && !!documentStore.activeId"
          @new-doc="documentStore.newDoc()"
          @new-window="createNewAppWindow()"
          @open-file="documentStore.open()"
          @open-folder="openFolderAsWorkspace()"
          @save="documentStore.save()"
          @save-as="documentStore.saveAs()"
          @export="exportStore.exportDocument()"
          @format-cjk="formatCJK()"
          @open-recent="openRecentFile"
          @toggle-always-on-top="toggleAlwaysOnTop()"
          @toggle-focus-mode="toggleFocusMode()"
          @toggle-typewriter-mode="toggleTypewriterMode()"
        >
          <template #trigger="{ open, toggle, registerRef }">
            <button
              :ref="registerRef"
              type="button"
              class="flex w-full items-center justify-center rounded-md text-gray-500 transition-colors hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              :class="{ 'text-gray-700 dark:text-gray-200': open }"
              title="文件"
              aria-label="文件"
              aria-haspopup="menu"
              :aria-expanded="open"
              @click="toggle"
            >
              <ChevronDown :size="18" aria-hidden="true" />
            </button>
          </template>
        </FileMenuButton>
      </div>

      <!-- 顶栏标签栏(v0.6.0 多标签) -->
      <TabBar :settings-open="settingsOpen" :settings-active="settingsActive" @reveal-in-tree="revealFileInTree" @tab-clicked="onTabClicked" @close-settings="closeSettings" @focus-settings="settingsActive = true" @focus-doc="settingsActive = false" />

      <!-- 右侧段:仅窗口控制。wrapper items-stretch 让 WindowControls 撑满顶栏高度,按钮贴齐窗口右缘。 -->
      <!-- macOS 原生装饰自带交通灯(关闭/最小化/全屏),不需要自绘窗口按钮;
           Windows/Linux 无原生装饰,继续用 WindowControls。 -->
      <div v-if="!isMacOS" class="ml-auto flex shrink-0 items-stretch">
        <WindowControls v-if="tauri" />
      </div>
    </header>

    <div class="flex flex-1 overflow-hidden bg-[var(--surface-0)]">
      <ActivityBar
        :active="activeActivity"
        @select-files="onSelectSidebarActivity('files')"
        @select-outline="onSelectSidebarActivity('outline')"
        @select-search="onSelectSidebarActivity('search')"
@select-assets="onSelectSidebarActivity('assets')"
@select-history="onSelectSidebarActivity('history')"
@select-settings="showSettingsPanel"
      />

      <!-- 左侧功能区(v0.5.5:宽度由 splitter 决定,w-64/w-0 二元切换弃用)。
           外层 aside 保持挂载,只在收起时宽度归 0;Sidebar 走 KeepAlive,
           避免 ActivityBar 收起 / settings 切换 / auto-collapse 后重新展开 files
           时销毁 FileTree 并触发根目录 loading。splitter 仍随 leftPanelView 隐藏,
           避免 0 宽侧栏旁出现孤立分隔线。 -->
      <aside
        class="shrink-0 overflow-hidden bg-[var(--surface-1)]"
        :class="{ 'pointer-events-none': sidebarSplitter.isDragging.value }"
        :style="{ width: `${displaySidebarWidth}px` }"
      >
        <KeepAlive>
          <Sidebar
            v-if="leftPanelView === 'sidebar'"
            ref="sidebarRef"
            :model-value="documentStore.content"
            :file-path="documentStore.currentFilePath"
            :workspace-search-initial-query="workspaceSearchInitialQuery"
            :workspace-search-scope-dir="workspaceSearchScopeDir"
            :workspace-search-replace-status="workspaceSearchReplaceStatus"
            :workspace-search-rerun-token="workspaceSearchRerunToken"
            :settings-active="settingsActive"
            @workspace-search-close="onWorkspaceSearchClose"
            @workspace-search-open-result="openWorkspaceSearchResult"
            @workspace-search-clear-scope="onWorkspaceSearchClearScope"
            @workspace-search-apply-replace="onWorkspaceSearchApplyReplace"
            @search-in-folder="onSearchInFolder"
            @locate-image="onLocateImage"
            @reorganize-asset="onReorganizeAsset"
          />
        </KeepAlive>
      </aside>

      <!-- 侧栏分隔条(v0.5.5):4px 透明点击热区(w-1);常态由 ::before
           画朝右渐变 shadow 作视觉分隔(从 splitter 左缘延伸到编辑器区内);
           hover/drag 时 ::after 出现 3px 主题色硬线作拖拽抓取反馈。
           CSS 规则在 index.scss。收起时不渲染。 -->
      <div
        v-if="leftPanelView"
        class="velo-splitter w-1 shrink-0 cursor-col-resize bg-[var(--surface-2)]"
        :class="{ 'velo-splitter-dragging': sidebarSplitter.isDragging.value }"
        data-testid="sidebar-splitter"
        @mousedown="onSplitterMouseDown"
        @dblclick="sidebarSplitter.onSplitterDoubleClick"
      />

      <!-- 编辑器区域 + 空态(v0.6.0 形态)。
           v-if="codeBlockReady" 守门:**shiki highlighter 装好用户主题**后才
           mount ProseMirrorEditor。PM mount 时 plugin state.highlighter 立即
           ready → `decorations(state)` 第一次跑就写正确 token inline style
           → 首屏零闪烁。单纯守 settingsReady(只等 store hydrate)不够 —— PM
           mount 早于 `await getHighlighter()` resolve,plugin 第一次跑
           decorations 时 hl 仍是 null,代码块先按 SCSS 默认色渲染,等
           setMeta 触发后才有 token 色 → 用户看到"先默认后用户"闪烁。 -->
      <div class="relative flex flex-1 flex-col min-w-0 overflow-hidden bg-[var(--surface-2)]">
        <!-- 设置页(#settings-panel 重做):整页接管编辑器主区域,顶部 Tab 切换类目
             (编辑器 / 外观 / 文档 / 系统)。取代旧流式布局 + 侧栏大纲虚拟模式导航。
             设置 tab 后台保留:切文档 tab 只失活(v-if 用 settingsActive),
             X / 中键 / Escape 才真正关(settingsOpen)。 -->
        <SettingsPage
          v-if="settingsOpen && settingsActive"
          :active-group-id="settingsActiveGroupId"
          @update:active-group-id="settingsActiveGroupId = $event"
          @close="settingsActive = false"
        />
        <template v-else>
        <DiffView
          v-if="versionHistoryStore.diffViewActive"
          @restore="(snap) => void documentStore.restoreVersionContent(snap.filePath, snap.content)"
        />
        <template v-else>
        <Breadcrumbs
          v-if="codeBlockReady && tabsReady && documentStore.activeId && store.showBreadcrumbs"
          :file-name="documentStore.fileName"
          :headings="headingContext"
          @reveal-heading="onBreadcrumbReveal"
        />
        <div class="flex flex-1 overflow-hidden">
          <template v-if="codeBlockReady && tabsReady && documentStore.activeId">
            <ProseMirrorEditor
              v-if="!documentStore.sourceMode"
              ref="editorRef"
              v-model:find-open="findOpen"
              :model-value="documentStore.content"
              :font-family="store.fontFamily"
              :font-size="store.fontSize"
              :dark-mode="store.darkMode"
              :read-only="documentStore.readOnly"
              :focus-mode="focusMode"
              :typewriter-mode="typewriterMode"
              @update:model-value="documentStore.setContent"
              @cursor-position-change="updateCursorPosition"
              @heading-context-change="updateHeadingContext"
              @open-global-search="openGlobalSearchFromFind"
            />
            <SourceModeEditor
              v-else
              ref="srcRef"
              v-model:find-open="findOpen"
              :model-value="documentStore.content"
              :dark-mode="store.darkMode"
              :read-only="documentStore.readOnly"
              :focus-mode="focusMode"
              :typewriter-mode="typewriterMode"
              @update:model-value="documentStore.setContent"
              @cursor-position-change="updateCursorPosition"
              @heading-context-change="updateHeadingContext"
              @open-global-search="openGlobalSearchFromFind"
            />
          </template>
          <!-- 无标签空状态:WelcomeDialog 作为内联占位,提供新建 / 打开入口 -->
          <WelcomeDialog
            v-else-if="codeBlockReady && tabsReady && !documentStore.activeId"
            @create-blank="onWelcomeBlank"
            @open-file="onWelcomeOpenFile"
          />
        </div>
        </template>
        </template>
      </div>
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
      :settings-active="settingsActive"
      @pick-workspace="() => void workspaceStore.pickWorkspace()"
      @set-active-root="workspaceStore.setActiveRoot"
      @toggle-source-mode="documentStore.toggleSourceMode()"
      @toggle-read-only="documentStore.readOnly = !documentStore.readOnly"
    />

    <!-- 统一命令面板(v0.6.2):合并原 Ctrl+P 查找文件 + Ctrl+Shift+P 命令面板。
         单一浮层,首字符分发模式('' = file / '>' = command;@ / # / : 后续接入)。
         :key 强制 remount 以支持面板已开时按 Ctrl+P / Ctrl+Shift+P 切换模式。 -->
    <QuickCommandPanel
      v-if="quickCommandOpen"
      :key="quickCommandMountKey"
      :open="quickCommandOpen"
      :items="commandPaletteItems"
      :initial-query="quickCommandInitialQuery"
      @update:open="(v) => quickCommandOpen = v"
      @reveal-heading="onRevealHeading"
      @line-enter="onLineEnter"
      @line-preview="onLinePreview"
      @line-confirm="onLineConfirm"
      @line-cancel="onLineCancel"
    />

    <!-- Toast 通知容器：右上角浮层，Teleport 到 body，不占文档流 -->
    <ToastContainer />

    <!-- Zoom 指示器：快捷键缩放时底部居中弹出，显示百分比 + 滑块 + 重置按钮 -->
    <ZoomIndicator />
  </div>
</template>

