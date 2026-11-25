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
import { useImagePreviewStore } from '@/stores/imagePreview'
import Sidebar from '../Sidebar/Sidebar.vue'
import WorkspaceSearchPanel from '../WorkspaceSearchPanel.vue'
import AssetPanel from '../Sidebar/AssetPanel.vue'
import EditorOutline from '../Sidebar/EditorOutline.vue'
import { exists, readDir } from '@tauri-apps/plugin-fs'
import { open as dialogOpen } from '@tauri-apps/plugin-dialog'
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

  // paste 时若 file.type 为空 / 未知 MIME,旧版会把 ext 字面写成 '(null)';
  // 源码里 src 被 escapeMdUrl 写成 `\(null\)`(避免括号破坏 markdown 语法)。
  // 面板正则提取 src 后必须剥掉转义反斜杠,否则算出的 absPath 与磁盘真实路径
  // (无转义)对不上,exists 检查会误报失效。
  it('AssetPanel:转义括号 src 能归一化到磁盘路径,不误报失效', async () => {
    vi.mocked(exists).mockResolvedValue(true)

    const md = [
      '# test',
      '',
      '![img](assets/\\(null\\)-20250717165607855.\\(null\\))',
      '',
    ].join('\n')

    const wrapper = mount(AssetPanel, {
      props: { modelValue: md, filePath: 'C:/Users/foo/note.md' },
    })
    await new Promise(r => setTimeout(r, 0))
    await nextTick()

    const vm = wrapper.vm as any
    expect(vm.allImages[0].absPath).toBe('C:/Users/foo/assets/(null)-20250717165607855.(null)')
    expect(wrapper.text()).toContain('本地 (1)')
    expect(wrapper.text()).not.toContain('失效引用')
  })

  it('AssetPanel:文件不存在的本地图片进入失效引用分组,点击仍可定位', async () => {
    // gone.png 不存在,ok.png 存在
    vi.mocked(exists).mockImplementation(async (p: any) => String(p).endsWith('ok.png'))

    const md = '![gone](assets/gone.png)\n\n![ok](assets/ok.png)'
    const wrapper = mount(AssetPanel, {
      props: { modelValue: md, filePath: 'C:/Users/foo/note.md' },
    })
    await new Promise(r => setTimeout(r, 0))
    await nextTick()

    expect(wrapper.text()).toContain('失效引用')
    expect(wrapper.text()).toContain('文件不存在')
    expect(wrapper.text()).toContain('本地 (1)')

    await wrapper.find('[data-testid="broken-item"]').trigger('click')
    expect(wrapper.emitted('locate-image')?.[0]).toEqual(['assets/gone.png', 0])
  })

  it('AssetPanel:失效引用右键 → 重新链接改写 src / 移除引用删节点', async () => {
    vi.mocked(exists).mockResolvedValue(false)
    vi.mocked(dialogOpen).mockResolvedValue('C:/Users/foo/pics/new.png')

    const wrapper = mount(AssetPanel, {
      props: { modelValue: '![gone](assets/gone.png)', filePath: 'C:/Users/foo/note.md' },
    })
    await new Promise(r => setTimeout(r, 0))
    await nextTick()

    // 重新链接:菜单 Teleport 到 body,用 document 查
    await wrapper.find('[data-testid="broken-item"]').trigger('contextmenu', { clientX: 10, clientY: 10 })
    await nextTick()
    ;(document.querySelector('[data-testid="ctx-relink"]') as HTMLElement).click()
    await new Promise(r => setTimeout(r, 0))
    expect(wrapper.emitted('reorganize-asset')?.[0]).toEqual([
      { oldAbsPath: 'C:/Users/foo/assets/gone.png', newSrc: 'pics/new.png', mode: 'copy' },
    ])

    // 移除引用:newSrc 空串 → App.vue 删 image 节点
    await wrapper.find('[data-testid="broken-item"]').trigger('contextmenu', { clientX: 10, clientY: 10 })
    await nextTick()
    ;(document.querySelector('[data-testid="ctx-remove-reference"]') as HTMLElement).click()
    await nextTick()
    expect(wrapper.emitted('reorganize-asset')?.[1]).toEqual([
      { oldAbsPath: 'C:/Users/foo/assets/gone.png', newSrc: '', mode: 'move' },
    ])
  })

  it('AssetPanel:不再扫描 assets 目录(孤儿分组已移除)', async () => {
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readDir).mockResolvedValue([
      { name: 'unused.png', isFile: true, isDirectory: false },
    ] as any)

    const wrapper = mount(AssetPanel, {
      props: { modelValue: '![img](assets/a.png)', filePath: 'C:/Users/foo/note.md' },
    })
    // 超过旧孤儿扫描的 300ms debounce 窗口
    await new Promise(r => setTimeout(r, 400))
    await nextTick()

    expect(readDir).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('未被引用')
    expect(wrapper.text()).not.toContain('unused.png')
  })

  it('FileTree:点击图片行 → lightbox 预览(同目录图片成组)', async () => {
    vi.mocked(readDir).mockResolvedValue([
      { name: 'pic.png', isFile: true, isDirectory: false },
      { name: 'other.jpg', isFile: true, isDirectory: false },
      { name: 'note.md', isFile: true, isDirectory: false },
    ] as any)

    const workspace = useWorkspaceStore()
    workspace.setActiveRoot('/test/ws')
    workspace.setSidebarTab('files')

    const wrapper = mount(Sidebar, {
      props: { modelValue: '', filePath: null },
    })
    await new Promise(r => setTimeout(r, 0))
    await nextTick()

    await wrapper.find('[data-row-path="/test/ws/pic.png"]').trigger('click')
    const preview = useImagePreviewStore()
    expect(preview.isOpen).toBe(true)
    expect(preview.images.map(i => i.name)).toEqual(['other.jpg', 'pic.png'])
    expect(preview.index).toBe(1)
    expect(preview.images[1].absPath).toBe('/test/ws/pic.png')
  })

  // #settings-panel 重做:设置激活时大纲区域显示空态(设置类目改为设置页顶部 Tab 切换,
  // 不再借住大纲区域)。避免"看设置时大纲还是上一个文档的"误导。
  // EditorOutline 挂载但通过 settingsActive prop 显示空态(scroll-spy 被 gate 掉)。
  it('settingsActive + outline tab 显示空态(不渲染文档大纲)', async () => {
    const workspace = useWorkspaceStore()
    workspace.setActiveRoot('/test/ws')
    workspace.setSidebarTab('outline')

    const wrapper = mount(Sidebar, {
      props: {
        modelValue: '# 文档标题\n\n正文',
        filePath: '/test/ws/note.md',
        settingsActive: true,
      },
    })
    await nextTick()

    // EditorOutline 挂载(settingsActive 传入),但显示空态而非文档大纲
    expect(wrapper.findComponent(EditorOutline).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'FileTree' }).exists()).toBe(false)
    // 空态显示"暂无标题",不显示文档标题
    expect(wrapper.text()).toContain('暂无标题')
    expect(wrapper.text()).not.toContain('文档标题')
  })

  // 设置激活时侧栏遵循 sidebarTab:outline/assets 显示空态,
  // files/search 正常渲染对应组件(设置保持激活,不因点功能按钮而离开设置)。
  it('settingsActive + files tab 渲染 FileTree(设置保持激活,大纲区不接管)', async () => {
    const workspace = useWorkspaceStore()
    workspace.setActiveRoot('/test/ws')
    workspace.setSidebarTab('files')

    const wrapper = mount(Sidebar, {
      props: {
        modelValue: '# 文档标题',
        filePath: '/test/ws/note.md',
        settingsActive: true,
      },
    })
    await nextTick()

    // files tab 时渲染 FileTree,不渲染空态
    expect(wrapper.findComponent({ name: 'FileTree' }).exists()).toBe(true)
    expect(wrapper.findComponent(EditorOutline).exists()).toBe(false)
  })
})