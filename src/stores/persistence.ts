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
    isMacCodeBlock: boolean
    darkMode: boolean
    codeLightTheme?: string
    codeDarkTheme?: string
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
const WORKSPACES_VERSION = 3

export type SidebarTab = 'outline' | 'files'

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
    // v1/v2/v3 都接受:v3 只是把 active 语义降级为 main 冷启动 hint。
    if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== WORKSPACES_VERSION) return null
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
