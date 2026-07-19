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
import AssetPanel from '../Sidebar/AssetPanel.vue'
import EditorOutline from '../Sidebar/EditorOutline.vue'
import { registerBuiltinSettingsGroups } from '../settings/registerGroups'
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
    // 注册内置设置分组(编辑器 / 外观 / 文档),供虚拟大纲测试用
    registerBuiltinSettingsGroups()
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

  // paste 时若 file.type 为空 / 未知 MIME,旧版会把 ext 字面写成 '(null)';
  // 源码里 src 被 escapeMdUrl 写成 `\(null\)`(避免括号破坏 markdown 语法)。
  // 面板正则提取 src 后必须剥掉转义反斜杠,否则算出的 absPath 与磁盘真实路径
  // (无转义)对不上,会被 referencedAbsPaths 误判为未引用。
  it(' AssetPanel:转义括号 src 能归一化到磁盘路径,不被误判为未引用', async () => {
    // 模拟孤儿扫描时 readDir 返回的磁盘文件(无转义)
    vi.mocked(readDir).mockResolvedValue([
      { name: '(null)-20250717165607855.(null)', isFile: true, isDirectory: false },
    ] as any)

    const md = [
      '# test',
      '',
      '![img](assets/\\(null\\)-20250717165607855.\\(null\\))',
      '',
    ].join('\n')

    const wrapper = mount(AssetPanel, {
      props: { modelValue: md, filePath: 'C:/Users/foo/note.md' },
    })
    await nextTick()
    // 等 debounce 300ms + 异步 readDir 完成
    await new Promise(r => setTimeout(r, 500))
    await nextTick()

    const vm = wrapper.vm as any
    // 直接断言响应式数据,定位路径匹配差异
    const ref = [...vm.referencedAbsPaths]
    const orphanPaths = vm.orphans.map((o: any) => o.absPath)
    expect({ ref, orphanPaths }).toEqual({ ref: ['C:/Users/foo/assets/(null)-20250717165607855.(null)'], orphanPaths: [] })
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

  // #settings-panel 重做:设置激活时大纲区域渲染设置分组(虚拟标题),
  // 复用 EditorOutline 虚拟模式 —— 避免"看设置时大纲还是上一个文档的"误导。
  it('settingsActive 时大纲渲染设置分组(虚拟模式,覆盖文档大纲)', async () => {
    const workspace = useWorkspaceStore()
    workspace.setActiveRoot('/test/ws')
    workspace.setSidebarTab('outline')

    const headings = [{ level: 1, text: '编辑器', displayText: '编辑器', children: [], key: 'editor' }]
    const wrapper = mount(Sidebar, {
      props: {
        modelValue: '# 文档标题\n\n正文',
        filePath: '/test/ws/note.md',
        settingsActive: true,
        settingsHeadings: headings,
        settingsActiveGroupId: 'editor',
      },
    })
    await nextTick()

    // EditorOutline 挂载(虚拟模式),FileTree 不挂载
    const outline = wrapper.findComponent(EditorOutline)
    expect(outline.exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'FileTree' }).exists()).toBe(false)
    // 虚拟模式下渲染的是设置分组标题,不是文档标题
    expect(outline.text()).toContain('编辑器')
    expect(outline.text()).not.toContain('文档标题')
  })

  // 设置激活时侧栏遵循 sidebarTab:只有 outline tab 才渲染设置分类(虚拟模式),
  // 其他 tab 正常渲染对应组件(设置保持激活,不因点功能按钮而离开设置)。
  it('settingsActive + files tab 渲染 FileTree(设置保持激活,不强制虚拟大纲)', async () => {
    const workspace = useWorkspaceStore()
    workspace.setActiveRoot('/test/ws')
    workspace.setSidebarTab('files')

    const headings = [{ level: 1, text: '编辑器', displayText: '编辑器', children: [], key: 'editor' }]
    const wrapper = mount(Sidebar, {
      props: {
        modelValue: '# 文档标题',
        filePath: '/test/ws/note.md',
        settingsActive: true,
        settingsHeadings: headings,
        settingsActiveGroupId: 'editor',
      },
    })
    await nextTick()

    // files tab 时渲染 FileTree,不渲染虚拟大纲
    expect(wrapper.findComponent({ name: 'FileTree' }).exists()).toBe(true)
    expect(wrapper.findComponent(EditorOutline).exists()).toBe(false)
  })
})