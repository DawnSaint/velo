import { buildPattern, replaceInText, type FindOptions } from '@/components/ProseMirrorEditor/findreplace/findMatches'
import type { FindReplaceBackend } from '@/components/ProseMirrorEditor/findreplace/backend'
import { isMarkdownPath } from '@/utils/markdownPath'
import { readDir, readTextFile, writeTextFile, tauriOnly } from '@/tauri/fs'
import { join } from '@/tauri/path'

export type WorkspaceSearchPhase = 'idle' | 'scanning' | 'searching' | 'done' | 'canceled' | 'error'

export interface WorkspaceSearchProgress {
  phase: WorkspaceSearchPhase
  dirsScanned: number
  filesFound: number
  filesSearched: number
  hits: number
  error?: string
}

export interface WorkspaceSearchFileEntry {
  fullPath: string
  name: string
  relPath: string
}

export interface WorkspaceSearchHit {
  id: string
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
  query: string
  options: FindOptions
}

export interface WorkspaceSearchGroup {
  file: WorkspaceSearchFileEntry
  hits: WorkspaceSearchHit[]
}

export interface WorkspaceSearchResult {
  groups: WorkspaceSearchGroup[]
  progress: WorkspaceSearchProgress
}

export interface WorkspaceSearchCallbacks {
  onProgress?: (progress: WorkspaceSearchProgress) => void
  onGroups?: (groups: WorkspaceSearchGroup[]) => void
}

export interface WorkspaceSearchController {
  cancel(): void
  readonly canceled: boolean
}

export const initialWorkspaceSearchProgress = (): WorkspaceSearchProgress => ({
  phase: 'idle',
  dirsScanned: 0,
  filesFound: 0,
  filesSearched: 0,
  hits: 0,
})

function normalizeSep(s: string): string {
  return s.replace(/\\/g, '/')
}

function cloneOptions(options: FindOptions): FindOptions {
  return {
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
    regex: options.regex,
  }
}

function splitRel(rel: string): { name: string, dir: string } {
  const i = rel.lastIndexOf('/')
  if (i === -1) return { name: rel, dir: '' }
  return { name: rel.slice(i + 1), dir: rel.slice(0, i + 1) }
}

async function makeEntry(root: string, dir: string, name: string): Promise<WorkspaceSearchFileEntry | null> {
  try {
    const fullPath = await join(dir, name)
    let rel = fullPath.startsWith(root) ? fullPath.slice(root.length) : fullPath
    if (rel.startsWith('/') || rel.startsWith('\\')) rel = rel.slice(1)
    const relPath = normalizeSep(rel)
    return { fullPath, name: splitRel(relPath).name, relPath }
  }
  catch {
    return null
  }
}

function setProgress(
  progress: WorkspaceSearchProgress,
  patch: Partial<WorkspaceSearchProgress>,
  callbacks: WorkspaceSearchCallbacks,
): void {
  Object.assign(progress, patch)
  callbacks.onProgress?.({ ...progress })
}

function fileGroupsFrom(groupsByPath: Map<string, WorkspaceSearchGroup>): WorkspaceSearchGroup[] {
  return Array.from(groupsByPath.values())
}

async function scanMarkdownFiles(
  scopeDir: string,
  controller: WorkspaceSearchController,
  progress: WorkspaceSearchProgress,
  callbacks: WorkspaceSearchCallbacks,
): Promise<WorkspaceSearchFileEntry[]> {
  const files: WorkspaceSearchFileEntry[] = []
  const queue: string[] = [scopeDir]
  setProgress(progress, { phase: 'scanning' }, callbacks)

  while (queue.length && !controller.canceled) {
    const dir = queue.shift()!
    let entries
    try {
      entries = await readDir(dir)
    }
    catch {
      setProgress(progress, { dirsScanned: progress.dirsScanned + 1 }, callbacks)
      continue
    }
    if (controller.canceled) break

    for (const e of entries) {
      if (controller.canceled) break
      if (!e.name) continue
      if (e.isDirectory) {
        if (e.name.startsWith('.')) continue
        try { queue.push(await join(dir, e.name)) }
        catch { /* join 极少失败,静默 */ }
      }
      else if (isMarkdownPath(e.name)) {
        const entry = await makeEntry(scopeDir, dir, e.name)
        if (!entry) continue
        files.push(entry)
        setProgress(progress, { filesFound: files.length }, callbacks)
      }
    }
    setProgress(progress, { dirsScanned: progress.dirsScanned + 1 }, callbacks)
  }

  return files
}

function searchFileContent(
  entry: WorkspaceSearchFileEntry,
  content: string,
  query: string,
  options: FindOptions,
): WorkspaceSearchHit[] {
  const pat = buildPattern(query, options)
  if (!pat) return []
  const hits: Omit<WorkspaceSearchHit, 'fileMatchCount'>[] = []
  let lineNumber = 1
  let lineStart = 0
  let matchOrdinal = 0

  for (let i = 0; i <= content.length; i++) {
    const isEnd = i === content.length
    const ch = content[i]
    if (!isEnd && ch !== '\n') continue

    const rawLineEnd = i
    const displayLineEnd = rawLineEnd > lineStart && content[rawLineEnd - 1] === '\r'
      ? rawLineEnd - 1
      : rawLineEnd
    const lineText = content.slice(lineStart, displayLineEnd)
    pat.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pat.exec(lineText)) !== null) {
      if (m[0].length === 0) {
        pat.lastIndex++
        continue
      }
      hits.push({
        id: `${entry.fullPath}:${lineNumber}:${m.index}:${matchOrdinal}`,
        fullPath: entry.fullPath,
        relPath: entry.relPath,
        fileName: entry.name,
        lineNumber,
        lineText,
        matchStartInLine: m.index,
        matchEndInLine: m.index + m[0].length,
        rawFrom: lineStart + m.index,
        rawTo: lineStart + m.index + m[0].length,
        matchText: m[0],
        matchOrdinal,
        query,
        options: cloneOptions(options),
      })
      matchOrdinal++
    }

    lineNumber++
    lineStart = i + 1
  }

  const fileMatchCount = hits.length
  return hits.map(hit => ({ ...hit, fileMatchCount }))
}

export function createWorkspaceSearchController(): WorkspaceSearchController {
  let isCanceled = false
  return {
    cancel() { isCanceled = true },
    get canceled() { return isCanceled },
  }
}

export function isWorkspaceSearchRegexValid(query: string, options: FindOptions): boolean {
  if (!query) return true
  return buildPattern(query, options) !== null
}

export async function searchWorkspaceMarkdown(
  root: string,
  query: string,
  options: FindOptions,
  controller: WorkspaceSearchController = createWorkspaceSearchController(),
  callbacks: WorkspaceSearchCallbacks = {},
  scopeDir: string | null = null,
): Promise<WorkspaceSearchResult> {
  const progress = initialWorkspaceSearchProgress()
  const trimmedQuery = query
  callbacks.onProgress?.({ ...progress })

  if (!trimmedQuery) {
    return { groups: [], progress }
  }
  if (!tauriOnly()) {
    setProgress(progress, { phase: 'error', error: '全文搜索需要 Tauri 文件系统权限' }, callbacks)
    return { groups: [], progress }
  }
  if (!buildPattern(trimmedQuery, options)) {
    setProgress(progress, { phase: 'error', error: '正则表达式无效' }, callbacks)
    return { groups: [], progress }
  }

  const startDir = scopeDir ?? root
  const files = await scanMarkdownFiles(startDir, controller, progress, callbacks)
  if (controller.canceled) {
    setProgress(progress, { phase: 'canceled' }, callbacks)
    return { groups: [], progress }
  }

  const groupsByPath = new Map<string, WorkspaceSearchGroup>()
  setProgress(progress, { phase: 'searching' }, callbacks)
  callbacks.onGroups?.([])

  for (const file of files) {
    if (controller.canceled) break
    let content: string
    try {
      content = await readTextFile(file.fullPath)
    }
    catch {
      setProgress(progress, { filesSearched: progress.filesSearched + 1 }, callbacks)
      continue
    }
    if (controller.canceled) break

    const hits = searchFileContent(file, content, trimmedQuery, options)
    if (hits.length) {
      groupsByPath.set(file.fullPath, { file, hits })
      callbacks.onGroups?.(fileGroupsFrom(groupsByPath))
    }
    setProgress(progress, {
      filesSearched: progress.filesSearched + 1,
      hits: progress.hits + hits.length,
    }, callbacks)
  }

  setProgress(progress, { phase: controller.canceled ? 'canceled' : 'done' }, callbacks)
  const groups = fileGroupsFrom(groupsByPath)
  callbacks.onGroups?.(groups)
  return { groups, progress }
}

export function revealWorkspaceSearchMatch(
  backend: FindReplaceBackend | null,
  from: number,
  to: number,
): boolean {
  if (!backend) return false
  backend.focus()
  backend.setSelection(from, to)
  backend.clearHighlight()
  backend.scrollMatchIntoView(from)
  return true
}

// ============ 工作区全文替换 (v0.6.0) ============
//
// 把 WorkspaceSearchHit 列表按 fullPath 聚合去重,对每个文件 readTextFile +
// replaceInText(replaceInText 已经走 buildPattern 的 caseSensitive / wholeWord / regex
// 语义,与搜索构建的正则保持一致,regex 模式下保留 $1/$2 反向引用)。命中数差值
// 用 content 旧 / 新两边各跑一次 buildPattern 比对:实现简单且和搜索阶段的命中
// 计数规则一致。
//
// dirty tab 一律跳过:替换读取的是磁盘基线,直接覆盖会毁掉用户在编辑器里的
// 未保存修改。dirty 集合由调用方(App.vue)在替换开始的瞬间 snapshot,遍历中
// 不重读,避免"开始前是 clean、跑到一半用户敲了键变成 dirty"的 race ——
// 用户后续 Ctrl+S 后,新搜索会重新命中,可以再触发替换。
//
// 文件 IO 错误(readTextFile 抛错 / writeTextFile 抛错)写入 failedFiles,
// 不抛给调用方,让 App.vue 一次性收集所有结果给用户看。

export interface ReplacePlan {
  query: string
  options: FindOptions
  replacement: string
}

export interface ReplaceFailure {
  fullPath: string
  reason: string
}

export interface ReplaceResult {
  /** 写入成功的文件 fullPath(内容相对磁盘基线确实发生了变化) */
  changedFiles: string[]
  /** 跨所有 changedFiles 的命中替换总数 */
  replacedCount: number
  /** 因 dirty 被跳过的 fullPath —— 调用方应提示用户先保存 */
  skippedFiles: string[]
  /** 读 / 写失败的 fullPath + 错误信息 */
  failedFiles: ReplaceFailure[]
  /** 写入文件的新内容(fullPath → 内容),让 App.vue 同步已打开 tab 时免一次 readTextFile */
  fileContents: Map<string, string>
}

function countMatches(content: string, pat: RegExp): number {
  pat.lastIndex = 0
  let n = 0
  let m: RegExpExecArray | null
  while ((m = pat.exec(content)) !== null) {
    if (m[0].length === 0) {
      pat.lastIndex++
      continue
    }
    n++
  }
  return n
}

export async function applyWorkspaceReplace(
  hits: WorkspaceSearchHit[],
  plan: ReplacePlan,
  dirtyPaths: ReadonlySet<string>,
): Promise<ReplaceResult> {
  const result: ReplaceResult = {
    changedFiles: [],
    replacedCount: 0,
    skippedFiles: [],
    failedFiles: [],
    fileContents: new Map(),
  }

  if (!hits.length) return result
  if (!tauriOnly()) {
    // 无 Tauri 环境无法落盘 —— 把所有受影响文件记为失败,调用方按错误处理
    const seen = new Set<string>()
    for (const h of hits) {
      if (!seen.has(h.fullPath)) {
        seen.add(h.fullPath)
        result.failedFiles.push({ fullPath: h.fullPath, reason: '替换需要 Tauri 文件系统权限' })
      }
    }
    return result
  }

  const pat = buildPattern(plan.query, plan.options)
  if (!pat) {
    const seen = new Set<string>()
    for (const h of hits) {
      if (!seen.has(h.fullPath)) {
        seen.add(h.fullPath)
        result.failedFiles.push({ fullPath: h.fullPath, reason: '正则表达式无效' })
      }
    }
    return result
  }

  // 按 fullPath 去重,保留首次出现的 relPath(用于失败原因提示)
  const uniquePaths = new Set<string>()
  const pathRelMap = new Map<string, string>()
  for (const h of hits) {
    if (!uniquePaths.has(h.fullPath)) {
      uniquePaths.add(h.fullPath)
      pathRelMap.set(h.fullPath, h.relPath)
    }
  }

  for (const fullPath of uniquePaths) {
    if (dirtyPaths.has(fullPath)) {
      result.skippedFiles.push(fullPath)
      continue
    }
    let content: string
    try {
      content = await readTextFile(fullPath)
    }
    catch (e) {
      result.failedFiles.push({
        fullPath,
        reason: e instanceof Error ? e.message : String(e),
      })
      continue
    }

    const newContent = replaceInText(content, plan.query, plan.options, plan.replacement)
    if (newContent === content) {
      // 没有匹配可替换 —— 罕见但可能(命中行被外部改动移走)
      continue
    }

    try {
      await writeTextFile(fullPath, newContent)
    }
    catch (e) {
      result.failedFiles.push({
        fullPath,
        reason: e instanceof Error ? e.message : String(e),
      })
      continue
    }

    const replacedInFile = countMatches(content, pat) - countMatches(newContent, pat)
    result.changedFiles.push(fullPath)
    result.fileContents.set(fullPath, newContent)
    result.replacedCount += Math.max(replacedInFile, 0)
  }

  return result
}

export const __workspaceSearchTest = {
  searchFileContent,
  normalizeSep,
  countMatches,
}
