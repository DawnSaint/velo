import { defineStore } from 'pinia'
import { ref } from 'vue'
import { isMarkdownPath } from '@/utils/markdownPath'
import {
  loadRecentFiles,
  saveRecentFilesPatch,
  RECENT_FILES_CAP,
  type PersistedRecentFiles,
  type RecentFileEntry,
} from './persistence'

function normalizeEntries(entries: RecentFileEntry[]): RecentFileEntry[] {
  const byPath = new Map<string, RecentFileEntry>()
  for (const entry of entries) {
    if (!entry.path || !Number.isFinite(entry.openedAt)) continue
    const prev = byPath.get(entry.path)
    if (!prev || entry.openedAt > prev.openedAt) byPath.set(entry.path, { ...entry })
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

export const useRecentFilesStore = defineStore('recentFiles', () => {
  const entries = ref<RecentFileEntry[]>([])

  function loadFrom(data: PersistedRecentFiles | null) {
    entries.value = normalizeEntries(data?.entries ?? [])
  }

  async function hydrate() {
    loadFrom(await loadRecentFiles())
  }

  function snapshot(): PersistedRecentFiles {
    return {
      version: 1,
      entries: normalizeEntries(entries.value),
    }
  }

  function setEntries(next: RecentFileEntry[]) {
    entries.value = normalizeEntries(next)
  }

  function push(path: string) {
    if (!isMarkdownPath(path)) return
    const entry = { path, openedAt: Date.now() }
    setEntries([entry, ...entries.value])
    void saveRecentFilesPatch({ upserts: [entry] })
  }

  function renamePathPrefix(oldPath: string, newPath: string) {
    if (oldPath === newPath) return
    setEntries(entries.value.map(entry => ({
      ...entry,
      path: applyPathPrefix(entry.path, oldPath, newPath),
    })))
    void saveRecentFilesPatch({ renames: [{ oldPath, newPath }] })
  }

  function removePathPrefix(pathPrefix: string) {
    setEntries(entries.value.filter(entry => !hasPathPrefix(entry.path, pathPrefix)))
    void saveRecentFilesPatch({ deletePrefixes: [pathPrefix] })
  }

  return {
    entries,
    hydrate,
    loadFrom,
    snapshot,
    push,
    renamePathPrefix,
    removePathPrefix,
  }
})
