import { appDataDir, join } from '@/tauri/path'
import {
  exists,
  readTextFile,
  writeTextFile,
  mkdir,
  readDir,
  remove,
  rename,
  tauriOnly,
} from '@/tauri/fs'
import { findSample } from '@/utils/samples'
import type { ActivityBarItem } from './editor'

// Sample 文档走 Vite 动态 `import('?raw')` —— 每个 sample 被拆成独立 chunk,
// 用户打开示例才下载,不打开就不下载(避免白付 10-20KB 体积)。字符串编译进
// JS bundle 后,磁盘上没有任何用户可改的实体文件,reinstall / uninstall 自动
// 跟着应用走,不存在单独清理问题。
const SAMPLE_LOADERS: Record<string, () => Promise<{ default: string }>> = {
  'sample.md': () => import('@/assets/sample.md?raw'),
}

// `tauriOnly()` 来自 `@/tauri/fs` —— dev web 端 load 返回 null / save 是
// noop,store 走默认值继续渲染,不阻塞 dev 体验。

// ========== 用户设置 ==========

const SETTINGS_FILE = 'velo-settings.json'
const SETTINGS_VERSION = 1

export interface PersistedSettings {
  version: number
  editor: {
    fontSize: string
    primaryColor: string
    fontFamily: string
    darkMode: boolean
    codeLightTheme?: string
    codeDarkTheme?: string
    /** 启动时打开内容的选择。'last-file' | 'new-doc'。 */
    startupMode?: 'last-file' | 'new-doc'
/** WYSIWYG 代码块行号(可选,默认 false)。v0.5.11 加。 */
showCodeLineNumbers?: boolean
/** 编辑器顶部面包屑(可选,默认 true)。v0.6.5 加。 */
showBreadcrumbs?: boolean
    /** ActivityBar 视图入口顺序(可选,v0.6.1)。仅含 files/outline/search 3 项;
     *  'settings' 固定底部不在内。缺失项由 normalizeActivityBarConfig 按默认序补齐。 */
    activityBarOrder?: ActivityBarItem[]
    /** ActivityBar 被隐藏的入口(可选,v0.6.1)。可含 settings。 */
    activityBarHidden?: ActivityBarItem[]
  }
  document: {
    autoSaveEnabled: boolean
    autoSaveOnBlur: boolean
  }
}

/**
 * 读 appDataDir/velo-settings.json。
 * 文件不存在 / 解析失败 / 任何 IO 异常 → 返回 null,
 * 调用方继续用 store 默认值 —— 第一次启动 / 配置损坏都不能阻塞 UI。
 * dev web 端(无 Tauri 运行时)→ 返回 null,store 走默认值,不要抛错。
 */
export async function loadSettings(): Promise<PersistedSettings | null> {
  if (!tauriOnly()) return null
  try {
    const dir = await appDataDir()
    const path = await join(dir, SETTINGS_FILE)
    if (!(await exists(path))) return null
    const json = await readTextFile(path)
    const parsed = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return null
    if (parsed.version !== SETTINGS_VERSION) return null
    return parsed as PersistedSettings
  }
  catch (e) {
    console.warn('加载设置失败,使用默认值', e)
    return null
  }
}

/**
 * 写 appDataDir/velo-settings.json。
 * 失败仅记录日志不抛 —— 设置写盘不应该把主流程搞崩。
 * dev web 端 → noop,不做任何事。
 */
export async function saveSettings(s: PersistedSettings): Promise<void> {
  if (!tauriOnly()) return
  try {
    const dir = await appDataDir()
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true })
    }
    const path = await join(dir, SETTINGS_FILE)
    await writeTextFile(path, JSON.stringify(s, null, 2))
  }
  catch (e) {
    console.error('保存设置失败', e)
  }
}

// ========== 大纲折叠状态 ==========

const OUTLINE_FILE = 'velo-outline-state.json'
const OUTLINE_VERSION = 1

export interface PersistedOutlineState {
  version: number
  // path → 该文件下处于折叠态的标题 key 数组
  files: Record<string, string[]>
}

/**
 * 读 appDataDir/velo-outline-state.json。
 * 与 settings 同样的失败策略:不存在 / 损坏 / 版本不匹配 → null,调用方用空状态继续。
 */
export async function loadOutlineState(): Promise<PersistedOutlineState | null> {
  if (!tauriOnly()) return null
  try {
    const dir = await appDataDir()
    const path = await join(dir, OUTLINE_FILE)
    if (!(await exists(path))) return null
    const json = await readTextFile(path)
    const parsed = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return null
    if (parsed.version !== OUTLINE_VERSION) return null
    if (typeof parsed.files !== 'object' || parsed.files === null) return null
    return parsed as PersistedOutlineState
  }
  catch (e) {
    console.warn('加载大纲折叠状态失败', e)
    return null
  }
}

export async function saveOutlineState(s: PersistedOutlineState): Promise<void> {
  if (!tauriOnly()) return
  try {
    const dir = await appDataDir()
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true })
    }
    const path = await join(dir, OUTLINE_FILE)
    await writeTextFile(path, JSON.stringify(s, null, 2))
  }
  catch (e) {
    console.error('保存大纲折叠状态失败', e)
  }
}

// ========== 块级折叠状态(v0.5.12) ==========
//
// `velo-folding-state.json` 记录"每篇文档哪些块被折叠"。key 是稳定
// 字符串(由 block 类型 + 内容指纹派生,见 stores/folding.ts 注释),
// 不是 doc 绝对 pos —— 关闭 / 重开后 pos 失效,稳定 key 才能跨开关保留。
//
// 形态对齐 `velo-outline-state.json`(v0.3.0 起就有了),fallback 策略也一致:
// 损坏 / 缺文件 / 版本不匹配 → null,store 用空状态继续。

const FOLD_FILE = 'velo-folding-state.json'
const FOLD_VERSION = 1

export interface PersistedFoldState {
  version: number
  // path → 该文件下处于折叠态的 block 稳定 key 数组
  files: Record<string, string[]>
}

export async function loadFoldState(): Promise<PersistedFoldState | null> {
  if (!tauriOnly()) return null
  try {
    const dir = await appDataDir()
    const path = await join(dir, FOLD_FILE)
    if (!(await exists(path))) return null
    const json = await readTextFile(path)
    const parsed = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return null
    if (parsed.version !== FOLD_VERSION) return null
    if (typeof parsed.files !== 'object' || parsed.files === null) return null
    return parsed as PersistedFoldState
  }
  catch (e) {
    console.warn('加载折叠状态失败', e)
    return null
  }
}

export async function saveFoldState(s: PersistedFoldState): Promise<void> {
  if (!tauriOnly()) return
  try {
    const dir = await appDataDir()
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true })
    }
    const path = await join(dir, FOLD_FILE)
    await writeTextFile(path, JSON.stringify(s, null, 2))
  }
  catch (e) {
    console.error('保存折叠状态失败', e)
  }
}

// ========== 崩溃恢复草稿 ==========
//
// 脏盘期间定时把当前内容写到 appDataDir/drafts/{id}.json。
// 启动时扫描这个目录,文件还在磁盘上且内容跟磁盘一致 → 自动清理;
// 否则展示给用户让他选择恢复 / 丢弃。
//
// 落盘用 .tmp + rename 做原子写:写到一半进程死了不会留半截文件污染启动。

const DRAFTS_DIR = 'drafts'
const DRAFT_VERSION = 1

export interface Draft {
  version: number
  id: string
  /** 草稿对应的原文件路径;null 表示新建未保存的文档 */
  originalPath: string | null
  /** 草稿 markdown 内容 */
  content: string
  /** 草稿落盘时间戳 (ms) */
  savedAt: number
}

async function ensureDraftsDir(): Promise<string | null> {
  if (!tauriOnly()) return null
  try {
    const dir = await appDataDir()
    const draftsDir = await join(dir, DRAFTS_DIR)
    if (!(await exists(draftsDir))) {
      await mkdir(draftsDir, { recursive: true })
    }
    return draftsDir
  }
  catch (e) {
    console.error('创建 drafts 目录失败', e)
    return null
  }
}

function draftFileName(id: string): string {
  return `${id}.json`
}

/**
 * 写一份草稿。原子写:先写 .tmp,再 rename 到目标。
 * 失败仅记录日志不抛 —— 草稿写盘失败不能让主流程(键入/自动保存)炸。
 */
export async function saveDraft(draft: Draft): Promise<void> {
  try {
    const draftsDir = await ensureDraftsDir()
    if (!draftsDir) return
    const finalPath = await join(draftsDir, draftFileName(draft.id))
    const tmpPath = await join(draftsDir, `${draft.id}.json.tmp`)
    await writeTextFile(tmpPath, JSON.stringify(draft, null, 2))
    await rename(tmpPath, finalPath)
  }
  catch (e) {
    console.error('保存草稿失败', e)
  }
}

/**
 * 列出所有草稿。读不到草稿 / 目录不存在 → 返回空数组,不抛。
 * 解析失败的单个文件跳过(打 warn),不让一条坏数据卡死整个恢复流程。
 */
export async function loadDrafts(): Promise<Draft[]> {
  if (!tauriOnly()) return []
  try {
    const dir = await appDataDir()
    const draftsDir = await join(dir, DRAFTS_DIR)
    if (!(await exists(draftsDir))) return []
    const entries = await readDir(draftsDir)
    const drafts: Draft[] = []
    for (const entry of entries) {
      // 只处理 .json(过滤 .tmp 残留、可能的目录)
      if (!entry.name || !entry.name.endsWith('.json')) continue
      try {
        const path = await join(draftsDir, entry.name)
        const json = await readTextFile(path)
        const parsed = JSON.parse(json)
        if (typeof parsed !== 'object' || parsed === null) continue
        if (parsed.version !== DRAFT_VERSION) continue
        if (typeof parsed.id !== 'string' || typeof parsed.content !== 'string') continue
        drafts.push(parsed as Draft)
      }
      catch (e) {
        console.warn(`跳过损坏的草稿 ${entry.name}`, e)
      }
    }
    return drafts
  }
  catch (e) {
    console.warn('加载草稿列表失败', e)
    return []
  }
}

/**
 * 删一个草稿。失败仅记录日志 —— 删不掉不应该阻塞用户的恢复选择。
 */
export async function deleteDraft(id: string): Promise<void> {
  if (!tauriOnly()) return
  try {
    const dir = await appDataDir()
    const draftsDir = await join(dir, DRAFTS_DIR)
    const path = await join(draftsDir, draftFileName(id))
    if (await exists(path)) {
      await remove(path)
    }
  }
  catch (e) {
    console.error(`删除草稿 ${id} 失败`, e)
  }
}

/** 删目录下所有 .json 草稿(用于"全部丢弃")。 */
export async function deleteAllDrafts(): Promise<void> {
  if (!tauriOnly()) return
  try {
    const dir = await appDataDir()
    const draftsDir = await join(dir, DRAFTS_DIR)
    if (!(await exists(draftsDir))) return
    const entries = await readDir(draftsDir)
    for (const entry of entries) {
      if (!entry.name || !entry.name.endsWith('.json')) continue
      try {
        const path = await join(draftsDir, entry.name)
        await remove(path)
      }
      catch (e) {
        console.warn(`删除草稿 ${entry.name} 失败`, e)
      }
    }
  }
  catch (e) {
    console.error('清空草稿失败', e)
  }
}

// ========== 工作区(v0.5.0) ==========
//
// `velo-workspaces.json` 记录:用户打开过的工作区根目录列表 + 当前激活的一个
// + 每个工作区下的展开目录路径 / 上次打开文件 / 当前 sidebar tab。
//
// 大纲折叠状态(`velo-outline-state.json`)**仍按文件 path** 存,不迁进
// per-workspace —— 大纲折叠跟工作区无关,跨工作区打开同一文件应仍记住折叠。
//
// 设计选择见 docs/DECISIONS.md ADR-20260623-001(持久化拆分粒度)。

const WORKSPACES_FILE = 'velo-workspaces.json'
// v2(v0.5.5):WorkspaceState 新增 sidebarWidth 字段(侧栏宽度 px,200-600)。
// v3(v0.5.6):active 降级为 main 冷启动 hint;多窗口保存走 patch merge。
// v4(v0.6.x):WorkspaceState 新增 openTabs + activeTab(标签持久化,恢复工作区时重开上次的标签集)。
const WORKSPACES_VERSION = 4

export type SidebarTab = 'outline' | 'files' | 'search' | 'assets'

export interface WorkspaceState {
  /** 该工作区下处于展开态的目录绝对路径 */
  expandedDirs: string[]
  /** 该工作区上次活跃的文件绝对路径(用户切回工作区时恢复) */
  lastFile?: string | null
  /** 该工作区下用户上次看的侧边栏 tab */
  sidebarTab?: SidebarTab
  /** 该工作区下最近打开的文件路径,头部 = 最新;cap 10。Ctrl+P 双分区用(v0.5.2). */
  recentFiles?: string[]
  /** 该工作区下用户拖拽过的侧栏宽度(px,200-600);缺失回退默认 256(v0.5.5). */
  sidebarWidth?: number
  /** 该工作区上次打开的标签文件绝对路径列表(顺序 = 标签条从左到右)。
   *  允许同一 path 出现多次(VSCode 同款 each-instance 独立 undo / 滚动 / 光标)。
   *  写盘由 workspaceStore.setOpenTabsForActiveWorkspace 推;无标签时回退空数组。
   *  v0.6.x。 */
  openTabs?: string[]
  /** 该工作区上次活动的标签绝对路径。restore 时用作 switchTab 目标;
   *  路径不在 openTabs 内(漂移) → 回退到最后一个装载成功的。 */
  activeTab?: string | null
}

export interface PersistedWorkspaces {
  version: number
  /** main 窗口冷启动恢复用的最近工作区 hint;动态窗口不把它当作全局 active。 */
  active: string | null
  /** rootPath → 该工作区的局部状态 */
  workspaces: Record<string, WorkspaceState>
}

export interface WorkspacePatch {
  /** 当前窗口的 active root;只作为下一次 main 冷启动 hint 写回。 */
  active: string | null
  /** 当前窗口改动到的 workspace roots;保存时 merge 到磁盘现有 map。 */
  workspaces: Record<string, WorkspaceState>
}

export async function loadWorkspaces(): Promise<PersistedWorkspaces | null> {
  if (!tauriOnly()) return null
  try {
    const dir = await appDataDir()
    const path = await join(dir, WORKSPACES_FILE)
    if (!(await exists(path))) return null
    const json = await readTextFile(path)
    const parsed = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return null
    // v1/v2/v3/v4 都接受:v3 是 active 语义降级;v4 仅增字段,无需迁移。
    if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== WORKSPACES_VERSION) return null
    if (typeof parsed.workspaces !== 'object' || parsed.workspaces === null) return null
    return parsed as PersistedWorkspaces
  }
  catch (e) {
    console.warn('加载工作区状态失败', e)
    return null
  }
}

export async function saveWorkspaces(s: PersistedWorkspaces): Promise<void> {
  if (!tauriOnly()) return
  try {
    const dir = await appDataDir()
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true })
    }
    const path = await join(dir, WORKSPACES_FILE)
    await writeTextFile(path, JSON.stringify({ ...s, version: WORKSPACES_VERSION }, null, 2))
  }
  catch (e) {
    console.error('保存工作区状态失败', e)
  }
}

export async function saveWorkspacePatch(patch: WorkspacePatch): Promise<void> {
  if (!tauriOnly()) return
  try {
    const current = await loadWorkspaces()
    const merged: PersistedWorkspaces = {
      version: WORKSPACES_VERSION,
      active: patch.active,
      workspaces: {
        ...(current?.workspaces ?? {}),
        ...patch.workspaces,
      },
    }
    await saveWorkspaces(merged)
  }
  catch (e) {
    console.error('保存工作区状态失败', e)
  }
}

// ========== 全局最近文件(v0.5.7) ==========
//
// `velo-recent-files.json` 记录跨工作区 / 单文件模式都可用的最近打开 Markdown 文件。
// 它与 `WorkspaceState.recentFiles` 粒度不同:后者只服务当前工作区的 Ctrl+P 最近段。
// openedAt 用于多窗口 patch merge 时做确定性去重排序。

const RECENT_FILES_FILE = 'velo-recent-files.json'
const RECENT_FILES_VERSION = 1
export const RECENT_FILES_CAP = 50

export interface RecentFileEntry {
  path: string
  openedAt: number
}

export interface PersistedRecentFiles {
  version: number
  entries: RecentFileEntry[]
}

export interface RecentFilesPatch {
  upserts?: RecentFileEntry[]
  renames?: Array<{ oldPath: string, newPath: string }>
  deletePrefixes?: string[]
}

function normalizeRecentEntries(entries: unknown): RecentFileEntry[] {
  if (!Array.isArray(entries)) return []
  const byPath = new Map<string, RecentFileEntry>()
  for (const item of entries) {
    if (typeof item !== 'object' || item === null) continue
    const path = (item as { path?: unknown }).path
    const openedAt = (item as { openedAt?: unknown }).openedAt
    if (typeof path !== 'string' || !path) continue
    if (typeof openedAt !== 'number' || !Number.isFinite(openedAt)) continue
    const prev = byPath.get(path)
    if (!prev || openedAt > prev.openedAt) byPath.set(path, { path, openedAt })
  }
  return Array.from(byPath.values())
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, RECENT_FILES_CAP)
}

function applyPathPrefix(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath
  if (path.startsWith(oldPath + '/') || path.startsWith(oldPath + '\\')) {
    return newPath + path.slice(oldPath.length)
  }
  return path
}

function hasPathPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '\\')
}

function applyRecentPatch(entries: RecentFileEntry[], patch: RecentFilesPatch): RecentFileEntry[] {
  let next = normalizeRecentEntries(entries)
  for (const rename of patch.renames ?? []) {
    next = next.map(entry => ({
      ...entry,
      path: applyPathPrefix(entry.path, rename.oldPath, rename.newPath),
    }))
  }
  for (const prefix of patch.deletePrefixes ?? []) {
    next = next.filter(entry => !hasPathPrefix(entry.path, prefix))
  }
  next.push(...(patch.upserts ?? []))
  return normalizeRecentEntries(next)
}

export async function loadRecentFiles(): Promise<PersistedRecentFiles | null> {
  if (!tauriOnly()) return null
  try {
    const dir = await appDataDir()
    const path = await join(dir, RECENT_FILES_FILE)
    if (!(await exists(path))) return null
    const json = await readTextFile(path)
    const parsed = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return null
    if ((parsed as PersistedRecentFiles).version !== RECENT_FILES_VERSION) return null
    return {
      version: RECENT_FILES_VERSION,
      entries: normalizeRecentEntries((parsed as PersistedRecentFiles).entries),
    }
  }
  catch (e) {
    console.warn('加载最近文件失败', e)
    return null
  }
}

export async function saveRecentFiles(s: PersistedRecentFiles): Promise<PersistedRecentFiles | null> {
  if (!tauriOnly()) return null
  try {
    const dir = await appDataDir()
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true })
    }
    const path = await join(dir, RECENT_FILES_FILE)
    const normalized: PersistedRecentFiles = {
      version: RECENT_FILES_VERSION,
      entries: normalizeRecentEntries(s.entries),
    }
    await writeTextFile(path, JSON.stringify(normalized, null, 2))
    return normalized
  }
  catch (e) {
    console.error('保存最近文件失败', e)
    return null
  }
}

export async function saveRecentFilesPatch(patch: RecentFilesPatch): Promise<PersistedRecentFiles | null> {
  if (!tauriOnly()) return null
  try {
    const current = await loadRecentFiles()
    const merged: PersistedRecentFiles = {
      version: RECENT_FILES_VERSION,
      entries: applyRecentPatch(current?.entries ?? [], patch),
    }
    return await saveRecentFiles(merged)
  }
  catch (e) {
    console.error('保存最近文件失败', e)
    return null
  }
}

// ========== 示例文档 ==========
//
// sample.md / sample-code.md 通过 Vite 动态 `import('?raw')` 加载,Vite 给
// 每个文件拆独立 chunk,内容以字符串形式编译进 JS bundle。
//
// 设计取舍(替代了原先 `bundle.resources` / `appLocalDataDir` 抽盘):
// - 物理上无文件实体 → 用户无法直接修改 → 比 `bundle.resources` 落到
//   `C:\Program Files\Velo\resources\` 还安全(虽然后者普通用户也无写权限,
//   但 admin / 解锁权限的场景仍可能改)
// - 懒加载 → 用户不打开示例就不下载对应 chunk,~5KB gzipped / chunk
// - reinstall / uninstall 不需要任何 sample 相关的磁盘清理,bundle 跟着应用走
//
// 历史坑:之前抽到 `appLocalDataDir()/samples/` 加 `.extracted` marker 做幂等,
// marker 一旦写过就再也覆盖不了 → reinstall 拿不到新内容。

/**
 * 读 sample 内容 —— Vite 动态 import 拆 chunk,只在使用时才下载。
 * 不依赖 Tauri runtime(纯 Vite 上下文即可),任何环境(dev / release)走同一份逻辑。
 */
export async function readSampleContent(key: string): Promise<string | null> {
  const entry = findSample(key)
  if (!entry) return null
  const loader = SAMPLE_LOADERS[entry.fileName]
  if (!loader) return null
  try {
    const mod = await loader()
    return mod.default
  }
  catch (e) {
    console.error('[samples] failed to load', entry.fileName, e)
    return null
  }
}

/**
 * 判断是否是首次启动:appDataDir 下没有 velo-settings.json 即为首次。
 * 保守策略:无法判断时视为非首次(不弹出欢迎框)。
 */
export async function isFirstRun(): Promise<boolean> {
  if (!tauriOnly()) return false
  try {
    const dir = await appDataDir()
    return !(await exists(await join(dir, SETTINGS_FILE)))
  }
  catch {
    return false
  }
}
