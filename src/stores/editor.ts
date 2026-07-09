import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { DEFAULT_LIGHT_THEME, DEFAULT_DARK_THEME } from '@/components/ProseMirrorEditor/nodes/CodeBlockLangs'

/** 启动时打开内容的选择。'last-file' = 打开上次打开的文件; 'new-doc' = 新建空白文档。 */
export type StartupMode = 'last-file' | 'new-doc'

/** 左侧 ActivityBar 的可配置入口(v0.6.1)。
 *  - 'files' / 'outline' / 'search' 三个**视图入口**可拖拽重排 + 可隐藏
 *  - 'settings' 固定在底部(不可拖拽),可隐藏
 *  - 「文件」下拉(FileMenuButton)固定在顶部,不参与排序 / 隐藏 —— 主命令入口,
 *    拖拽会与 #trigger slot-ref 注册链冲突,隐藏会孤立文件命令
 *  ActivityBar.vue 与 App.vue 共用此类型;canonical home 在 store 而非组件。 */
export type ActivityBarItem = 'files' | 'outline' | 'search' | 'assets' | 'settings'

/** 可自定义的 3 个视图入口(顺序即从上到下)。'settings' 固定底部 —— 既不可重排也不可隐藏。 */
const DEFAULT_ACTIVITY_BAR_ORDER: ActivityBarItem[] = ['files', 'outline', 'search', 'assets']
const ACTIVITY_BAR_REORDERABLE: readonly ActivityBarItem[] = ['files', 'outline', 'search', 'assets']
const ACTIVITY_BAR_HIDEABLE: readonly ActivityBarItem[] = ['files', 'outline', 'search', 'assets']

export const useEditorStore = defineStore('editor', () => {
  const fontSize = ref('16px')
  const primaryColor = ref('#1F71D9')
  const fontFamily = ref('-apple-system-font, BlinkMacSystemFont, Helvetica Neue, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Arial, sans-serif')
  const darkMode = ref(false)
  /** 代码块浅色主题 id(sloth shiki bundledThemesInfo 的 id 字段)。 */
  const codeLightTheme = ref(DEFAULT_LIGHT_THEME)
  /** 代码块深色主题 id。 */
  const codeDarkTheme = ref(DEFAULT_DARK_THEME)
  /** 启动时打开内容的选择。默认 'last-file'。 */
  const startupMode = ref<StartupMode>('last-file')
  /** WYSIWYG 代码块行号(可选开关,默认关闭)。
   * 行号是纯视觉装饰,plugin `lineNumberPlugin` 读这个字段决定是否挂 widget,
   * 不进 schema / 不进 markdown 序列化。 */
  const showCodeLineNumbers = ref(false)
  /** 编辑器顶部面包屑(可选开关,默认开启)。
   * 纯 UI 偏好,不进 documentStore / 不持久化到 per-workspace。 */
  const showBreadcrumbs = ref(true)

  // ========== ActivityBar 自定义(v0.6.1) ==========
  //
  // 持久化是**全局 UI 偏好**(走 velo-settings.json),不是 per-workspace ——
  // 与 sidebarWidth / sidebarTab 的 per-workspace 语义对照:功能栏布局是用户
  // 跨工作区一致的偏好,不应每个工作区各存一份。详见 docs/architecture/file-tree.md。
  //
  // `activityBarOrder` 只含 3 个可重排视图入口;'settings' 固定底部 —— 既不在
  // order 内、也不可被 hidden(始终显示)。两 ref 在方法里始终 reassign 新数组
  // (不 in-place mutate),保证 App.vue 浅 watch 能感知变化触发落盘。
  const activityBarOrder = ref<ActivityBarItem[]>([...DEFAULT_ACTIVITY_BAR_ORDER])
  const activityBarHidden = ref<ActivityBarItem[]>([])

  /** 实际渲染的顶部视图入口 = order 过滤掉 hidden。ActivityBar.vue v-for 直接读它。 */
  const visibleActivityBarItems = computed<ActivityBarItem[]>(() =>
    activityBarOrder.value.filter(k => !activityBarHidden.value.includes(k)),
  )

  function isActivityBarItemHidden(key: ActivityBarItem): boolean {
    return activityBarHidden.value.includes(key)
  }

  /** 拖拽重排:把 from 移到 to 的 before / after。from===to / 任一不在可重排集 → no-op。
   *  仅作用于 3 个视图入口(settings 固定底部,不走此方法)。 */
  function reorderActivityBar(from: ActivityBarItem, to: ActivityBarItem, position: 'before' | 'after') {
    if (from === to) return
    if (!ACTIVITY_BAR_REORDERABLE.includes(from) || !ACTIVITY_BAR_REORDERABLE.includes(to)) return
    const arr = [...activityBarOrder.value]
    const fromIdx = arr.indexOf(from)
    const toIdx = arr.indexOf(to)
    if (fromIdx === -1 || toIdx === -1) return
    arr.splice(fromIdx, 1)
    // 移除 from 后 to 的下标可能前移,重新定位:
    const insertIdx = position === 'before' ? arr.indexOf(to) : arr.indexOf(to) + 1
    arr.splice(insertIdx, 0, from)
    activityBarOrder.value = arr
  }

  /** 切换某项显隐(上下文菜单勾选用)。仅作用于 3 个视图入口;'settings' 固定显示,不可隐藏。 */
  function toggleActivityBarHidden(key: ActivityBarItem) {
    if (!ACTIVITY_BAR_HIDEABLE.includes(key)) return
    const set = new Set(activityBarHidden.value)
    if (set.has(key)) set.delete(key)
    else set.add(key)
    activityBarHidden.value = [...set]
  }

  /** 恢复默认顺序 + 全部显示。 */
  function resetActivityBar() {
    activityBarOrder.value = [...DEFAULT_ACTIVITY_BAR_ORDER]
    activityBarHidden.value = []
  }

  /** 启动期从磁盘灌入:normalize 防御后写 ref。App.vue initSettings 调用。 */
  function hydrateActivityBarConfig(rawOrder: unknown, rawHidden: unknown) {
    const { order, hidden } = normalizeActivityBarConfig(rawOrder, rawHidden)
    activityBarOrder.value = order
    activityBarHidden.value = hidden
  }

  return {
    fontSize,
    primaryColor,
    fontFamily,
    darkMode,
    codeLightTheme,
    codeDarkTheme,
    startupMode,
    showCodeLineNumbers,
    showBreadcrumbs,
    activityBarOrder,
    activityBarHidden,
    visibleActivityBarItems,
    isActivityBarItemHidden,
    reorderActivityBar,
    toggleActivityBarHidden,
    resetActivityBar,
    hydrateActivityBarConfig,
  }
})

/** 防御性归一化:磁盘 JSON 可能被手改 / 旧版本污染 / 缺字段。
 *  - order:过滤未知项 + dedupe + 按默认序补齐缺失的 3 个视图入口
 *  - hidden:仅保留可隐藏的 3 个视图入口(剔除 settings —— 固定显示)+ dedupe
 *  任何非法输入都回退到默认空配置,不抛 —— 配置损坏不能阻塞 UI。 */
export function normalizeActivityBarConfig(rawOrder: unknown, rawHidden: unknown): {
  order: ActivityBarItem[]
  hidden: ActivityBarItem[]
} {
  const reorderableSet = new Set<ActivityBarItem>(ACTIVITY_BAR_REORDERABLE as ActivityBarItem[])
  const hideableSet = new Set<ActivityBarItem>(ACTIVITY_BAR_HIDEABLE as ActivityBarItem[])

  const isReorderable = (k: unknown): k is ActivityBarItem =>
    typeof k === 'string' && reorderableSet.has(k as ActivityBarItem)
  const isHideable = (k: unknown): k is ActivityBarItem =>
    typeof k === 'string' && hideableSet.has(k as ActivityBarItem)

  const seenOrder = new Set<ActivityBarItem>()
  const order: ActivityBarItem[] = []
  if (Array.isArray(rawOrder)) {
    for (const k of rawOrder) {
      if (!isReorderable(k) || seenOrder.has(k)) continue
      seenOrder.add(k)
      order.push(k)
    }
  }
  // 按默认序补齐缺失项(保留用户已排的相对顺序,缺失项追加到末尾)
  for (const k of DEFAULT_ACTIVITY_BAR_ORDER) {
    if (!seenOrder.has(k)) order.push(k)
  }

  const seenHidden = new Set<ActivityBarItem>()
  const hidden: ActivityBarItem[] = []
  if (Array.isArray(rawHidden)) {
    for (const k of rawHidden) {
      if (!isHideable(k) || seenHidden.has(k)) continue
      seenHidden.add(k)
      hidden.push(k)
    }
  }

  return { order, hidden }
}
