// Sidebar 内容切换 + refreshDir 转发测试。
//
// 关注:
//   1. 外部更新 workspaceStore.sidebarTab → 文件树 / 大纲互斥渲染
//   2. expose 的 refreshDir 应该转发到 FileTree.refreshDir
//
// 不测:具体动画样式 / class 名 / ActivityBar 点击事件(由 ActivityBar 自测)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '@/stores/workspace'
import Sidebar from '../Sidebar/Sidebar.vue'
import WorkspaceSearchPanel from '../WorkspaceSearchPanel.vue'
import { readDir } from '@tauri-apps/plugin-fs'
import * as workspaceSearch from '@/utils/workspaceSearch'

vi.mock('@/utils/workspaceSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/workspaceSearch')>()
  return {
    ...actual,
    searchWorkspaceMarkdown: vi.fn(),
  }
})

describe('Sidebar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    // 默认让 readDir 返回空,FileTree 挂载不抛错
    vi.mocked(readDir).mockResolvedValue([])
    vi.mocked(workspaceSearch.searchWorkspaceMarkdown).mockResolvedValue({
      groups: [],
      progress: workspaceSearch.initialWorkspaceSearchProgress(),
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('切到 files 渲染 FileTree(互斥 v-if),切回 outline 卸载它', async () => {
    const workspace = useWorkspaceStore()
    workspace.setActiveRoot('/test/ws')

    const wrapper = mount(Sidebar, {
      props: { modelValue: '', filePath: null },
    })

    // 初始默认从 setActiveRoot 拿到的 sidebarTab 是 'outline'
    expect(wrapper.findComponent({ name: 'FileTree' }).exists()).toBe(false)

    workspace.setSidebarTab('files')
    await nextTick()

    expect(wrapper.findComponent({ name: 'FileTree' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'EditorOutline' }).exists()).toBe(false)

    workspace.setSidebarTab('outline')
    await nextTick()

    expect(wrapper.findComponent({ name: 'FileTree' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'EditorOutline' }).exists()).toBe(true)
  })

  it('切到 search 渲染 WorkspaceSearchPanel(v0.6.x 新增的第三个 tab)', async () => {
    const workspace = useWorkspaceStore()
    workspace.setActiveRoot('/test/ws')

    const wrapper = mount(Sidebar, {
      props: { modelValue: '', filePath: null },
    })

    expect(wrapper.findComponent(WorkspaceSearchPanel).exists()).toBe(false)

    workspace.setSidebarTab('search')
    await nextTick()

    expect(wrapper.findComponent(WorkspaceSearchPanel).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'FileTree' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'EditorOutline' }).exists()).toBe(false)
  })

  it('file tab 活时 refreshDir 对外暴露且不抛错', async () => {
    const workspace = useWorkspaceStore()
    workspace.setActiveRoot('/test/ws')
    workspace.setSidebarTab('files')

    const wrapper = mount(Sidebar, {
      props: { modelValue: '', filePath: null },
    })
    await nextTick()

    const sidebarVm = wrapper.vm as unknown as { refreshDir: (p: string) => void }
    expect(typeof sidebarVm.refreshDir).toBe('function')
    // 同步调用,内部 FileTree.refreshDir(异步) 走 try/catch,不抛到 Sidebar 层
    expect(() => sidebarVm.refreshDir('/test/ws/sub')).not.toThrow()
  })

  it('outline tab 时 refreshDir 不抛错(FileTree 未挂载)', () => {
    const workspace = useWorkspaceStore()
    workspace.setActiveRoot('/test/ws')
    // 保持 outline tab

    const wrapper = mount(Sidebar, {
      props: { modelValue: '', filePath: null },
    })

    const sidebarVm = wrapper.vm as unknown as { refreshDir: (p: string) => void }
    expect(() => sidebarVm.refreshDir('/test/ws/sub')).not.toThrow()
  })
})