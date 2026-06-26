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

  it('setActiveRoot 不强切 sidebarTab,用户主动切工作区时当前 tab 保留', () => {
    // 设计取舍:用户在"文件" tab 时点"打开文件夹",不应被强制切回大纲。
    // 持久化 tab 偏好只在启动恢复(loadFrom)路径应用,见下一条用例。
    const store = useWorkspaceStore()
    store.setActiveRoot('/root')
    store.setSidebarTab('files')
    store.setActiveRoot('/other')
    expect(store.sidebarTab).toBe('files') // 切根不动当前 tab
    // 切到 null(关闭工作区)是派生约束:无工作区时 'files' tab 没意义
    store.setActiveRoot(null)
    expect(store.sidebarTab).toBe('outline')
  })

  it('setSidebarTab 把当前 tab 同步写进活跃工作区 → loadFrom 启动恢复时还原', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/root')
    store.setSidebarTab('files')
    // 模拟下次启动:loadFrom 持久化数据
    const snapshot = store.snapshot()
    const fresh = useWorkspaceStore()
    fresh.loadFrom(snapshot)
    expect(fresh.activeRoot).toBe('/root')
    expect(fresh.sidebarTab).toBe('files')
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

  // ========== recentFiles(v0.5.2,Ctrl+P 双分区"最近打开"段) ==========

  it('setLastFile 自动把路径推入 recentFiles 头部', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/r')
    store.setLastFile('/r/a.md')
    store.setLastFile('/r/b.md')
    expect(store.activeWorkspace.recentFiles).toEqual(['/r/b.md', '/r/a.md'])
  })

  it('再次打开已在 recent 里的文件 → 旧位 dedupe,新位在头', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/r')
    store.setLastFile('/r/a.md')
    store.setLastFile('/r/b.md')
    store.setLastFile('/r/a.md')
    expect(store.activeWorkspace.recentFiles).toEqual(['/r/a.md', '/r/b.md'])
  })

  it('recentFiles cap 10 条 —— 超出从尾部丢', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/r')
    for (let i = 0; i < 15; i++) store.setLastFile(`/r/${i}.md`)
    expect(store.activeWorkspace.recentFiles).toHaveLength(10)
    // 最新的 14.md 在头,最早保留的是 5.md(0..4 已被挤掉)
    expect(store.activeWorkspace.recentFiles?.[0]).toBe('/r/14.md')
    expect(store.activeWorkspace.recentFiles?.[9]).toBe('/r/5.md')
  })

  it('setLastFile(null) 不入 recent —— 关闭文件 / 新建未保存', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/r')
    store.setLastFile('/r/a.md')
    store.setLastFile(null)
    expect(store.activeWorkspace.lastFile).toBeNull()
    expect(store.activeWorkspace.recentFiles).toEqual(['/r/a.md'])
  })

  it('renamePathPrefix 同步重写 recentFiles 中的旧前缀项', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/r')
    store.setLastFile('/r/old/a.md')
    store.setLastFile('/r/keep.md')
    store.setLastFile('/r/old/sub/b.md')
    store.renamePathPrefix('/r/old', '/r/new')
    expect(store.activeWorkspace.recentFiles).toEqual([
      '/r/old/sub/b.md'.replace('/r/old', '/r/new'),
      '/r/keep.md',
      '/r/old/a.md'.replace('/r/old', '/r/new'),
    ])
  })

  it('recentFiles 走 snapshot/loadFrom round-trip', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/x')
    store.setLastFile('/x/a.md')
    store.setLastFile('/x/b.md')
    const snap = store.snapshot()
    setActivePinia(createPinia())
    const next = useWorkspaceStore()
    next.loadFrom(snap)
    expect(next.activeWorkspace.recentFiles).toEqual(['/x/b.md', '/x/a.md'])
  })

  it('loadFrom 兼容旧 JSON(无 recentFiles 字段)→ 兜底空数组', () => {
    const store = useWorkspaceStore()
    store.loadFrom({
      version: 1,
      active: '/old',
      workspaces: { '/old': { expandedDirs: [], lastFile: '/old/x.md', sidebarTab: 'outline' } },
    })
    expect(store.activeWorkspace.recentFiles).toEqual([])
  })

  // ========== sidebarWidth(v0.5.5,可拖拽宽度) ==========

  it('setSidebarWidth clamp 到 [200, 600],并写入当前 workspace', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/r')
    store.setSidebarWidth(800) // 超出 max
    expect(store.sidebarWidth).toBe(600)
    store.setSidebarWidth(100) // 低于 min(SIDEBAR_WIDTH_MIN = 200)
    expect(store.sidebarWidth).toBe(200)
    store.setSidebarWidth(150) // 死区内的值,store 层只 clamp 不 snap
    expect(store.sidebarWidth).toBe(200) // 死区 snap 由 App.vue onCommit 负责
    store.setSidebarWidth(350)
    expect(store.sidebarWidth).toBe(350)
    expect(store.activeWorkspace.sidebarWidth).toBe(350)
  })

  it('setSidebarWidth 在无工作区时只更新 top-level ref,不写持久化', () => {
    const store = useWorkspaceStore()
    store.setSidebarWidth(400)
    expect(store.sidebarWidth).toBe(400)
    // activeWorkspace 在无 activeRoot 时是 fresh empty state,不挂持久化路径
    expect(store.activeWorkspace.sidebarWidth).toBe(256) // 默认
  })

  it('sidebarWidth 走 snapshot/loadFrom round-trip,跨 workspace 各自保留', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/a')
    store.setSidebarWidth(320)
    store.setActiveRoot('/b')
    store.setSidebarWidth(480)
    const snap = store.snapshot()
    setActivePinia(createPinia())
    const next = useWorkspaceStore()
    next.loadFrom(snap)
    expect(next.activeRoot).toBe('/b')
    expect(next.sidebarWidth).toBe(480)
    next.setActiveRoot('/a')
    expect(next.sidebarWidth).toBe(320)
    expect(next.activeWorkspace.sidebarWidth).toBe(320)
  })

  it('loadFrom 兼容旧 v1 JSON(无 sidebarWidth)→ 兜底 256', () => {
    const store = useWorkspaceStore()
    store.loadFrom({
      version: 1,
      active: '/old',
      workspaces: { '/old': { expandedDirs: [], lastFile: '/old/x.md', sidebarTab: 'outline' } },
    })
    expect(store.activeWorkspace.sidebarWidth).toBe(256)
    expect(store.sidebarWidth).toBe(256)
  })

  it('切换 workspace 时 sidebarWidth 同步到 top-level ref', () => {
    const store = useWorkspaceStore()
    store.setActiveRoot('/a')
    store.setSidebarWidth(300)
    store.setActiveRoot('/b')
    // b 还没设过 → 走 setActiveRoot 的 ensureWorkspace → 取 ws.sidebarWidth ?? 256
    expect(store.sidebarWidth).toBe(256)
    store.setSidebarWidth(420)
    // 切回 a 应恢复 300
    store.setActiveRoot('/a')
    expect(store.sidebarWidth).toBe(300)
  })
})
