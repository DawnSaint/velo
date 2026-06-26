import { buildPattern, type FindOptions } from '@/components/ProseMirrorEditor/findreplace/findMatches'
import type { FindReplaceBackend } from '@/components/ProseMirrorEditor/findreplace/backend'
import { isMarkdownPath } from '@/utils/markdownPath'
import { readDir, readTextFile, tauriOnly } from '@/tauri/fs'
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
  root: string,
  controller: WorkspaceSearchController,
  progress: WorkspaceSearchProgress,
  callbacks: WorkspaceSearchCallbacks,
): Promise<WorkspaceSearchFileEntry[]> {
  const files: WorkspaceSearchFileEntry[] = []
  const queue: string[] = [root]
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
        const entry = await makeEntry(root, dir, e.name)
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

  const files = await scanMarkdownFiles(root, controller, progress, callbacks)
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

export const __workspaceSearchTest = {
  searchFileContent,
  normalizeSep,
}
