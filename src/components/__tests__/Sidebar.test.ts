// Sidebar tab 切换 + refreshDir 转发测试(v0.5.0)。
//
// 关注:
//   1. 点击 tab 按钮 → workspaceStore.sidebarTab 切换
//   2. 切换会驱动互斥渲染(v-if):文件 tab 渲染 FileTree、大纲 tab 渲染 EditorOutline
//   3. expose 的 refreshDir 应该转发到 FileTree.refreshDir
//
// 不测:具体动画样式 / class 名 / 哪个 tab 在左在右(纯视觉,无失败模式)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '@/stores/workspace'
import Sidebar from '../Sidebar/Sidebar.vue'
import { readDir } from '@tauri-apps/plugin-fs'

describe('Sidebar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    // 默认让 readDir 返回空,FileTree 挂载不抛错
    vi.mocked(readDir).mockResolvedValue([])
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('点击"文件" tab 切换到 files,点击"大纲"切回 outline', async () => {
    const workspace = useWorkspaceStore()
    // 初始 'outline'(无工作区时 store 强制如此)
    expect(workspace.sidebarTab).toBe('outline')

    const wrapper = mount(Sidebar, {
      props: { modelValue: '', filePath: null },
    })

    const buttons = wrapper.findAll('button.velo-sidebar-tab')
    expect(buttons).toHaveLength(2)

    // tab 顺序:文件(0) / 大纲(1)
    await buttons[0].trigger('click')
    expect(workspace.sidebarTab).toBe('files')

    await buttons[1].trigger('click')
    expect(workspace.sidebarTab).toBe('outline')
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