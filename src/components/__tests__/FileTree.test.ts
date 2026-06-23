// FileTree 过滤 / 排序 / 空态 / 错误态测试(v0.5.0)。
//
// 原则:
//   - 不测 onFileClick 的文件打开路径(需要 documentStore mock,单独用例的价值不高)
//   - 不测 loading spinner 中间态(时序依赖 Promise 不 resolve,假异步比真 bug 更容易翻车)
//   - 聚焦"纯函数可覆盖 + 组件有可见失败模式"则两条:过滤规则(isVisible 对应)、排序、
//     空态 / 错误态渲染

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '@/stores/workspace'
import FileTree from '../FileTree.vue'
import { readDir } from '@tauri-apps/plugin-fs'
import type { DirEntry } from '@tauri-apps/plugin-fs'

function flushPromises() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** 生成 DirEntry 的快捷工厂。 */
function entry(name: string, isDir: boolean): DirEntry {
  return {
    name,
    isDirectory: isDir,
    isFile: !isDir,
    isSymlink: false,
  } as DirEntry
}

describe('FileTree', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
  })

  afterEach(() => {
    // 全局 mount 留在 body 的 DOM 清理
    document.body.innerHTML = ''
  })

  // ── 空态 ──

  it('无工作区时渲染空态按钮', () => {
    const wrapper = mount(FileTree)
    expect(wrapper.text()).toContain('打开一个文件夹作为工作区')
  })

  // ── 过滤规则 ──

  it('隐藏目录(.git/.vscode 等)不显示;保留 .md/.markdown/.mdown + 图片文件,过滤其它', async () => {
    const workspace = useWorkspaceStore()
    workspace.activeRoot = '/test/root'

    vi.mocked(readDir).mockResolvedValue([
      entry('.git', true),
      entry('node_modules', true),
      entry('.vscode', true),
      entry('README.md', false),
      entry('index.ts', false),
      entry('.env', false),
      entry('CHANGELOG.markdown', false),
      entry('TODO.mdown', false),
      entry('cover.png', false),
      entry('photo.JPG', false), // 大小写不敏感
      entry('icon.svg', false),
      entry('build.log', false),
    ])

    const wrapper = mount(FileTree)
    await flushPromises()
    await nextTick()

    const text = wrapper.text()
    // .md 系列应该可见
    expect(text).toContain('README.md')
    expect(text).toContain('CHANGELOG.markdown')
    expect(text).toContain('TODO.mdown')
    // 图片应该可见(v0.5.1 起树里也展示图片,以便拖入编辑器)
    expect(text).toContain('cover.png')
    expect(text).toContain('photo.JPG')
    expect(text).toContain('icon.svg')
    // 非隐藏目录可见
    expect(text).toContain('node_modules')
    // 应该过滤
    expect(text).not.toContain('.git')
    expect(text).not.toContain('.vscode')
    expect(text).not.toContain('.env')
    expect(text).not.toContain('index.ts')
    expect(text).not.toContain('build.log')
  })

  // ── v0.5.1 拖拽源 ──

  it('文件行 draggable=true,目录行 draggable=false', async () => {
    const workspace = useWorkspaceStore()
    workspace.activeRoot = '/test/root'

    vi.mocked(readDir).mockResolvedValue([
      entry('subdir', true),
      entry('note.md', false),
      entry('pic.png', false),
    ])

    const wrapper = mount(FileTree)
    await flushPromises()
    await nextTick()

    const items = wrapper.findAll('.group')
    expect(items.length).toBe(3)
    // 排序:目录在前
    expect(items[0].attributes('draggable')).toBe('false')
    expect(items[1].attributes('draggable')).toBe('true')
    expect(items[2].attributes('draggable')).toBe('true')
  })

  // ── 排序 ──

  it('目录在前文件在后,中文按拼音排序', async () => {
    const workspace = useWorkspaceStore()
    workspace.activeRoot = '/test/root'

    vi.mocked(readDir).mockResolvedValue([
      entry('读完.md', false),
      entry('资料', true),
      entry('笔记', true),
    ])

    const wrapper = mount(FileTree)
    await flushPromises()
    await nextTick()

    const items = wrapper.findAll('.group')
    expect(items.length).toBe(3)
    // 目录在前:笔记(bi3) → 资料(zi1) → 读完(du2).md
    expect(items[0].text()).toContain('笔记')
    expect(items[1].text()).toContain('资料')
    expect(items[2].text()).toContain('读完')
  })

  // ── 空目录显示 ──

  it('所有可见项都被过滤后显示"空目录"', async () => {
    const workspace = useWorkspaceStore()
    workspace.activeRoot = '/test/root'

    // readDir 返回一堆非 .md 文件 → sortEntries 全过滤 → flatItems 为空
    vi.mocked(readDir).mockResolvedValue([
      entry('.git', true),
      entry('build.js', false),
    ])

    const wrapper = mount(FileTree)
    await flushPromises()
    await nextTick()

    expect(wrapper.text()).toContain('空目录')
  })

  it('空目录下(无子项)显示"空目录"', async () => {
    const workspace = useWorkspaceStore()
    workspace.activeRoot = '/test/root'

    vi.mocked(readDir).mockResolvedValue([])

    const wrapper = mount(FileTree)
    await flushPromises()
    await nextTick()

    expect(wrapper.text()).toContain('空目录')
  })

  // ── 错误态 ──

  it('读目录失败时显示"读取目录失败"', async () => {
    const workspace = useWorkspaceStore()
    workspace.activeRoot = '/test/root'

    vi.mocked(readDir).mockRejectedValue(new Error('permission denied'))

    const wrapper = mount(FileTree)
    await flushPromises()
    await nextTick()

    expect(wrapper.text()).toContain('读取目录失败')
  })
})