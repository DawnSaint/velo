// 工作区遍历/搜索 Tauri 封装层(#rust-search-quickopen-git)
//
// 薄封装 invoke 调用 Rust 端 workspace 命令,与 fs.ts / git.ts 同模式:
// 单一入口 + tauriOnly() 守门。Rust 侧 serde 默认 snake_case,
// 本层负责映射成前端 camelCase 结构(同 git.ts 的 toEntry)。
//
// 失败语义:command 不存在(旧版后端)/ root 无效等一律 throw,
// 由调用方决定降级(quickOpenIndex 回落 JS BFS)。

import { invoke, Channel } from '@tauri-apps/api/core'
import { tauriOnly } from './fs'

/** Rust 端返回的 JSON 结构(snake_case) */
interface WorkspaceFileEntryRaw {
  full_path: string
  name: string
  rel_path: string
}

/** 前端条目结构 —— 与 quickOpenIndex.QuickOpenEntry 字段一致 */
export interface WorkspaceFileEntry {
  fullPath: string
  name: string
  relPath: string
}

/**
 * 单 command 收集工作区根下全部 Markdown 文件(walkdir,隐藏目录跳过)。
 * 非 Tauri 环境 / command 失败时 throw,调用方自行降级。
 */
export async function scanWorkspaceFiles(root: string): Promise<WorkspaceFileEntry[]> {
  if (!tauriOnly()) throw new Error('scan_workspace_files 需要 Tauri 运行时')
  const raw = await invoke<WorkspaceFileEntryRaw[]>('scan_workspace_files', { root })
  if (!Array.isArray(raw)) throw new Error('scan_workspace_files 返回结构异常')
  return raw.map(e => ({ fullPath: e.full_path, name: e.name, relPath: e.rel_path }))
}

// ============ Phase 2:全文搜索 / 替换 ============

/** 与 Rust SearchOptions 对齐(camelCase) */
export interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

/** Rust SearchHit(camelCase)—— 不含 id/query/options,由前端回填 */
export interface SearchHitRaw {
  fullPath: string
  relPath: string
  fileName: string
  lineNumber: number
  lineText: string
  matchStartInLine: number
  matchEndInLine: number
  rawFrom: number
  rawTo: number
  matchText: string
  matchOrdinal: number
  fileMatchCount: number
}

/** Channel 流式事件(归一后的 camelCase,与 Rust SearchEvent 的 kind tag 对齐) */
export type SearchEvent =
  | { kind: 'scanned', filesFound: number }
  | { kind: 'file', file: WorkspaceFileEntry, hits: SearchHitRaw[], filesSearched: number, hitsTotal: number }
  | { kind: 'progress', filesSearched: number, hitsTotal: number }
  | { kind: 'done', canceled: boolean, filesSearched: number, hitsTotal: number }

/**
 * Channel 线上原始事件。Rust `WorkspaceFileEntry` 是默认 snake_case 序列化
 * (full_path / rel_path),而 `SearchHit` 带 rename_all = "camelCase" ——
 * 嵌套 file 字段不会随外层事件的 camelCase 一起改名,必须在本层归一,
 * 否则面板 group.file.relPath 为 undefined → 文件分组标题空白。
 */
interface SearchEventRaw {
  kind: string
  filesFound?: number
  files_found?: number
  file?: { full_path?: string, fullPath?: string, name?: string, rel_path?: string, relPath?: string }
  hits?: SearchHitRaw[]
  filesSearched?: number
  files_searched?: number
  hitsTotal?: number
  hits_total?: number
  canceled?: boolean
}

/** 线上事件 → 前端 camelCase 事件。两种命名都兼容(防御旧/新后端混跑)。 */
function normalizeSearchEvent(raw: SearchEventRaw): SearchEvent {
  const filesSearched = raw.filesSearched ?? raw.files_searched ?? 0
  const hitsTotal = raw.hitsTotal ?? raw.hits_total ?? 0
  switch (raw.kind) {
    case 'scanned':
      return { kind: 'scanned', filesFound: raw.filesFound ?? raw.files_found ?? 0 }
    case 'file': {
      const f = raw.file ?? {}
      return {
        kind: 'file',
        file: {
          fullPath: f.fullPath ?? f.full_path ?? '',
          name: f.name ?? '',
          relPath: f.relPath ?? f.rel_path ?? '',
        },
        hits: raw.hits ?? [],
        filesSearched,
        hitsTotal,
      }
    }
    case 'progress':
      return { kind: 'progress', filesSearched, hitsTotal }
    case 'done':
      return { kind: 'done', canceled: raw.canceled ?? false, filesSearched, hitsTotal }
    default:
      // 未知事件按轻量进度处理,不破坏流式渲染
      return { kind: 'progress', filesSearched, hitsTotal }
  }
}

/**
 * 流式全文搜索。命中按文件分批经 Channel 回传,onEvent 逐事件回调。
 * resolve 表示 command 结束(正常 / 取消);reject 表示 Rust 侧错误
 * (正则方言不支持 / root 无效等),调用方据此降级回 JS 引擎。
 *
 * searchId 由调用方生成(与前端 runId 同源),cancel 时传给
 * cancelWorkspaceSearch 置位 Rust AtomicBool。
 */
export async function searchWorkspaceRust(params: {
  root: string
  scopeDir: string | null
  query: string
  options: SearchOptions
  searchId: number
  onEvent: (event: SearchEvent) => void
}): Promise<void> {
  if (!tauriOnly()) throw new Error('search_workspace 需要 Tauri 运行时')
  const channel = new Channel<SearchEventRaw>()
  channel.onmessage = raw => params.onEvent(normalizeSearchEvent(raw))
  await invoke('search_workspace', {
    root: params.root,
    scopeDir: params.scopeDir,
    query: params.query,
    options: params.options,
    searchId: params.searchId,
    channel,
  })
}

/** 置位某次搜索的取消令牌。未知 id 静默 no-op。 */
export async function cancelWorkspaceSearch(searchId: number): Promise<void> {
  if (!tauriOnly()) return
  try {
    await invoke('cancel_workspace_search', { searchId })
  }
  catch { /* 取消失败不影响前端 —— controller 本地 canceled 仍生效 */ }
}

/** 与 Rust ReplacePlan 对齐 */
export interface ReplacePlanRaw {
  query: string
  options: SearchOptions
  replacement: string
}

/** 与 Rust ReplaceOutcome 对齐(fileContents 是对象,前端转 Map) */
export interface ReplaceOutcomeRaw {
  changedFiles: string[]
  replacedCount: number
  skippedFiles: string[]
  failedFiles: { fullPath: string, reason: string }[]
  fileContents: Record<string, string>
}

/**
 * 全文替换。dirtyPaths 为前端替换瞬间 snapshot 的脏 tab 集合。
 * Rust 侧跳过 dirty、逐文件错误收集,返回结构与前端 ReplaceResult 对齐。
 */
export async function replaceWorkspaceRust(
  paths: string[],
  plan: ReplacePlanRaw,
  dirtyPaths: string[],
): Promise<ReplaceOutcomeRaw> {
  if (!tauriOnly()) throw new Error('replace_workspace 需要 Tauri 运行时')
  return invoke<ReplaceOutcomeRaw>('replace_workspace', { paths, plan, dirtyPaths })
}
