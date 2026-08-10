import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useVersionHistoryStore } from '../versionHistory'
import { useDocumentStore } from '../document'
import { readTextFile, readDir, exists } from '@tauri-apps/plugin-fs'

describe('versionHistory store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
  })

  describe('loadSnapshots', () => {
    it('目录不存在 → 返回空数组', async () => {
      vi.mocked(exists).mockResolvedValue(false)
      const store = useVersionHistoryStore()
      const result = await store.loadSnapshots('/test.md')
      expect(result).toEqual([])
    })

    it('读取快照列表,按 savedAt 倒序', async () => {
      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readDir).mockResolvedValue([
        { name: '1000.json', isDirectory: false, isFile: true, isSymlink: false },
        { name: '3000.json', isDirectory: false, isFile: true, isSymlink: false },
        { name: '2000.json', isDirectory: false, isFile: true, isSymlink: false },
      ] as any)

      const snapshotsJson: Record<string, string> = {
        '1000.json': JSON.stringify({
          version: 1, id: '1000', filePath: '/test.md', content: 'old', savedAt: 1000, trigger: 'manual',
        }),
        '2000.json': JSON.stringify({
          version: 1, id: '2000', filePath: '/test.md', content: 'mid', savedAt: 2000, trigger: 'auto',
        }),
        '3000.json': JSON.stringify({
          version: 1, id: '3000', filePath: '/test.md', content: 'new', savedAt: 3000, trigger: 'blur',
        }),
      }
      vi.mocked(readTextFile).mockImplementation(async (p: any) => {
        const name = String(p).split(/[\\/]/).pop()!
        return snapshotsJson[name] ?? ''
      })

      const store = useVersionHistoryStore()
      const result = await store.loadSnapshots('/test.md')

      expect(result).toHaveLength(3)
      // 倒序:最新在前
      expect(result[0].id).toBe('3000')
      expect(result[1].id).toBe('2000')
      expect(result[2].id).toBe('1000')
    })

    it('跳过损坏的快照文件', async () => {
      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readDir).mockResolvedValue([
        { name: 'good.json', isDirectory: false, isFile: true, isSymlink: false },
        { name: 'bad.json', isDirectory: false, isFile: true, isSymlink: false },
      ] as any)
      vi.mocked(readTextFile).mockImplementation(async (p: any) => {
        const name = String(p).split(/[\\/]/).pop()!
        if (name === 'good.json') {
          return JSON.stringify({
            version: 1, id: 'good', filePath: '/test.md', content: 'ok', savedAt: 1000, trigger: 'manual',
          })
        }
        return '{invalid json'
      })

      const store = useVersionHistoryStore()
      const result = await store.loadSnapshots('/test.md')
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('good')
    })
  })

  describe('deleteSnapshot', () => {
    it('从磁盘删除 + 同步更新缓存', async () => {
      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readDir).mockResolvedValue([
        { name: '1000.json', isDirectory: false, isFile: true, isSymlink: false },
        { name: '2000.json', isDirectory: false, isFile: true, isSymlink: false },
      ] as any)
      vi.mocked(readTextFile).mockImplementation(async (p: any) => {
        const name = String(p).split(/[\\/]/).pop()!
        const ts = name.replace('.json', '')
        return JSON.stringify({
          version: 1, id: ts, filePath: '/test.md', content: `c${ts}`, savedAt: Number(ts), trigger: 'manual',
        })
      })

      const store = useVersionHistoryStore()
      await store.loadSnapshots('/test.md')
      expect(store.currentFileSnapshots).toBeNull() // currentFilePath is null

      // 手动注入缓存
      store.snapshotsByFile.set('/test.md', store.snapshotsByFile.get('/test.md')!)
      expect(store.snapshotsByFile.get('/test.md')).toHaveLength(2)

      await store.deleteSnapshot('/test.md', '1000')

      const cached = store.snapshotsByFile.get('/test.md')!
      expect(cached).toHaveLength(1)
      expect(cached[0].id).toBe('2000')
    })
  })

  describe('diff view flow', () => {
    it('openVersionHistory:无当前文件时不打开', async () => {
      const docStore = useDocumentStore()
      docStore.init('') // currentFilePath = null
      const store = useVersionHistoryStore()
      vi.mocked(exists).mockResolvedValue(false)

      await store.openVersionHistory()
      expect(store.diffViewActive).toBe(false)
    })

    it('openVersionHistory:有快照时打开并选中最新', async () => {
      const docStore = useDocumentStore()
      vi.mocked(readTextFile).mockResolvedValue('hello')
      await docStore.openPath('/test.md')

      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readDir).mockResolvedValue([
        { name: '1000.json', isDirectory: false, isFile: true, isSymlink: false },
        { name: '2000.json', isDirectory: false, isFile: true, isSymlink: false },
      ] as any)
      // readTextFile 用于读快照时要返回快照 JSON,但 openPath 已经读完了
      vi.mocked(readTextFile).mockImplementation(async (p: any) => {
        const name = String(p).split(/[\\/]/).pop()!
        if (name.endsWith('.json')) {
          const ts = name.replace('.json', '')
          return JSON.stringify({
            version: 1, id: ts, filePath: '/test.md', content: `c${ts}`, savedAt: Number(ts), trigger: 'manual',
          })
        }
        return 'hello'
      })

      const store = useVersionHistoryStore()
      await store.openVersionHistory()

      expect(store.diffViewActive).toBe(true)
      expect(store.selectedSnapshotId).toBe('2000') // 最新的
    })

    it('closeDiffView:关闭 diff 视图 + 清选中', async () => {
      const store = useVersionHistoryStore()
      store.diffViewActive = true
      store.selectedSnapshotId = 'abc'
      store.closeDiffView()
      expect(store.diffViewActive).toBe(false)
      expect(store.selectedSnapshotId).toBeNull()
    })

    it('selectSnapshot:设置选中 id 并激活 diff 视图', () => {
      const store = useVersionHistoryStore()
      store.selectSnapshot('xyz')
      expect(store.selectedSnapshotId).toBe('xyz')
      expect(store.diffViewActive).toBe(true)
    })
  })
})
