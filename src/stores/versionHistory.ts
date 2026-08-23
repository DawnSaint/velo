// 本地版本时间线 store(#local-timeline)
//
// 管理 UI 层状态:当前文件版本快照列表的懒加载缓存 + 选中态 + diff 视图开关。
// IO 逻辑在 persistence.ts;document.ts 的 saveDoc 在写盘成功后调
// persistence 的 saveVersionSnapshot + pruneVersionSnapshots 落盘,
// 再调本 store 的 appendSnapshot 同步更新内存缓存,使 UI 即时刷新。
//
// UI 形态(v0.8):左侧 ActivityBar「版本历史」入口 → 侧栏 VersionHistoryPanel
// 列出快照条目;点击条目 → 编辑器区切换为 DiffView(覆盖编辑器),diff 展示
// 该版本与上一版本的行级差异;DiffView 顶部「恢复」一键还原。
//
// diff 语义(同 VSCode Local History):每个快照与它的**前一版本**做 diff,
// 而非与当前编辑器内容做 diff。前一版本 = 列表中该条目后面那个(列表倒序,
// 最新在前)。未保存条目的前一版本 = 最新已保存快照(或磁盘基线,无快照时);
// 最旧的快照无前一版本 → diff old = 空字符串(全部为新增)。
//
// 虚拟"未保存"条目:文档 dirty 时在列表头部插入 UNSAVED_ID 虚拟条目,
// content = 当前编辑器内容,不可删除 / 不可恢复。
//
// Git 历史集成(#local-timeline-git):
// 当文件在 Git 仓库中时,额外加载 Git commit 历史作为时间线条目。
// Git 条目的 content 在用户选中时懒加载(git show),不随列表加载。
// `includeGit` 开关控制是否加载 Git 历史;非 Git 仓库静默降级。
// diff old 方对 Git 条目也需要异步获取(前一版本的 content 也可能来自 git show)。

import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useDocumentStore } from './document'
import {
  loadVersionSnapshots as loadVersionSnapshotsFromFs,
  VERSION_SNAPSHOT_CAP,
  VERSION_SNAPSHOT_MAX_AGE_DAYS,
  type VersionSnapshot,
} from './persistence'
import {
  gitRepoRoot,
  gitFileHistory,
  gitShowFile,
  type GitCommitEntry,
} from '@/tauri/git'
import { diffLines } from '@/utils/lineDiff'

/** 虚拟"未保存"条目 id —— 不落盘,仅在 UI 列表中展示 */
export const UNSAVED_ID = '__unsaved__'

/** Git 条目 id 前缀 —— 区分本地快照 id(时间戳) */
export const GIT_PREFIX = 'git:'

/** 生成 Git 条目的唯一 id:git:<hash>:<filePath>
 *  包含文件路径是因为同一 commit 中不同文件的内容不同,
 *  缓存 key 必须区分文件,否则同仓库中 A/B 文件的 commit 历史交集会导致跨文件缓存污染。 */
function gitEntryId(hash: string, filePath: string): string {
  return GIT_PREFIX + hash + ':' + filePath
}

/** 时间线统一条目类型(本地快照 / Git commit) */
export interface TimelineEntry {
  /** 条目 id:UNSAVED_ID | 本地快照 id(时间戳) | git:<hash>:<filePath> */
  id: string
  /** 条目来源 */
  source: 'local' | 'git' | 'unsaved'
  /** 原文件绝对路径 */
  filePath: string
  /** 时间戳 (ms):本地快照用 savedAt,Git 用 authorDate */
  timestamp: number
  /** 条目内容(本地快照在列表加载时就有;Git 条目懒加载,加载前为 null) */
  content: string | null
  /** Git commit 信息(source='git' 时有值) */
  git?: {
    hash: string
    shortHash: string
    author: string
    subject: string
    message: string
  }
  /** 本地快照原始数据(source='local'/'unsaved' 时有值) */
  snapshot?: VersionSnapshot
}

export const useVersionHistoryStore = defineStore('versionHistory', () => {
  const documentStore = useDocumentStore()

  /** 按文件路径缓存的快照列表(倒序,最新在前)。null = 未加载。 */
  const snapshotsByFile = ref<Map<string, VersionSnapshot[]>>(new Map())

  /** 按文件路径缓存的 Git commit 列表(倒序,最新在前)。null = 未加载。 */
  const gitEntriesByFile = ref<Map<string, GitCommitEntry[]>>(new Map())

  /** 按文件路径缓存的 Git 仓库根路径。null = 未检测;string = 仓库根;'' = 非 git 仓库 */
  const gitRootByFile = ref<Map<string, string | null>>(new Map())

  /** Git 条目 content 懒加载缓存:key = git:<hash>:<filePath>
   *  key 包含文件路径:同一 commit 中不同文件内容不同,必须按文件区分。 */
  const gitContentCache = ref<Map<string, string>>(new Map())

  /** Git 条目 diff 统计缓存:key = git:<hash>:<filePath>
   *  在 loadGitContent 成功后计算并写入,供 VersionHistoryPanel 列表显示 +/- */
  const gitDiffStats = ref<Map<string, { added: number; removed: number }>>(new Map())

  /** Git content 预加载是否完成(所有 git show 调用返回)。
   *  false 期间 diffStatsMap 不计算依赖 Git content 的统计,避免先显示错误的全文新增再跳变。
   *  非仓库 / 无 Git 条目时也为 true(无异步加载)。 */
  const gitContentLoaded = ref(true)

  /** Git 历史是否正在加载(gitRepoRoot → gitFileHistory → Promise.all 预加载全程)。
   *  UI 据此显示 loading spinner。 */
  const gitLoading = ref(false)

  /** diff 视图是否激活(编辑器区显示 DiffView 而非编辑器) */
  const diffViewActive = ref(false)

  /** 当前选中的条目 id(null = 未选中) */
  const selectedEntryId = ref<string | null>(null)

  /** 是否加载 Git 历史(用户开关) */
  const includeGit = ref(true)

  /** 当前文件的版本快照列表(从缓存或 null) */
  const currentFileSnapshots = computed<VersionSnapshot[] | null>(() => {
    const path = documentStore.currentFilePath
    if (!path) return null
    return snapshotsByFile.value.get(path) ?? null
  })

  /** 当前文件的 Git commit 列表(从缓存或 null) */
  const currentFileGitEntries = computed<GitCommitEntry[] | null>(() => {
    const path = documentStore.currentFilePath
    if (!path) return null
    return gitEntriesByFile.value.get(path) ?? null
  })

  /** 当前文件的 Git 仓库根(从缓存;undefined=未检测, null=非 git 仓库, string=仓库根) */
  const currentFileGitRoot = computed<string | null | undefined>(() => {
    const path = documentStore.currentFilePath
    if (!path) return undefined
    // Map.get 返回 undefined 表示 key 不存在;null 表示已检测为非 git 仓库
    const val = gitRootByFile.value.get(path)
    return val === undefined ? undefined : val
  })

  /** 虚拟"未保存"条目;dirty 时生成,代表当前编辑器内容 */
  const unsavedEntry = computed<TimelineEntry | null>(() => {
    if (!documentStore.dirty) return null
    const path = documentStore.currentFilePath
    if (!path) return null
    return {
      id: UNSAVED_ID,
      source: 'unsaved',
      filePath: path,
      timestamp: Date.now(),
      content: documentStore.content,
    }
  })

  /** 把本地快照转成 TimelineEntry */
  function snapshotToEntry(s: VersionSnapshot): TimelineEntry {
    return {
      id: s.id,
      source: 'local',
      filePath: s.filePath,
      timestamp: s.savedAt,
      content: s.content,
      snapshot: s,
    }
  }

  /** 把 Git commit 转成 TimelineEntry(content 暂为 null,选中时懒加载) */
  function gitToEntry(g: GitCommitEntry, filePath: string): TimelineEntry {
    const id = gitEntryId(g.hash, filePath)
    const cached = gitContentCache.value.get(id)
    return {
      id,
      source: 'git',
      filePath,
      timestamp: g.authorDate,
      content: cached ?? null,
      git: {
        hash: g.hash,
        shortHash: g.shortHash,
        author: g.author,
        subject: g.subject,
        message: g.message,
      },
    }
  }

  /** 完整版本序列(不受 includeGit 筛选影响)。
   *  用于 diff old 方查找前一版本——即使用户隐藏了 Git 条目,
   *  本地快照的 diff 基准仍为 Git commit 内容,避免 +/- 统计跳变。
   *  null = 本地快照未加载。 */
  const allEntries = computed<TimelineEntry[] | null>(() => {
    const snaps = currentFileSnapshots.value
    if (snaps === null) return null

    const entries: TimelineEntry[] = snaps.map(snapshotToEntry)

    // Git 条目(只要仓库已检测为 git 仓库就包含,不看 includeGit)
    if (currentFileGitRoot.value && currentFileGitEntries.value) {
      const path = documentStore.currentFilePath!
      for (const g of currentFileGitEntries.value) {
        entries.push(gitToEntry(g, path))
      }
    }

    entries.sort((a, b) => b.timestamp - a.timestamp)

    const unsaved = unsavedEntry.value
    if (unsaved) entries.unshift(unsaved)

    return entries
  })

  /** 当前文件的展示列表(受 includeGit 筛选控制,仅影响 UI 显示)。
   *  diff old 方 / diff 统计始终基于 allEntries,不受筛选影响。
   *  null = 本地快照未加载。 */
  const displayEntries = computed<TimelineEntry[] | null>(() => {
    const all = allEntries.value
    if (all === null) return null
    if (includeGit.value) return all
    // 筛选掉 Git 条目,保留本地快照 + 未保存条目
    return all.filter(e => e.source !== 'git')
  })

  /** 当前选中的条目对象 */
  const selectedEntry = computed<TimelineEntry | null>(() => {
    const id = selectedEntryId.value
    if (!id) return null
    // 虚拟条目
    if (id === UNSAVED_ID) return unsavedEntry.value
    const list = displayEntries.value
    if (!list) return null
    return list.find(e => e.id === id) ?? null
  })

  // ========== content 懒加载 ==========

  /** 加载 Git 条目的 content(git show)。
   *  已缓存则直接返回。 */
  async function loadGitContent(entry: TimelineEntry): Promise<string> {
    // 始终检查缓存——entry 可能是旧的 computed 快照,entry.content 为 null 但缓存已命中
    const id = entry.id
    const cached = gitContentCache.value.get(id)
    if (cached !== undefined) return cached
    if (entry.content !== null) return entry.content
    if (!entry.git) return ''

    // 用 entry.filePath 查找 repoRoot,不依赖 currentFileGitRoot computed
    // (currentFileGitRoot 依赖 currentFilePath,在竞态场景下可能返回错误文件的仓库根)
    const repoRoot = gitRootByFile.value.get(entry.filePath)
    if (!repoRoot) return ''

    try {
      const content = await gitShowFile(repoRoot, entry.git.hash, entry.filePath)
      gitContentCache.value.set(id, content)
      // diff 统计(+/- 行数)由 loadGitHistory 批量预加载后统一计算,
      // 或由 diffOldContentAsync(选中时)触发,此处不单独计算避免竞态
      return content
    }
    catch (e) {
      // git show 失败(文件在该 commit 中不存在,如重命名前的 commit)
      // 缓存空字符串避免反复尝试,console.warn 而非 error(这是预期内的边界情况)
      console.warn('git show 加载失败,跳过该条目', entry.git.shortHash, e)
      gitContentCache.value.set(id, '')
      return ''
    }
  }

  /** 计算 Git 条目与前一版本的 diff 统计并写入 gitDiffStats 缓存。
   *  可传入自定义条目列表(loadGitHistory 预加载阶段用,避免依赖 allEntries computed)。 */
  function computeGitDiffStats(id: string, content: string, list?: TimelineEntry[]): void {
    const all = list ?? allEntries.value
    if (!all) return
    const idx = all.findIndex(e => e.id === id)
    if (idx === -1) return
    // 前一版本 content(列表倒序, idx+1 更旧)
    let oldContent = ''
    if (idx + 1 < all.length) {
      const prev = all[idx + 1]
      oldContent = prev.content ?? gitContentCache.value.get(prev.id) ?? ''
    }
    let added = 0, removed = 0
    for (const l of diffLines(oldContent, content)) {
      if (l.type === 'added') added++
      else if (l.type === 'removed') removed++
    }
    gitDiffStats.value.set(id, { added, removed })
  }

  // ========== diff old 方 ==========

  /** 同步获取某条目的前一版本内容(diff old 方)。
   *  仅对本地快照和未保存条目有效(它们的 content 在内存中)。
   *  Git 条目需要异步获取,用 diffOldContentAsync。
   *
   *  基于完整版本序列(allEntries),不受 includeGit 筛选影响——
   *  即使用户隐藏 Git 条目,本地快照的 diff 基准仍为前一版本(可能是 Git commit)。
   *
   *  列表倒序(最新在前),前一版本 = 该条目后面那个(idx+1)。
   *  - 未保存条目 → 最新已保存快照(无快照则磁盘基线)
   *  - 本地快照 idx → 前一个更旧的同类型条目
   *  - 最旧条目无前一版本 → 空字符串 */
  function diffOldContent(entryId: string): string {
    const list = allEntries.value
    if (!list) return ''

    if (entryId === UNSAVED_ID) {
      // 未保存条目的前一版本 = 最新已保存本地快照(无快照则磁盘基线)
      const snaps = currentFileSnapshots.value
      if (snaps && snaps.length > 0) return snaps[0].content
      return documentStore.lastSavedContent
    }

    const idx = list.findIndex(e => e.id === entryId)
    if (idx === -1) return ''
    // 前一版本 = 列表中 idx+1(更旧的一版)
    if (idx + 1 < list.length) {
      const prev = list[idx + 1]
      // 本地快照 / 未保存 → content 在内存中
      if (prev.content !== null) return prev.content
      // Git 条目 → 同步返回空(需异步获取)
      return ''
    }
    return ''
  }

  /** 异步获取某条目的前一版本内容(diff old 方)。
   *  对 Git 条目会触发 git show 懒加载前一版本的 content。
   *  返回 null 表示正在加载中(调用方应显示 loading)。 */
  async function diffOldContentAsync(entryId: string): Promise<{ content: string; loading: false } | { content: null; loading: true }> {
    const list = allEntries.value
    if (!list) return { content: '', loading: false }

    if (entryId === UNSAVED_ID) {
      const snaps = currentFileSnapshots.value
      const content = snaps && snaps.length > 0 ? snaps[0].content : documentStore.lastSavedContent
      return { content, loading: false }
    }

    const idx = list.findIndex(e => e.id === entryId)
    if (idx === -1) return { content: '', loading: false }
    if (idx + 1 >= list.length) return { content: '', loading: false }

    const prev = list[idx + 1]
    if (prev.content !== null) {
      return { content: prev.content, loading: false }
    }

    // Git 条目需要异步加载
    try {
      const content = await loadGitContent(prev)
      // 选中时懒加载 prev content 后,顺便计算当前条目的 diff 统计(如果还没算)
      if (!gitDiffStats.value.has(entryId)) {
        const cur = list[idx]
        if (cur.content !== null || gitContentCache.value.has(cur.id)) {
          const curContent = cur.content ?? gitContentCache.value.get(cur.id) ?? ''
          computeGitDiffStats(entryId, curContent)
        }
      }
      return { content, loading: false }
    }
    catch {
      return { content: '', loading: false }
    }
  }

  // ========== 加载 / 缓存管理 ==========

  /** 懒加载某文件的版本快照到缓存。返回快照数组。 */
  async function loadSnapshots(filePath: string): Promise<VersionSnapshot[]> {
    const snapshots = await loadVersionSnapshotsFromFs(filePath)
    snapshotsByFile.value.set(filePath, snapshots)
    return snapshots
  }

  /** 加载当前文件的快照(如果当前有文件的话) */
  async function loadCurrentFileSnapshots(): Promise<VersionSnapshot[]> {
    const path = documentStore.currentFilePath
    if (!path) return []
    return loadSnapshots(path)
  }

  /** 检测并加载 Git 历史。
   *  始终加载 Git 数据到缓存(includeGit 只控制 displayEntries 的筛选,
   *  不影响 diff 基准——allEntries 始终包含 Git 条目)。
   *
   *  加载完成后预加载前 MAX_PRELOAD 条 Git 条目的 content(git show),
   *  使列表中可见范围内的 +/- 统计不跳变。
   *  超出预加载范围的条目在选中时再懒加载。
   *
   *  内部用 gitLoadToken 防竞态:快速切换文件时,上一次 loadGitHistory
   *  检测到 token 变化后提前返回,不再操作 gitContentLoaded。 */
  const MAX_GIT_PRELOAD = 20
  let gitLoadToken = 0

  async function loadGitHistory(filePath: string): Promise<void> {
    const token = ++gitLoadToken
    gitLoading.value = true
    // 检测是否在 git 仓库中
    const repoRoot = await gitRepoRoot(filePath)
    if (token !== gitLoadToken) return // 已被新调用取代
    gitRootByFile.value.set(filePath, repoRoot)
    if (!repoRoot) {
      gitEntriesByFile.value.set(filePath, [])
      gitContentLoaded.value = true
      gitLoading.value = false
      return
    }

    const entries = await gitFileHistory(filePath)
    if (token !== gitLoadToken) return
    gitEntriesByFile.value.set(filePath, entries)

    // 直接用传入的 filePath 构建 Git 条目,不依赖 allEntries computed
    // (allEntries 依赖 documentStore.currentFilePath,在竞态场景下可能返回旧文件的条目)
    const snaps = snapshotsByFile.value.get(filePath) ?? null
    if (snaps === null) {
      gitContentLoaded.value = true
      gitLoading.value = false
      return
    }
    const gitEntries: TimelineEntry[] = entries.map(g => gitToEntry(g, filePath))
    const toPreload = gitEntries.filter(e => e.content === null)
    if (toPreload.length === 0) {
      gitContentLoaded.value = true
      gitLoading.value = false
      return
    }

    gitContentLoaded.value = false
    // 预加载前 MAX_PRELOAD 条(最新的 N 个 commit),其余选中时懒加载
    const toPreloadSlice = toPreload.slice(0, MAX_GIT_PRELOAD)
    await Promise.all(toPreloadSlice.map(e => loadGitContent(e)))
    if (token !== gitLoadToken) return // 已被取代,不再操作 gitContentLoaded

    // 所有预加载 content 到位后,统一计算 Git 条目的 diff 统计
    // (在 Promise.all 期间 prev 的 content 可能还没加载完,统一计算避免竞态)
    // 用传入的 filePath 构建完整条目列表(本地快照 + Git 条目),不依赖 allEntries computed
    const allSnaps = snaps.map(snapshotToEntry)
    const allGitEntries = entries.map(g => gitToEntry(g, filePath))
    const all = [...allSnaps, ...allGitEntries]
    all.sort((a, b) => b.timestamp - a.timestamp)
    for (const e of all) {
      if (e.source !== 'git') continue
      const content = gitContentCache.value.get(e.id)
      if (content !== undefined) computeGitDiffStats(e.id, content, all)
    }
    gitContentLoaded.value = true
    gitLoading.value = false
  }

  /** 使某文件的缓存失效(下次 load 会从磁盘重读) */
  function invalidate(filePath: string): void {
    snapshotsByFile.value.delete(filePath)
    gitEntriesByFile.value.delete(filePath)
    gitRootByFile.value.delete(filePath)
    gitContentLoaded.value = true
    gitLoading.value = false
    // 清除该文件对应的 gitContentCache / gitDiffStats 条目
    // (id 格式 git:<hash>:<filePath>,按 filePath 后缀匹配)
    for (const key of [...gitContentCache.value.keys()]) {
      if (key.endsWith(':' + filePath)) gitContentCache.value.delete(key)
    }
    for (const key of [...gitDiffStats.value.keys()]) {
      if (key.endsWith(':' + filePath)) gitDiffStats.value.delete(key)
    }
  }

  /** 仅使某文件的 Git 缓存失效(保留本地快照缓存)。
   *  用于刷新按钮:重新拉取 Git 历史,不影响本地快照列表。 */
  function invalidateGit(filePath: string): void {
    gitEntriesByFile.value.delete(filePath)
    gitRootByFile.value.delete(filePath)
    gitContentLoaded.value = true
    gitLoading.value = false
    for (const key of [...gitContentCache.value.keys()]) {
      if (key.endsWith(':' + filePath)) gitContentCache.value.delete(key)
    }
    for (const key of [...gitDiffStats.value.keys()]) {
      if (key.endsWith(':' + filePath)) gitDiffStats.value.delete(key)
    }
  }

  /** 保存后追加快照到内存缓存(若已加载)。
   *
   * saveDoc 写盘 + saveVersionSnapshot + pruneVersionSnapshots 之后调,
   * 把新快照 prepend 到缓存列表(保持倒序)并按 CAP + 过期天数修剪,使 UI 即时刷新。
   * 缓存未加载(null)时跳过 —— 下次打开 VersionHistoryPanel 时 loadSnapshots 从磁盘读。 */
  function appendSnapshot(filePath: string, snapshot: VersionSnapshot): void {
    const cached = snapshotsByFile.value.get(filePath)
    if (!cached) return
    const now = Date.now()
    const cutoff = now - VERSION_SNAPSHOT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    const next = [snapshot, ...cached]
      .filter(s => s.savedAt >= cutoff)
      .slice(0, VERSION_SNAPSHOT_CAP)
    snapshotsByFile.value.set(filePath, next)
  }

  /** 使所有缓存失效 */
  function invalidateAll(): void {
    snapshotsByFile.value.clear()
    gitEntriesByFile.value.clear()
    gitRootByFile.value.clear()
    gitContentCache.value.clear()
    gitDiffStats.value.clear()
    gitContentLoaded.value = true
    gitLoading.value = false
  }

  /** 打开版本历史:加载当前文件快照 + Git 历史 + 选中最新一条 + 激活 diff 视图 */
  async function openVersionHistory(): Promise<void> {
    const path = documentStore.currentFilePath
    if (!path) return
    const snapshots = await loadCurrentFileSnapshots()
    // 并行加载 Git 历史
    await loadGitHistory(path)
    // dirty 时默认选中未保存条目,否则选最新条目
    if (documentStore.dirty) {
      selectedEntryId.value = UNSAVED_ID
      diffViewActive.value = true
    } else if (snapshots.length > 0) {
      selectedEntryId.value = snapshots[0].id
      diffViewActive.value = true
    } else {
      // 无本地快照,但有 Git 历史时选最新 Git 条目
      const gitEntries = gitEntriesByFile.value.get(path)
      if (gitEntries && gitEntries.length > 0) {
        selectedEntryId.value = gitEntryId(gitEntries[0].hash, path)
        diffViewActive.value = true
      } else {
        selectedEntryId.value = null
        diffViewActive.value = false
      }
    }
  }

  /** 关闭 diff 视图(回到编辑器) */
  function closeDiffView(): void {
    diffViewActive.value = false
    selectedEntryId.value = null
  }

  /** 选中某条目并激活 diff 视图(点击侧栏列表项时调) */
  function selectEntry(id: string): void {
    selectedEntryId.value = id
    diffViewActive.value = true
  }

  return {
    snapshotsByFile,
    gitEntriesByFile,
    gitRootByFile,
    gitContentCache,
    gitDiffStats,
    diffViewActive,
    selectedEntryId,
    includeGit,
    currentFileSnapshots,
    currentFileGitEntries,
    currentFileGitRoot,
    unsavedEntry,
    allEntries,
    displayEntries,
    selectedEntry,
    diffOldContent,
    diffOldContentAsync,
    gitContentLoaded,
    gitLoading,
    loadGitContent,
    VERSION_SNAPSHOT_CAP,
    UNSAVED_ID,
    GIT_PREFIX,
    loadSnapshots,
    loadCurrentFileSnapshots,
    loadGitHistory,
    appendSnapshot,
    invalidate,
    invalidateGit,
    invalidateAll,
    openVersionHistory,
    closeDiffView,
    selectEntry,
  }
})
