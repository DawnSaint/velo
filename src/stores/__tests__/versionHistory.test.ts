import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useVersionHistoryStore, UNSAVED_ID } from '../versionHistory'
import { useDocumentStore } from '../document'
import { readTextFile, readDir, exists } from '@tauri-apps/plugin-fs'
import type { VersionSnapshot } from '../persistence'

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

  describe('appendSnapshot', () => {
    it('缓存未加载(null)时跳过', () => {
      const store = useVersionHistoryStore()
      // 不 loadSnapshots,缓存为 null
      store.appendSnapshot('/test.md', {
        version: 1, id: '100', filePath: '/test.md', content: 'x', savedAt: 100, trigger: 'manual',
      })
      expect(store.snapshotsByFile.get('/test.md')).toBeUndefined()
    })

    it('缓存已加载时 prepend 到列表头部', () => {
      const store = useVersionHistoryStore()
      const base = Date.now()
      // 模拟已加载缓存(用接近当前时间的时间戳,避免被过期清理误删)
      store.snapshotsByFile.set('/test.md', [
        { version: 1, id: '200', filePath: '/test.md', content: 'b', savedAt: base - 100, trigger: 'auto' },
      ])
      store.appendSnapshot('/test.md', {
        version: 1, id: '300', filePath: '/test.md', content: 'c', savedAt: base, trigger: 'manual',
      })
      const cached = store.snapshotsByFile.get('/test.md')!
      expect(cached).toHaveLength(2)
      expect(cached[0].id).toBe('300') // 新快照在前
      expect(cached[1].id).toBe('200')
    })

    it('超出 CAP 时修剪旧快照', () => {
      const store = useVersionHistoryStore()
      const cap = store.VERSION_SNAPSHOT_CAP
      // 用接近当前时间的时间戳,避免被过期清理误删
      const base = Date.now()
      const existing = Array.from({ length: cap }, (_, i) => ({
        version: 1, id: String(cap - i), filePath: '/test.md', content: `c${i}`, savedAt: base - (cap - i), trigger: 'manual' as const,
      }))
      store.snapshotsByFile.set('/test.md', existing)
      store.appendSnapshot('/test.md', {
        version: 1, id: 'new', filePath: '/test.md', content: 'new', savedAt: base, trigger: 'manual',
      })
      const cached = store.snapshotsByFile.get('/test.md')!
      expect(cached).toHaveLength(cap)
      expect(cached[0].id).toBe('new') // 新快照在前
      expect(cached[1].id).toBe(String(cap)) // 原来的第一个(最新的)
      expect(cached[cap - 1].id).toBe('2') // 最旧的被修剪掉(id='1')
    })

    it('超过 30 天的快照被过期清理', () => {
      const store = useVersionHistoryStore()
      const now = Date.now()
      const msPerDay = 24 * 60 * 60 * 1000
      // 一个 10 天前的旧快照 + 一个 40 天前的过旧快照
      store.snapshotsByFile.set('/test.md', [
        { version: 1, id: 'old10d', filePath: '/test.md', content: 'a', savedAt: now - 10 * msPerDay, trigger: 'manual' },
        { version: 1, id: 'old40d', filePath: '/test.md', content: 'b', savedAt: now - 40 * msPerDay, trigger: 'manual' },
      ])
      store.appendSnapshot('/test.md', {
        version: 1, id: 'new', filePath: '/test.md', content: 'c', savedAt: now, trigger: 'manual',
      })
      const cached = store.snapshotsByFile.get('/test.md')!
      // 40 天前的被删,10 天前的保留
      expect(cached).toHaveLength(2)
      expect(cached[0].id).toBe('new')
      expect(cached[1].id).toBe('old10d')
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

  describe('未保存虚拟条目', () => {
    it('dirty 时 displaySnapshots 头部插入未保存条目', async () => {
      const docStore = useDocumentStore()
      vi.mocked(readTextFile).mockResolvedValue('hello')
      await docStore.openPath('/test.md')
      // 制造 dirty
      docStore.setContent('hello modified')

      vi.mocked(exists).mockResolvedValue(false)
      const store = useVersionHistoryStore()
      await store.loadSnapshots('/test.md') // 空快照列表

      const display = store.displaySnapshots!
      expect(display).toHaveLength(1)
      expect(display[0].id).toBe(UNSAVED_ID)
      expect(display[0].content).toBe('hello modified')
    })

    it('非 dirty 时 displaySnapshots 不含未保存条目', async () => {
      const docStore = useDocumentStore()
      vi.mocked(readTextFile).mockResolvedValue('hello')
      await docStore.openPath('/test.md')

      vi.mocked(exists).mockResolvedValue(false)
      const store = useVersionHistoryStore()
      await store.loadSnapshots('/test.md')

      // 非 dirty → displaySnapshots === currentFileSnapshots(空数组)
      expect(store.displaySnapshots).toEqual([])
      expect(store.unsavedSnapshot).toBeNull()
    })

    it('dirty + 有已保存快照时 displaySnapshots = [未保存, ...快照]', async () => {
      const docStore = useDocumentStore()
      vi.mocked(readTextFile).mockResolvedValue('hello')
      await docStore.openPath('/test.md')
      docStore.setContent('hello modified')

      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readDir).mockResolvedValue([
        { name: '1000.json', isDirectory: false, isFile: true, isSymlink: false },
      ] as any)
      vi.mocked(readTextFile).mockImplementation(async (p: any) => {
        const name = String(p).split(/[\\/]/).pop()!
        if (name.endsWith('.json')) {
          return JSON.stringify({
            version: 1, id: '1000', filePath: '/test.md', content: 'hello', savedAt: 1000, trigger: 'manual',
          })
        }
        return 'hello'
      })

      const store = useVersionHistoryStore()
      await store.loadSnapshots('/test.md')

      const display = store.displaySnapshots!
      expect(display).toHaveLength(2)
      expect(display[0].id).toBe(UNSAVED_ID)
      expect(display[1].id).toBe('1000')
    })

    it('openVersionHistory: dirty 时默认选中未保存条目', async () => {
      const docStore = useDocumentStore()
      vi.mocked(readTextFile).mockResolvedValue('hello')
      await docStore.openPath('/test.md')
      docStore.setContent('hello modified')

      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readDir).mockResolvedValue([
        { name: '1000.json', isDirectory: false, isFile: true, isSymlink: false },
      ] as any)
      vi.mocked(readTextFile).mockImplementation(async (p: any) => {
        const name = String(p).split(/[\\/]/).pop()!
        if (name.endsWith('.json')) {
          return JSON.stringify({
            version: 1, id: '1000', filePath: '/test.md', content: 'hello', savedAt: 1000, trigger: 'manual',
          })
        }
        return 'hello'
      })

      const store = useVersionHistoryStore()
      await store.openVersionHistory()

      expect(store.diffViewActive).toBe(true)
      expect(store.selectedSnapshotId).toBe(UNSAVED_ID)
      // selectedSnapshot 返回虚拟条目
      expect(store.selectedSnapshot?.id).toBe(UNSAVED_ID)
      expect(store.selectedSnapshot?.content).toBe('hello modified')
    })

    it('选中未保存条目后保存 → dirty 消失 → 未保存条目从列表消失', async () => {
      const docStore = useDocumentStore()
      vi.mocked(readTextFile).mockResolvedValue('hello')
      await docStore.openPath('/test.md')
      docStore.setContent('hello modified')

      vi.mocked(exists).mockResolvedValue(false)
      const store = useVersionHistoryStore()
      await store.loadSnapshots('/test.md')

      // dirty → 有未保存条目
      expect(store.displaySnapshots).toHaveLength(1)
      expect(store.displaySnapshots![0].id).toBe(UNSAVED_ID)

      // 模拟保存:content === lastSavedContent → dirty = false
      docStore.setContent('hello modified')
      // 直接操作 doc 的 lastSavedContent 模拟保存后基线推进
      const d = (docStore as any).documents.get(docStore.activeId)
      d.lastSavedContent = 'hello modified'

      // 非 dirty → 未保存条目消失
      expect(store.displaySnapshots).toEqual([])
    })
  })

  describe('diffOldContent', () => {
    /** 工具:把快照列表直接塞进缓存,跳过 loadSnapshots 的 IO */
    function setupSnapshots(snaps: VersionSnapshot[]) {
      const store = useVersionHistoryStore()
      store.snapshotsByFile.set('/test.md', snaps)
      return store
    }

    it('未保存条目 → 返回最新已保存快照 content', () => {
      const docStore = useDocumentStore()
      docStore.init('')
      docStore.loadContent('cur', '/test.md')
      docStore.setContent('cur modified') // dirty → 有未保存条目

      const store = setupSnapshots([
        { version: 1, id: '3000', filePath: '/test.md', content: 'v3', savedAt: 3000, trigger: 'manual' },
        { version: 1, id: '2000', filePath: '/test.md', content: 'v2', savedAt: 2000, trigger: 'manual' },
      ])

      // 未保存条目的前一版本 = 最新快照(id=3000,content='v3')
      expect(store.diffOldContent(UNSAVED_ID)).toBe('v3')
    })

    it('未保存条目无已保存快照 → 返回磁盘基线(lastSavedContent)', () => {
      const docStore = useDocumentStore()
      docStore.init('')
      docStore.loadContent('baseline', '/test.md')
      docStore.setContent('baseline modified') // dirty

      const store = setupSnapshots([])

      // 无快照 → 前一版本 = 磁盘基线(loadContent 经 markdownIO round-trip,'baseline' → 'baseline\n')
      expect(store.diffOldContent(UNSAVED_ID)).toBe(docStore.lastSavedContent)
    })

    it('最新快照(idx=0) → 返回倒数第二个快照(idx=1)的 content', () => {
      const docStore = useDocumentStore()
      docStore.init('')
      docStore.loadContent('cur', '/test.md')

      const store = setupSnapshots([
        { version: 1, id: '3000', filePath: '/test.md', content: 'v3', savedAt: 3000, trigger: 'manual' },
        { version: 1, id: '2000', filePath: '/test.md', content: 'v2', savedAt: 2000, trigger: 'manual' },
        { version: 1, id: '1000', filePath: '/test.md', content: 'v1', savedAt: 1000, trigger: 'manual' },
      ])

      // 快照 3000(最新)的前一版本 = 快照 2000
      expect(store.diffOldContent('3000')).toBe('v2')
      // 快照 2000(中间)的前一版本 = 快照 1000
      expect(store.diffOldContent('2000')).toBe('v1')
    })

    it('最旧快照(列表最后一个) → 空字符串(无前一版本)', () => {
      const docStore = useDocumentStore()
      docStore.init('')
      docStore.loadContent('cur', '/test.md')

      const store = setupSnapshots([
        { version: 1, id: '3000', filePath: '/test.md', content: 'v3', savedAt: 3000, trigger: 'manual' },
        { version: 1, id: '1000', filePath: '/test.md', content: 'v1', savedAt: 1000, trigger: 'manual' },
      ])

      // 最旧快照(1000)无前一版本
      expect(store.diffOldContent('1000')).toBe('')
    })

    it('仅有一个快照 → 该快照前一版本为空字符串', () => {
      const docStore = useDocumentStore()
      docStore.init('')
      docStore.loadContent('cur', '/test.md')

      const store = setupSnapshots([
        { version: 1, id: '1000', filePath: '/test.md', content: 'v1', savedAt: 1000, trigger: 'manual' },
      ])

      expect(store.diffOldContent('1000')).toBe('')
    })

    it('未知 id → 空字符串', () => {
      const docStore = useDocumentStore()
      docStore.init('')
      docStore.loadContent('cur', '/test.md')

      const store = setupSnapshots([
        { version: 1, id: '1000', filePath: '/test.md', content: 'v1', savedAt: 1000, trigger: 'manual' },
      ])

      expect(store.diffOldContent('nonexistent')).toBe('')
    })
  })
})
