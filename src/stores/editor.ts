import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { DEFAULT_LIGHT_THEME, DEFAULT_DARK_THEME } from '@/components/ProseMirrorEditor/nodes/CodeBlockLangs'
import type { PersistedSettings } from './persistence'
import type { CJKFormattingSettings, RuleScopes } from '@/lib/cjkFormatter'
import { createDefaultFormatting, RULE_DEFS } from '@/lib/cjkFormatter'
import { buildFontStack } from '@/utils/fontStacks'
import { isMacOS } from '@/utils/platform'

/** 启动时打开内容的选择。'last-file' = 打开上次打开的文件; 'new-doc' = 新建空白文档。 */
export type StartupMode = 'last-file' | 'new-doc'

/** 主题模式：'system' 跟随系统偏好，'light' 始终浅色，'dark' 始终暗色。 */
export type ThemeMode = 'system' | 'light' | 'dark'

/** 左侧 ActivityBar 的可配置入口(v0.6.1)。
 *  - 'files' / 'outline' / 'search' / 'assets' 四个**视图入口**可拖拽重排 + 可隐藏
 *  - 'settings' 固定在底部(不可拖拽),可隐藏
 *  - 「文件」下拉(FileMenuButton)固定在顶部,不参与排序 / 隐藏 —— 主命令入口,
 *    拖拽会与 #trigger slot-ref 注册链冲突,隐藏会孤立文件命令
 *  ActivityBar.vue 与 App.vue 共用此类型;canonical home 在 store 而非组件。 */
export type ActivityBarItem = 'files' | 'outline' | 'search' | 'assets' | 'history' | 'settings'

// ========== Zoom 常量(v0.7.12) ==========
// 走 Tauri set_webview_zoom 的全局视觉缩放范围 / 步长。
// 常量在此定义,editor/shortcuts/commands/zoomCommands.ts 与 EditorGroup.vue 复用。
/** 最小缩放级别(50%)。 */
export const ZOOM_LEVEL_MIN = 0.5
/** 最大缩放级别(200%)。 */
export const ZOOM_LEVEL_MAX = 2.0
/** 每次放大 / 缩小的步长。 */
export const ZOOM_LEVEL_STEP = 0.1
/** 默认缩放级别(100%)。 */
export const ZOOM_LEVEL_DEFAULT = 1.0

/** 把 zoomLevel clamp 到合法范围 [0.5, 2.0]。 */
export function clampZoomLevel(v: number): number {
  if (Number.isNaN(v)) return ZOOM_LEVEL_DEFAULT
  if (v === Number.POSITIVE_INFINITY) return ZOOM_LEVEL_MAX
  if (v === Number.NEGATIVE_INFINITY) return ZOOM_LEVEL_MIN
  if (!Number.isFinite(v)) return ZOOM_LEVEL_DEFAULT
  return Math.min(ZOOM_LEVEL_MAX, Math.max(ZOOM_LEVEL_MIN, v))
}

/** 可自定义的 4 个视图入口(顺序即从上到下)。'settings' 固定底部 —— 既不可重排也不可隐藏。 */
const DEFAULT_ACTIVITY_BAR_ORDER: ActivityBarItem[] = ['files', 'outline', 'search', 'assets', 'history']
const ACTIVITY_BAR_REORDERABLE: readonly ActivityBarItem[] = ['files', 'outline', 'search', 'assets', 'history']
const ACTIVITY_BAR_HIDEABLE: readonly ActivityBarItem[] = ['files', 'outline', 'search', 'assets', 'history']

export const useEditorStore = defineStore('editor', () => {
  const fontSize = ref('16px')
  /** 编辑器缩放级别(v0.7.12)。走 Tauri set_webview_zoom,对整个编辑器区域做全局视觉缩放。
   *  默认 1.0,范围 0.5–2.0,步长 0.1。持久化为全局 UI 偏好(同 fontSize)。 */
  const zoomLevel = ref(1.0)
  const primaryColor = ref('#1F71D9')
  // 字体选配：三类独立选择，持久化存 key（非 CSS stack 字符串）。
  // fontFamily / fontMono 为 computed，由 buildFontStack 从 key 派生出完整 CSS font-family stack。
  // 默认值按平台：macOS → charter/pingfang/sfmono，Windows → cambria/yahei/cascadiacode。
  // 旧设置文件存 'system' 的值在 hydrate 时迁移为当前平台的默认 key。
  const latinFont = ref(isMacOS ? 'charter' : 'cambria')
  const cjkFont = ref(isMacOS ? 'pingfang' : 'yahei')
  const monoFont = ref(isMacOS ? 'sfmono' : 'cascadiacode')
  /** 正文字体族（latin + cjk 拼接），注入编辑器 --md-font-family。 */
  const fontFamily = computed(() => buildFontStack(latinFont.value, cjkFont.value, monoFont.value).sans)
  /** 等宽字体族，注入 --font-mono。 */
  const fontMono = computed(() => buildFontStack(latinFont.value, cjkFont.value, monoFont.value).mono)
  /** 用户主题偏好：跟随系统 / 始终浅色 / 始终暗色。持久化字段。 */
  const themeMode = ref<ThemeMode>('system')
  /** 系统当前深浅色偏好（运行时从 matchMedia 读取，不持久化）。 */
  const systemDarkMode = ref(false)
  /** 实际生效的暗色状态：themeMode='system' 时跟随 systemDarkMode，否则由 themeMode 决定。 */
  const darkMode = computed(() =>
    themeMode.value === 'system' ? systemDarkMode.value : themeMode.value === 'dark',
  )
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
  /** 主题色是否影响文档内容颜色(标题 / 加粗 / 列表 / 折叠 / 表格等)。
   * 默认 false —— 文档内容使用各规则兜底的默认色,不受用户主色影响;
   * 开启后文档内容色跟随 --md-primary-color(旧行为)。 */
  const themeColorAffectsDoc = ref(false)
  /** CJK 字间距(可选开关,默认关闭)。
   * 纯视觉装饰,plugin `cjkLetterSpacingPlugin` 读这个字段决定是否
   * 挂 Decoration.inline(.cjk-spacing),不进 schema / 不进 markdown 序列化。 */
  const cjkLetterSpacing = ref(false)
  /** 括号自动配对(可选开关,默认开启)。
   * 输入开括号时自动插入闭括号。plugin `autoPairPlugin` 读这个字段。 */
  const autoPairEnabled = ref(true)
  /** 排版格式化设置。
   * 每条规则有 auto（输入时自动校准）和 format（格式化命令时校准）两个独立开关，
   * 由 RuleScopes 类型承载；RULE_DEFS 声明规则能力 + UI 元数据。
   * 实时层：cjkAutoFormatPlugin(全角标点 + 中英文间距) + autoPairPlugin(智能引号)
   *   读对应规则的 .auto
   * 手动层：cjkCommands + cjkFormatter 库(全部规则)
   *   读对应规则的 .format */
  const cjkFormatting = ref<CJKFormattingSettings>(createDefaultFormatting())
  // ========== ActivityBar 自定义(v0.6.1) ==========
  //
  // 持久化是**全局 UI 偏好**(走 velo-settings.json),不是 per-workspace ——
  // 与 sidebarWidth / sidebarTab 的 per-workspace 语义对照:功能栏布局是用户
  // 跨工作区一致的偏好,不应每个工作区各存一份。详见 docs/architecture/file-tree.md。
  //
  // `activityBarOrder` 只含 4 个可重排视图入口;'settings' 固定底部 —— 既不在
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
   *  仅作用于 4 个视图入口(settings 固定底部,不走此方法)。 */
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

  // ========== 设置持久化(v0.6.6 重构) ==========
  //
  // store 自己管 hydrate / snapshot,App.vue 只做泛化分发 —— 新增设置字段不再需要
  // 改 App.vue。字段守门(typeof / 枚举校验)内联在此,与 persistence.ts 的
  // PersistedSettings['editor'] 类型定义一一对应。

  /** 从磁盘 JSON 灌入编辑器设置。每字段独立 typeof 守门,非法值静默跳过。 */
  function hydrateSettings(e: PersistedSettings['editor']) {
    if (!e) return
    if (typeof e.fontSize === 'string') fontSize.value = e.fontSize
    if (typeof e.primaryColor === 'string') primaryColor.value = e.primaryColor
    // 旧版存 'system' 的值迁移为当前平台的默认 key（system 已从下拉移除）
    if (typeof e.latinFont === 'string') latinFont.value = e.latinFont === 'system' ? (isMacOS ? 'charter' : 'cambria') : e.latinFont
    if (typeof e.cjkFont === 'string') cjkFont.value = e.cjkFont === 'system' ? (isMacOS ? 'pingfang' : 'yahei') : e.cjkFont
    if (typeof e.monoFont === 'string') monoFont.value = e.monoFont === 'system' ? (isMacOS ? 'sfmono' : 'cascadiacode') : e.monoFont
    // themeMode 优先；旧版本设置文件没有 themeMode，从废弃的 darkMode 字段迁移
    if (e.themeMode === 'system' || e.themeMode === 'light' || e.themeMode === 'dark') {
      themeMode.value = e.themeMode
    } else if (typeof e.darkMode === 'boolean') {
      themeMode.value = e.darkMode ? 'dark' : 'light'
    }
    if (typeof e.codeLightTheme === 'string') codeLightTheme.value = e.codeLightTheme
    if (typeof e.codeDarkTheme === 'string') codeDarkTheme.value = e.codeDarkTheme
    if (e.startupMode === 'last-file' || e.startupMode === 'new-doc') startupMode.value = e.startupMode
    if (typeof e.showCodeLineNumbers === 'boolean') showCodeLineNumbers.value = e.showCodeLineNumbers
    if (typeof e.showBreadcrumbs === 'boolean') showBreadcrumbs.value = e.showBreadcrumbs
    if (typeof e.themeColorAffectsDoc === 'boolean') themeColorAffectsDoc.value = e.themeColorAffectsDoc
    if (typeof e.cjkLetterSpacing === 'boolean') cjkLetterSpacing.value = e.cjkLetterSpacing
    if (typeof e.autoPairEnabled === 'boolean') autoPairEnabled.value = e.autoPairEnabled
    if (typeof e.zoomLevel === 'number' && Number.isFinite(e.zoomLevel)) {
      zoomLevel.value = clampZoomLevel(e.zoomLevel)
    }
    // 排版格式化设置: RuleScopes 字段向后兼容旧版 boolean，非规则字段逐字段守门
    if (e.cjkFormatting && typeof e.cjkFormatting === 'object') {
      const src = e.cjkFormatting as unknown as Record<string, unknown>
      const dst = cjkFormatting.value as unknown as Record<string, unknown>
      // RuleScopes 字段: 旧版 boolean → { auto: v, format: v }; 新版 { auto, format } → 逐字段守门
      for (const def of RULE_DEFS) {
        const val = src[def.key]
        if (typeof val === 'boolean') {
          ;(dst[def.key] as RuleScopes).auto = val
          ;(dst[def.key] as RuleScopes).format = val
        } else if (val && typeof val === 'object') {
          const obj = val as { auto?: unknown; format?: unknown }
          if (typeof obj.auto === 'boolean') (dst[def.key] as RuleScopes).auto = obj.auto
          if (typeof obj.format === 'boolean') (dst[def.key] as RuleScopes).format = obj.format
        }
      }
      // 非规则字段
      if (src.quoteStyle === 'curly' || src.quoteStyle === 'corner' || src.quoteStyle === 'guillemets') {
        cjkFormatting.value.quoteStyle = src.quoteStyle
      }
      if (typeof src.cjkCornerQuotes === 'boolean') cjkFormatting.value.cjkCornerQuotes = src.cjkCornerQuotes
      if (typeof src.skipReferenceSections === 'boolean') cjkFormatting.value.skipReferenceSections = src.skipReferenceSections
    }
    // ActivityBar:normalize 防御(未知项过滤 / 缺失项补默认)后灌入。
    hydrateActivityBarConfig(e.activityBarOrder, e.activityBarHidden)
  }

  /** 快照当前编辑器设置为可序列化对象。App.vue 落盘前调用。 */
  function snapshotSettings(): PersistedSettings['editor'] {
    return {
      fontSize: fontSize.value,
      primaryColor: primaryColor.value,
      latinFont: latinFont.value,
      cjkFont: cjkFont.value,
      monoFont: monoFont.value,
      fontFamily: fontFamily.value,
      themeMode: themeMode.value,
      codeLightTheme: codeLightTheme.value,
      codeDarkTheme: codeDarkTheme.value,
      startupMode: startupMode.value,
      showCodeLineNumbers: showCodeLineNumbers.value,
      showBreadcrumbs: showBreadcrumbs.value,
      themeColorAffectsDoc: themeColorAffectsDoc.value,
      cjkLetterSpacing: cjkLetterSpacing.value,
      autoPairEnabled: autoPairEnabled.value,
      zoomLevel: zoomLevel.value,
      cjkFormatting: { ...cjkFormatting.value },
      activityBarOrder: activityBarOrder.value,
      activityBarHidden: activityBarHidden.value,
    }
  }

  return {
    fontSize,
    primaryColor,
    latinFont,
    cjkFont,
    monoFont,
    fontFamily,
    fontMono,
    themeMode,
    systemDarkMode,
    darkMode,
    codeLightTheme,
    codeDarkTheme,
    startupMode,
    showCodeLineNumbers,
    showBreadcrumbs,
    themeColorAffectsDoc,
    cjkLetterSpacing,
    autoPairEnabled,
    zoomLevel,
    cjkFormatting,
    activityBarOrder,
    activityBarHidden,
    visibleActivityBarItems,
    isActivityBarItemHidden,
    reorderActivityBar,
    toggleActivityBarHidden,
    resetActivityBar,
    hydrateActivityBarConfig,
    hydrateSettings,
    snapshotSettings,
  }
})

/** 防御性归一化:磁盘 JSON 可能被手改 / 旧版本污染 / 缺字段。
 *  - order:过滤未知项 + dedupe + 按默认序补齐缺失的 4 个视图入口
 *  - hidden:仅保留可隐藏的 4 个视图入口(剔除 settings —— 固定显示)+ dedupe
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
