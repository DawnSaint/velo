import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { exists, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { useRecentFilesStore } from '../recentFiles'
import { saveRecentFilesPatch } from '../persistence'

describe('recentFiles store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
  })

  it('push 只收 markdown,置顶并去重', async () => {
    const store = useRecentFilesStore()

    store.push('/a.md')
    await new Promise(resolve => setTimeout(resolve, 0))
    store.push('/b.txt')
    await new Promise(resolve => setTimeout(resolve, 0))
    store.push('/a.md')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(store.entries.map(e => e.path)).toEqual(['/a.md'])
  })

  it('loadFrom 归一化排序并按较新的 openedAt 去重', () => {
    const store = useRecentFilesStore()
    store.loadFrom({
      version: 1,
      entries: [
        { path: '/a.md', openedAt: 1 },
        { path: '/b.md', openedAt: 3 },
        { path: '/a.md', openedAt: 5 },
        { path: '', openedAt: 9 },
        { path: '/bad.md', openedAt: Number.NaN },
      ],
    })

    expect(store.entries).toEqual([
      { path: '/a.md', openedAt: 5 },
      { path: '/b.md', openedAt: 3 },
    ])
  })

  it('renamePathPrefix 只重写精确路径或子路径,不误伤相邻前缀', () => {
    const store = useRecentFilesStore()
    store.loadFrom({
      version: 1,
      entries: [
        { path: '/root/old/a.md', openedAt: 3 },
        { path: '/root/old.md', openedAt: 2 },
        { path: '/root/oldish/a.md', openedAt: 1 },
      ],
    })

    store.renamePathPrefix('/root/old', '/root/new')

    expect(store.entries.map(e => e.path)).toEqual([
      '/root/new/a.md',
      '/root/old.md',
      '/root/oldish/a.md',
    ])
  })

  it('removePathPrefix 删除精确路径或目录子路径', () => {
    const store = useRecentFilesStore()
    store.loadFrom({
      version: 1,
      entries: [
        { path: '/root/dir/a.md', openedAt: 3 },
        { path: '/root/dir.md', openedAt: 2 },
        { path: '/root/dir2/a.md', openedAt: 1 },
      ],
    })

    store.removePathPrefix('/root/dir')

    expect(store.entries.map(e => e.path)).toEqual(['/root/dir.md', '/root/dir2/a.md'])
  })
})

describe('recentFiles persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('saveRecentFilesPatch merge 磁盘已有项与本次 upsert', async () => {
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify({
      version: 1,
      entries: [{ path: '/old.md', openedAt: 1 }],
    }))
    vi.mocked(writeTextFile).mockResolvedValue()

    await saveRecentFilesPatch({ upserts: [{ path: '/new.md', openedAt: 2 }] })

    const [, body] = vi.mocked(writeTextFile).mock.calls.at(-1)!
    const saved = JSON.parse(String(body))
    expect(saved.entries).toEqual([
      { path: '/new.md', openedAt: 2 },
      { path: '/old.md', openedAt: 1 },
    ])
  })

  it('saveRecentFilesPatch 保留重复路径中较新的 openedAt', async () => {
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify({
      version: 1,
      entries: [{ path: '/same.md', openedAt: 1 }],
    }))
    vi.mocked(writeTextFile).mockResolvedValue()

    await saveRecentFilesPatch({ upserts: [{ path: '/same.md', openedAt: 5 }] })

    const [, body] = vi.mocked(writeTextFile).mock.calls.at(-1)!
    const saved = JSON.parse(String(body))
    expect(saved.entries).toEqual([{ path: '/same.md', openedAt: 5 }])
  })
})
