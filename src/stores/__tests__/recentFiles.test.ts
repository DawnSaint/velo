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

  it('removePaths 精确删除多条失效记录,不误伤同名前缀文件', async () => {
    const store = useRecentFilesStore()
    store.loadFrom({
      version: 1,
      entries: [
        { path: '/root/gone.md', openedAt: 5 },
        { path: '/root/gone.md.bak', openedAt: 4 },
        { path: '/root/also-gone.md', openedAt: 3 },
        { path: '/root/keep.md', openedAt: 2 },
      ],
    })

    store.removePaths(['/root/gone.md', '/root/also-gone.md'])
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(store.entries.map(e => e.path)).toEqual(['/root/gone.md.bak', '/root/keep.md'])
  })

  it('removePaths 传未记录的路径 → no-op,不写盘', async () => {
    const writeSpy = vi.mocked(writeTextFile)
    writeSpy.mockClear()
    const store = useRecentFilesStore()
    store.loadFrom({ version: 1, entries: [{ path: '/a.md', openedAt: 1 }] })

    store.removePaths(['/never.md'])
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(store.entries.map(e => e.path)).toEqual(['/a.md'])
    expect(writeSpy).not.toHaveBeenCalled()
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

  it('saveRecentFilesPatch deletes 精确删除失效项,不误伤同名前缀记录', async () => {
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify({
      version: 1,
      entries: [
        { path: '/root/gone.md', openedAt: 5 },
        { path: '/root/gone.md.bak', openedAt: 4 },
        { path: '/root/keep.md', openedAt: 3 },
        { path: '/root/gone2.md', openedAt: 2 },
      ],
    }))
    vi.mocked(writeTextFile).mockResolvedValue()

    await saveRecentFilesPatch({ deletes: ['/root/gone.md', '/root/gone2.md'] })

    const [, body] = vi.mocked(writeTextFile).mock.calls.at(-1)!
    const saved = JSON.parse(String(body))
    expect(saved.entries.map((e: { path: string }) => e.path)).toEqual([
      '/root/gone.md.bak',
      '/root/keep.md',
    ])
  })

  it('saveRecentFilesPatch deletes 与 upserts 同 patch:先删后加,新记录不被误删', async () => {
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify({
      version: 1,
      entries: [{ path: '/gone.md', openedAt: 1 }],
    }))
    vi.mocked(writeTextFile).mockResolvedValue()

    await saveRecentFilesPatch({
      deletes: ['/gone.md'],
      upserts: [{ path: '/fresh.md', openedAt: 9 }],
    })

    const [, body] = vi.mocked(writeTextFile).mock.calls.at(-1)!
    const saved = JSON.parse(String(body))
    expect(saved.entries).toEqual([{ path: '/fresh.md', openedAt: 9 }])
  })
})
