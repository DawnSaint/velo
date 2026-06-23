import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

describe('workspace store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
  })

  it('初始无工作区,sidebar tab 默认大纲', () => {
    const store = useWorkspaceStore()
    expect(store.activeRoot).toBeNull()
    expect(store.sidebarTab).toBe('outline')
    expect(store.knownRoots).toEqual([])
  })

  it('pickWorkspace 选目录后切到该工作区,knownRoots 收录', async () => {
    vi.mocked(openDialog).mockResolvedValueOnce('/work/proj')
    const store = useWorkspaceStore()
    const picked = await store.pickWorkspace()
    expect(picked).toBe('/work/proj')
    expect(store.activeRoot).toBe('/work/proj')
    expect(store.knownRoots).toContain('/work/proj')
  })

  it('pickWorkspace 用户取消(返回非字符串) → 不改 activeRoot', async () => {
    vi.mocked(openDialog).mockResolvedValueOnce(null)
    const store = useWorkspaceStore()
    const picked = await store.pickWorkspace()
    expect(picked).toBeNull()
    expect(store.activeRoot).toBeNull()
  })

  it('setDirExpanded 维护当前工作区的展开集,折叠后会移除', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/root')
    store.setDirExpanded('/root/a', true)
    store.setDirExpanded('/root/b', true)
    expect(store.isDirExpanded('/root/a')).toBe(true)
    expect(store.isDirExpanded('/root/b')).toBe(true)
    store.setDirExpanded('/root/a', false)
    expect(store.isDirExpanded('/root/a')).toBe(false)
    expect(store.isDirExpanded('/root/b')).toBe(true)
  })

  it('无活跃工作区时 setDirExpanded 静默丢弃,不污染状态', () => {
    const store = useWorkspaceStore()
    store.setDirExpanded('/lonely', true)
    expect(store.knownRoots).toEqual([])
  })

  it('切换工作区:每个工作区的展开状态各自维护,不串台', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/a')
    store.setDirExpanded('/a/sub', true)
    store.setActiveRoot('/b')
    expect(store.isDirExpanded('/a/sub')).toBe(false)
    store.setDirExpanded('/b/sub', true)
    store.setActiveRoot('/a')
    expect(store.isDirExpanded('/a/sub')).toBe(true)
    expect(store.isDirExpanded('/b/sub')).toBe(false)
  })

  it('setSidebarTab 切到 files 后,该工作区下次激活恢复 files', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/root')
    store.setSidebarTab('files')
    store.setActiveRoot(null)
    expect(store.sidebarTab).toBe('outline') // 无工作区强制大纲
    store.setActiveRoot('/root')
    expect(store.sidebarTab).toBe('files')
  })

  it('snapshot / loadFrom round-trip', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/x')
    store.setDirExpanded('/x/sub', true)
    store.setLastFile('/x/a.md')
    store.setSidebarTab('files')
    const snap = store.snapshot()

    // 在另一个 pinia 实例里 loadFrom
    setActivePinia(createPinia())
    const next = useWorkspaceStore()
    next.loadFrom(snap)
    expect(next.activeRoot).toBe('/x')
    expect(next.isDirExpanded('/x/sub')).toBe(true)
    expect(next.activeWorkspace.lastFile).toBe('/x/a.md')
    expect(next.sidebarTab).toBe('files')
  })

  it('loadFrom 中 active 指向不存在的 workspace → fallback 到无工作区', () => {
    const store = useWorkspaceStore()
    store.loadFrom({
      version: 1,
      active: '/ghost',
      workspaces: { '/real': { expandedDirs: [], lastFile: null, sidebarTab: 'outline' } },
    })
    expect(store.activeRoot).toBeNull()
  })

  it('closeWorkspace 回到无工作区,但工作区记录仍保留', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/root')
    store.setDirExpanded('/root/sub', true)
    store.closeWorkspace()
    expect(store.activeRoot).toBeNull()
    // 工作区元数据保留,后续切回去 expandedDirs 不丢
    expect(store.knownRoots).toContain('/root')
  })
})
