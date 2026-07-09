// FileTree 过滤 / 排序 / 空态 / 错误态测试(v0.5.0) + 右键菜单 CRUD 测试(v0.5.1)。
//
// 原则:
//   - 不测 onFileClick 的文件打开路径(需要 documentStore mock,单独用例的价值不高)
//   - 不测 loading spinner 中间态(时序依赖 Promise 不 resolve,假异步比真 bug 更容易翻车)
//   - 聚焦"纯函数可覆盖 + 组件有可见失败模式"则两条:过滤规则(isVisible 对应)、排序、
//     空态 / 错误态渲染
//   - v0.5.1 右键菜单:覆盖"右键 → 菜单出现 / 菜单项可见 / destructive op confirm /
//     新建 / 重命名 / 删除 / reveal"主链路;不测菜单渲染样式 / icon 选型等纯视觉

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDocumentStore } from '@/stores/document'
import { useRecentFilesStore } from '@/stores/recentFiles'
import FileTree from '../Sidebar/FileTree.vue'
import { copyFile, readDir, rename as fsRename, remove as fsRemove, writeTextFile, mkdir as fsMkdir } from '@tauri-apps/plugin-fs'
import { message } from '@tauri-apps/plugin-dialog'
import { confirm } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
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

/** 在挂载好的 FileTree wrapper 里找到名字对应的 .group 行(原生点击 / 右键场景)。
 *  v0.5.1 起根节点 row 也是 .group;按 name 精确匹配过滤,避免误中根。 */
function findRowByName(wrapper: ReturnType<typeof mount>, name: string) {
  const items = wrapper.findAll('.group')
  return items.find(i => i.text().includes(name))
}

/** 取所有非根的 .group 行 —— v0.5.1 根 row 进入 flatItems 后,关心子项的断言用这个。 */
function nonRootRows(wrapper: ReturnType<typeof mount>) {
  // 根 row 文本 = workspace 的 basename;用 title 属性区分:根的 title 是工作区根全路径
  return wrapper.findAll('.group').filter(r => r.attributes('title') !== '/test/root')
}

/** 按 title(全路径)精确匹配行 —— 同名文件/目录在不同层级时,按 text 包含匹配会误中。 */
function findRowByTitle(wrapper: ReturnType<typeof mount>, title: string) {
  const row = wrapper.findAll('.group').find(r => r.attributes('title') === title)
  if (!row) throw new Error(`row not found by title=${title}`)
  return row
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

  it('行 draggable=true(文件 + 目录都可拖,v0.5.1 起目录支持内部 move)', async () => {
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

    // 根 row 也是 .group,但本测试只关心子项 → 用 nonRootRows
    const items = nonRootRows(wrapper)
    expect(items.length).toBe(3)
    // v0.5.1 起目录也可拖(内部 move 语义),不再区分目录 / 文件
    expect(items[0].attributes('draggable')).toBe('true')
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

    const items = nonRootRows(wrapper)
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

    // readDir 返回一堆非 .md 文件 → sortEntries 全过滤 → 子项为空,
    // 根 row 仍渲染(v0.5.1 根并入树),期望额外显示"空目录"占位
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

  // ════════════════════════════════════════════
  // ── v0.5.1 右键菜单 CRUD(行内 input 模型) ──
  // ════════════════════════════════════════════
  //
  // v0.5.1 调整:新建 / 重命名走行内 input,不再用 modal。
  //   - 新建:目标目录末尾追加一行 input(.md 文件带 ".md" 静态后缀)
  //   - 重命名:把原行换成 input
  //   - Enter 提交、Esc 取消、点外部提交
  //
  // Teleport 把菜单挂到 body,行内 input 在树内。find 用 `document.body` +
  // querySelector;行内 input 用 [data-inline-row] selector。

  /** 在 jsdom 里触发 DOM 节点上的 contextmenu 事件;return 默认是否被 preventDefault。
   *  入参兼容 Element(原生)和 @vue/test-utils 的 DOMWrapper / VueWrapper(走 .element)。 */
  function triggerContextMenu(target: unknown, clientX = 10, clientY = 20): boolean {
    const el = (target as { element?: Element }).element ?? (target as Element)
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    })
    el.dispatchEvent(ev)
    return ev.defaultPrevented
  }

  /** 准备一个挂好的 FileTree,工作区根 = '/test/root',给定 entries,挂载后等待 readDir 完成。 */
  async function mountWithEntries(entries: DirEntry[]): Promise<ReturnType<typeof mount>> {
    const workspace = useWorkspaceStore()
    workspace.activeRoot = '/test/root'
    vi.mocked(readDir).mockResolvedValue(entries)
    const w = mount(FileTree, { attachTo: document.body })
    await flushPromises()
    await nextTick()
    return w
  }

  /** 在指定 row 上右键,触发菜单;return 菜单 div(已 querySelector 出来)。
   *  rowName = 行名字符串,按 text 包含匹配(单层场景够用)。 */
  async function openContextMenuOnRow(wrapper: ReturnType<typeof mount>, rowName: string) {
    const row = findRowByName(wrapper, rowName)
    expect(row).toBeTruthy()
    triggerContextMenu(row!)
    await nextTick()
    return document.body.querySelector('[data-tree-context-menu]') as HTMLDivElement
  }

  /** 在指定 .group 行 wrapper 上右键(精确,同名多层级时用)。 */
  async function openContextMenuOnRowEl(row: ReturnType<typeof findRowByName>) {
    triggerContextMenu(row)
    await nextTick()
    return document.body.querySelector('[data-tree-context-menu]') as HTMLDivElement
  }

  /** 拿 [data-inline-row] 当前活动的那一行(同时只会有一个行内编辑)。 */
  function activeInlineRow(): HTMLDivElement | null {
    return document.querySelector('[data-inline-row]') as HTMLDivElement | null
  }

  /** 拿行内 input(input 元素;新行和重命名行都用同一个 selector)。 */
  function activeInlineInput(): HTMLInputElement | null {
    const row = activeInlineRow()
    return row ? row.querySelector('input') as HTMLInputElement : null
  }

  // ── 菜单出现 / 关闭 ──

  it('右键 .md 文件行 → 菜单出现,7 个菜单项(含"在编辑器中打开"和"复制")', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    const menu = await openContextMenuOnRow(wrapper, 'note.md')
    expect(menu).toBeTruthy()
    const items = menu.querySelectorAll('button')
    // 在编辑器中打开 / 新建文件 / 新建文件夹 / 复制 / 重命名 / 删除 / 在资源管理器中显示 = 7
    expect(items.length).toBe(7)
    expect(items[0].textContent).toContain('在编辑器中打开')
    expect(items[1].textContent).toContain('新建文件')
    expect(items[2].textContent).toContain('新建文件夹')
    expect(items[3].textContent).toContain('复制')
    expect(items[4].textContent).toContain('重命名')
    expect(items[5].textContent).toContain('删除')
    expect(items[6].textContent).toContain('在资源管理器中显示')

    wrapper.unmount()
  })

  it('右键目录行 → 菜单出现,8 个菜单项(含"在新窗口中打开"/"在此文件夹中搜索"和"复制",删除可用)', async () => {
    // 工作区根不进 flatItems 视图(模板注释:不显示根节点本身);
    // 子目录右键应能"在新窗口中打开" + 删除可用(disabled 属性已移除)。
    // v0.6.0 在"在新窗口中打开"之后追加了"在此文件夹中搜索",菜单项 7 → 8。
    const wrapper = await mountWithEntries([entry('sub', true)])
    const menu = await openContextMenuOnRow(wrapper, 'sub')
    const items = menu.querySelectorAll('button')
    expect(items.length).toBe(8)
    expect(items[0].textContent).toContain('在新窗口中打开')
    expect(items[1].textContent).toContain('在此文件夹中搜索')
    expect(items[2].textContent).toContain('新建文件')
    expect(items[3].textContent).toContain('新建文件夹')
    expect(items[4].textContent).toContain('复制')
    expect(items[5].textContent).toContain('重命名')
    const deleteBtn = items[6] as HTMLButtonElement
    expect(deleteBtn.disabled).toBe(false)
    wrapper.unmount()
  })

  it('Escape 关闭菜单', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    expect(document.body.querySelector('[data-tree-context-menu]')).toBeTruthy()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(document.body.querySelector('[data-tree-context-menu]')).toBeFalsy()
    wrapper.unmount()
  })

  // ── 「在资源管理器中显示」 ──

  it('点击「在资源管理器中显示」→ revealItemInDir 调用 + 菜单关闭', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')

    const revealBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('在资源管理器中显示')) as HTMLButtonElement
    expect(revealBtn).toBeTruthy()
    await revealBtn.click()
    await flushPromises()

    expect(revealItemInDir).toHaveBeenCalledWith('/test/root/note.md')
    expect(document.body.querySelector('[data-tree-context-menu]')).toBeFalsy()
    wrapper.unmount()
  })

  // ── 「删除」必弹 confirm,cancel 不调 fs.remove ──

  it('点击「删除」+ confirm 取消 → remove 未调用,菜单关闭', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')

    vi.mocked(confirm).mockResolvedValue(false)
    const deleteBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('删除')) as HTMLButtonElement
    await deleteBtn.click()
    await flushPromises()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(fsRemove).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('点击「删除」+ confirm 接受 → remove 调用 + refreshDir(父目录)', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')

    vi.mocked(confirm).mockResolvedValue(true)
    const deleteBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('删除')) as HTMLButtonElement
    await deleteBtn.click()
    await flushPromises()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(fsRemove).toHaveBeenCalledWith('/test/root/note.md', { recursive: false })
    expect(readDir).toHaveBeenCalledTimes(2) // 1 = initial mount, 2 = refreshDir after delete
    wrapper.unmount()
  })

  it('删除当前打开文件 → loadContent 触发关闭(currentFilePath → null)', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    const docStore = useDocumentStore()
    // 假装用户已经打开了 note.md 且 dirty
    docStore.loadContent('# hello', '/test/root/note.md')
    docStore.content = '# dirty content'
    expect(docStore.dirty).toBe(true)

    await openContextMenuOnRow(wrapper, 'note.md')

    vi.mocked(confirm).mockResolvedValue(true)
    const deleteBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('删除')) as HTMLButtonElement
    await deleteBtn.click()
    await flushPromises()

    // dirty 删除 → confirm 文案含"未保存" + "将丢失"
    const confirmMsg = vi.mocked(confirm).mock.calls[0]?.[0] as string
    expect(confirmMsg).toContain('未保存')
    expect(confirmMsg).toContain('将丢失')
    // 联动:loadContent('', null) → currentFilePath 清空
    expect(docStore.currentFilePath).toBeNull()
    wrapper.unmount()
  })

  it('删除文件后同步清理全局最近文件', async () => {
    const recent = useRecentFilesStore()
    recent.loadFrom({
      version: 1,
      entries: [
        { path: '/test/root/note.md', openedAt: 2 },
        { path: '/test/root/keep.md', openedAt: 1 },
      ],
    })
    const wrapper = await mountWithEntries([entry('note.md', false), entry('keep.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')

    vi.mocked(confirm).mockResolvedValue(true)
    const deleteBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('删除')) as HTMLButtonElement
    await deleteBtn.click()
    await flushPromises()

    expect(recent.entries.map(e => e.path)).toEqual(['/test/root/keep.md'])
    wrapper.unmount()
  })

  // ── 「新建文件」行内 input ──

  it('点击「新建文件」→ 行内 input 出现 + 默认 "未命名文档" + 静态 ".md" 后缀', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    const newFileBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('新建文件')) as HTMLButtonElement
    await newFileBtn.click()
    await nextTick()

    const row = activeInlineRow()
    expect(row).toBeTruthy()
    const input = activeInlineInput()
    expect(input).toBeTruthy()
    // 默认空值(不再预填占位文字)
    expect(input!.value).toBe('')
    expect(document.activeElement).toBe(input)
    // ".md" 是静态 span,不是 input 的一部分
    const mdSuffix = row!.querySelector('span.text-gray-500')
    expect(mdSuffix?.textContent).toBe('.md')
    // 菜单关闭
    expect(document.body.querySelector('[data-tree-context-menu]')).toBeFalsy()
    wrapper.unmount()
  })

  it('新建文件:改名 + Enter → writeTextFile 调用 + 行内 row 消失', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    const newFileBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('新建文件')) as HTMLButtonElement
    await newFileBtn.click()
    await nextTick()

    const input = activeInlineInput()!
    input.value = 'new'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    // 触发 Enter
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()

    expect(writeTextFile).toHaveBeenCalledWith('/test/root/new.md', '')
    // 行内 row 关闭
    expect(activeInlineRow()).toBeFalsy()
    wrapper.unmount()
  })

  it('新建文件:已存在同名 → 错误显示在 input.title,row 保留', async () => {
    const wrapper = await mountWithEntries([entry('a.md', false)])
    await openContextMenuOnRow(wrapper, 'a.md')
    const newFileBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('新建文件')) as HTMLButtonElement
    await newFileBtn.click()
    await nextTick()

    const input = activeInlineInput()!
    input.value = 'a' // → "a.md" 跟现有 a.md 同名
    input.dispatchEvent(new Event('input'))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()

    // submit 失败:writeTextFile 未调,row 仍存在,title 含错误
    expect(writeTextFile).not.toHaveBeenCalled()
    expect(activeInlineRow()).toBeTruthy()
    expect(input.title).toContain('已存在同名项')
    wrapper.unmount()
  })

  it('新建文件:默认空值 + blur → 静默取消,不建文件', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    const newFileBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('新建文件')) as HTMLButtonElement
    await newFileBtn.click()
    await nextTick()

    // 默认空值,点外部(blur)→ 空名 = 放弃新建(静默 cancelInline,不建文件)
    expect(activeInlineInput()!.value).toBe('')
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()

    expect(writeTextFile).not.toHaveBeenCalled()
    expect(activeInlineRow()).toBeFalsy()
    wrapper.unmount()
  })

  it('新建文件:默认空值 + Enter → 显示空错误,row 保留', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    const newFileBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('新建文件')) as HTMLButtonElement
    await newFileBtn.click()
    await nextTick()

    // Enter 空值 → submitInline 报"名称不能为空",row 保留
    const input = activeInlineInput()!
    expect(input.value).toBe('')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()

    expect(writeTextFile).not.toHaveBeenCalled()
    expect(activeInlineInput()!.title).toContain('名称不能为空')
    expect(activeInlineRow()).toBeTruthy()
    wrapper.unmount()
  })

  // ── 「新建目录」行内 input ──

  it('点击「新建文件夹」→ 行内 input 出现 + 默认空值 + 无 .md 后缀', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    const newDirBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('新建文件夹')) as HTMLButtonElement
    await newDirBtn.click()
    await nextTick()

    const row = activeInlineRow()
    const input = activeInlineInput()!
    // 默认空值(不再预填占位文字)
    expect(input.value).toBe('')
    // 目录无 .md 后缀
    expect(row!.querySelector('span.text-gray-500')).toBeFalsy()
    expect(document.activeElement).toBe(input)
    wrapper.unmount()
  })

  it('新建目录:改名 + Enter → mkdir 调用', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    const newDirBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('新建文件夹')) as HTMLButtonElement
    await newDirBtn.click()
    await nextTick()

    const input = activeInlineInput()!
    input.value = 'subfolder'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()

    expect(fsMkdir).toHaveBeenCalledWith('/test/root/subfolder')
    wrapper.unmount()
  })

  // ── 目录右键"新建"目标 = 目录自身(不是父目录) ──
  //
  // 回归:之前用 parentDirOfSync(dir) 算 parent 目录,导致右键 B(/A/B) → 建在 /A,
  // 与"目录右键 = 进目录"的 Finder / VSCode 约定不符。改为 targetDirForNew
  // 后:目录节点 → 自身;文件节点 → 父目录(行为不变)。
  //
  // 这里用 mockImplementation 让根目录返回 [sub]、sub 目录返回 []——sub 自身
  // 在 dirIndex 里但 children 懒加载,openInlineNew 会触发 setDirExpanded(true)
  // + loadDirChildren,顺手把 readDir('/test/root/sub') 也覆盖。

  it('右键目录行 → "新建文件" 创建在该目录内(不是父目录)', async () => {
    const workspace = useWorkspaceStore()
    workspace.activeRoot = '/test/root'
    vi.mocked(readDir).mockImplementation(async (p) => {
      const path = typeof p === 'string' ? p : p.toString()
      if (path === '/test/root') return [entry('sub', true)]
      if (path === '/test/root/sub') return []
      return []
    })

    const wrapper = mount(FileTree, { attachTo: document.body })
    await flushPromises()
    await nextTick()

    const subRow = findRowByName(wrapper, 'sub')!
    expect(subRow).toBeTruthy()
    triggerContextMenu(subRow)
    await nextTick()

    const newFileBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('新建文件')) as HTMLButtonElement
    await newFileBtn.click()
    // 目录右键触发 loadDirChildren 懒展开(子目录 children 之前 undefined),
    // openInlineNew 里 await 了它,click() 不会等 async handler resolve → flushPromises 补一个
    await flushPromises()
    await nextTick()

    const input = activeInlineInput()!
    input.value = 'inside'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()

    expect(writeTextFile).toHaveBeenCalledWith('/test/root/sub/inside.md', '')
    expect(writeTextFile).not.toHaveBeenCalledWith('/test/root/inside.md', '')
    wrapper.unmount()
  })

  it('右键目录行 → "新建文件夹" 创建在该目录内(不是父目录)', async () => {
    const workspace = useWorkspaceStore()
    workspace.activeRoot = '/test/root'
    vi.mocked(readDir).mockImplementation(async (p) => {
      const path = typeof p === 'string' ? p : p.toString()
      if (path === '/test/root') return [entry('sub', true)]
      if (path === '/test/root/sub') return []
      return []
    })

    const wrapper = mount(FileTree, { attachTo: document.body })
    await flushPromises()
    await nextTick()

    const subRow = findRowByName(wrapper, 'sub')!
    triggerContextMenu(subRow)
    await nextTick()

    const newDirBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('新建文件夹')) as HTMLButtonElement
    await newDirBtn.click()
    // 同上:目录右键触发 loadDirChildren 懒展开,需要 flushPromises 等异步
    await flushPromises()
    await nextTick()

    const input = activeInlineInput()!
    input.value = 'nested'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()

    expect(fsMkdir).toHaveBeenCalledWith('/test/root/sub/nested')
    expect(fsMkdir).not.toHaveBeenCalledWith('/test/root/nested')
    wrapper.unmount()
  })

  // ── 「重命名」行内 input ──

  it('点击「重命名」(.md)→ 行内 input 出现,value 是 baseName(无 .md),有静态 .md 后缀', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    const renameBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('重命名')) as HTMLButtonElement
    await renameBtn.click()
    await nextTick()

    const row = activeInlineRow()
    const input = activeInlineInput()!
    expect(input).toBeTruthy()
    expect(input.value).toBe('note') // 没有 .md
    expect(document.activeElement).toBe(input)
    // 文本被 select
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    // 静态 .md 后缀
    const mdSuffix = row!.querySelector('span.text-gray-500')
    expect(mdSuffix?.textContent).toBe('.md')
    wrapper.unmount()
  })

  it('重命名:改名 + Enter → fsRename 调用 + 联动当前打开文件和全局最近文件路径', async () => {
    const docStore = useDocumentStore()
    const recent = useRecentFilesStore()
    docStore.loadContent('# old', '/test/root/note.md')
    recent.loadFrom({ version: 1, entries: [{ path: '/test/root/note.md', openedAt: 1 }] })

    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    const renameBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('重命名')) as HTMLButtonElement
    await renameBtn.click()
    await nextTick()

    const input = activeInlineInput()!
    input.value = 'note2'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()

    expect(fsRename).toHaveBeenCalledWith('/test/root/note.md', '/test/root/note2.md')
    // 当前打开文件被重命名 → currentFilePath 更新,content 保留
    expect(docStore.currentFilePath).toBe('/test/root/note2.md')
    // content 是 markdownIO canonical 形式(loadContent 规范化),'# old' → '# old\n'
    expect(docStore.content).toBe('# old\n')
    expect(recent.entries.map(e => e.path)).toEqual(['/test/root/note2.md'])
    wrapper.unmount()
  })

  it('重命名目录:input 含完整名(无 .md 后缀)', async () => {
    const wrapper = await mountWithEntries([entry('sub', true)])
    await openContextMenuOnRow(wrapper, 'sub')
    const renameBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('重命名')) as HTMLButtonElement
    await renameBtn.click()
    await nextTick()

    const row = activeInlineRow()
    const input = activeInlineInput()!
    expect(input.value).toBe('sub') // 完整名
    // 目录不显示 .md 后缀 span
    expect(row!.querySelector('span.text-gray-500')).toBeFalsy()
    wrapper.unmount()
  })

  it('重命名:与原名同名 → Enter 后 row 关闭(空操作),fsRename 未调', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    const renameBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('重命名')) as HTMLButtonElement
    await renameBtn.click()
    await nextTick()

    const input = activeInlineInput()!
    // input.value === 'note',不变,Enter
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()

    expect(fsRename).not.toHaveBeenCalled()
    expect(activeInlineRow()).toBeFalsy()
    wrapper.unmount()
  })

  it('重命名:输入非法字符 / → 错误提示,row 保留', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    const renameBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('重命名')) as HTMLButtonElement
    await renameBtn.click()
    await nextTick()

    const input = activeInlineInput()!
    input.value = 'bad/name' // 含 /
    input.dispatchEvent(new Event('input'))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()

    expect(fsRename).not.toHaveBeenCalled()
    expect(input.title).toContain('非法字符')
    expect(activeInlineRow()).toBeTruthy()
    wrapper.unmount()
  })

  // ── 关闭交互 ──

  it('行内编辑:Escape → 取消,row 消失,fs 未调', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    const newFileBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('新建文件')) as HTMLButtonElement
    await newFileBtn.click()
    await nextTick()
    expect(activeInlineRow()).toBeTruthy()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()

    expect(activeInlineRow()).toBeFalsy()
    expect(writeTextFile).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('行内编辑:点外部 → 提交(对齐全平台编辑约定)', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    const newFileBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('新建文件')) as HTMLButtonElement
    await newFileBtn.click()
    await nextTick()

    const input = activeInlineInput()!
    input.value = 'autosubmit'
    input.dispatchEvent(new Event('input'))
    await nextTick()

    // 在行外(例如 body 空白处)派发 pointerdown —— 模拟点外部
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()

    expect(writeTextFile).toHaveBeenCalledWith('/test/root/autosubmit.md', '')
    expect(activeInlineRow()).toBeFalsy()
    wrapper.unmount()
  })

  it('行内编辑:点 row 内(input 自己)不提交,row 保留', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    const newFileBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('新建文件')) as HTMLButtonElement
    await newFileBtn.click()
    await nextTick()

    const input = activeInlineInput()!
    // 模拟在 input 上点(mousedown / pointerdown,目标就是 input)
    input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await flushPromises()

    expect(writeTextFile).not.toHaveBeenCalled()
    expect(activeInlineRow()).toBeTruthy()
    wrapper.unmount()
  })

  it('行内编辑:右键菜单打开 → 自动取消行内编辑', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    await openContextMenuOnRow(wrapper, 'note.md')
    const newFileBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('新建文件')) as HTMLButtonElement
    await newFileBtn.click()
    await nextTick()
    expect(activeInlineRow()).toBeTruthy()

    // 再右键同一行 → 应当取消行内编辑 + 打开菜单
    const row = findRowByName(wrapper, 'note.md')!
    triggerContextMenu(row)
    await nextTick()
    expect(activeInlineRow()).toBeFalsy()
    expect(document.body.querySelector('[data-tree-context-menu]')).toBeTruthy()
    wrapper.unmount()
  })

  // ── 容器空白处右键 → 根目录上下文菜单(v0.5.1) ──

  it('容器空白处右键 → 菜单显示 2 项(仅新建,无 重命名 / 删除 / reveal)', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false)])
    // 容器空白 = FileTree 根 div 内"min-h-0 flex-1 ..."的滚动容器 div,@contextmenu.self 在它上
    // findAll('div').filter 找有 @drop.self 标记的可能脆;直接在 row 之外的 listing 容器派发
    const container = wrapper.find('[class*="overflow-y-auto"]').element as HTMLElement
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 })
    container.dispatchEvent(ev)
    await nextTick()

    const menu = document.body.querySelector('[data-tree-context-menu]')
    expect(menu).toBeTruthy()
    const items = menu!.querySelectorAll('button')
    // 仅"新建文件" + "新建文件夹"
    expect(items.length).toBe(2)
    expect(items[0].textContent).toContain('新建文件')
    expect(items[1].textContent).toContain('新建文件夹')
    wrapper.unmount()
  })

  it('容器空白处右键 → 「新建文件」在工作区根目录创建', async () => {
    const wrapper = await mountWithEntries([entry('sub', true)])
    const container = wrapper.find('[class*="overflow-y-auto"]').element as HTMLElement
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 })
    container.dispatchEvent(ev)
    await nextTick()

    const newFileBtn = Array.from(document.body.querySelectorAll('[data-tree-context-menu] button'))
      .find(b => b.textContent?.includes('新建文件')) as HTMLButtonElement
    await newFileBtn.click()
    await nextTick()

    const input = activeInlineInput()!
    input.value = 'rootfile'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flushPromises()

    expect(writeTextFile).toHaveBeenCalledWith('/test/root/rootfile.md', '')
    wrapper.unmount()
  })

  // ── 展开箭头隐藏:空目录(v0.5.1) ──

  it('已加载且为空的子目录 → 不显示展开箭头(避免误导用户可展开)', async () => {
    // 根 = sub(目录) + note.md(过滤后剩 sub),并先展开 sub → readDir 返回空。
    // 期望:sub row 的箭头 SVG 不渲染(空目录无可展开内容)。
    const workspace = useWorkspaceStore()
    workspace.activeRoot = '/test/root'
    workspace.setDirExpanded('/test/root/sub', true)
    vi.mocked(readDir).mockImplementation(async (p) => {
      const path = typeof p === 'string' ? p : p.toString()
      if (path === '/test/root') return [entry('sub', true)]
      if (path === '/test/root/sub') return []
      return []
    })

    const wrapper = mount(FileTree, { attachTo: document.body })
    await flushPromises()
    await nextTick()
    await flushPromises()
    await nextTick()

    const subRow = findRowByName(wrapper, 'sub')!
    // 空目录(children = []) → 箭头 SVG 缺席;
    // 占位 span 仍在(留出对齐空间),但不含 SVG。
    const arrowSvgs = subRow.element.querySelectorAll('span.size-4 > svg')
    expect(arrowSvgs.length).toBe(0)
    wrapper.unmount()
  })

  // ── v0.5.1 根节点纳入树 ──
  //
  // 之前根目录显示成 FileTree 顶部独立 label(不在树里),v0.5.1 改为 flatItems 第一行,
  // 可右键(走 rootContext 菜单)。其他子节点的行为完全没变。

  it('根节点作为 flatItems 第一行渲染(.group, 显示 workspace basename)', async () => {
    const wrapper = await mountWithEntries([entry('a.md', false)])
    const rows = wrapper.findAll('.group')
    // 根 row + a.md = 2
    expect(rows.length).toBe(2)
    // 根 row 排第一,text 含 workspace basename ("root")
    expect(rows[0].text()).toContain('root')
    expect(rows[0].attributes('title')).toBe('/test/root')
    wrapper.unmount()
  })

  it('右键根节点 → 根上下文菜单(2 项:新建文件 / 新建文件夹)', async () => {
    const wrapper = await mountWithEntries([entry('a.md', false)])
    const rows = wrapper.findAll('.group')
    const rootRow = rows[0]
    triggerContextMenu(rootRow)
    await nextTick()

    const menu = document.body.querySelector('[data-tree-context-menu]')
    expect(menu).toBeTruthy()
    const items = menu!.querySelectorAll('button')
    expect(items.length).toBe(2)
    expect(items[0].textContent).toContain('新建文件')
    expect(items[1].textContent).toContain('新建文件夹')
    wrapper.unmount()
  })

  it('点根节点 → 折叠 / 再点 → 展开(根可折叠,v0.5.1)', async () => {
    const wrapper = await mountWithEntries([entry('a.md', false)])
    // 默认展开:根 row + a.md = 2
    expect(wrapper.findAll('.group').length).toBe(2)

    const rootRow = wrapper.findAll('.group')[0]
    await rootRow.trigger('click')
    await flushPromises()
    // 折叠后:只剩根 row,a.md 不再渲染
    expect(wrapper.findAll('.group').length).toBe(1)

    await rootRow.trigger('click')
    await flushPromises()
    // 再次展开:回到 2 行
    expect(wrapper.findAll('.group').length).toBe(2)
    wrapper.unmount()
  })

  it('根节点 row 始终显示展开箭头,默认展开(rotate-90)', async () => {
    // workspace 是空目录(根 children = []),箭头仍要显示 —— 根永远是目录,
    // 保留 expand affordance(子目录加载后为空才隐藏箭头,根例外)
    const wrapper = await mountWithEntries([])
    const rootRow = wrapper.findAll('.group')[0]
    const arrowSvg = rootRow.element.querySelector('span.size-4 > svg')
    expect(arrowSvg).toBeTruthy()
    expect(arrowSvg!.classList.contains('rotate-90')).toBe(true)
    wrapper.unmount()
  })

  it('根折叠态:箭头无 rotate-90 + 子项不渲染 + "空目录"占位也收起', async () => {
    const wrapper = await mountWithEntries([])
    // 默认展开,"空目录"占位渲染
    expect(wrapper.text()).toContain('空目录')

    const rootRow = wrapper.findAll('.group')[0]
    await rootRow.trigger('click')
    await flushPromises()

    const arrowSvg = rootRow.element.querySelector('span.size-4 > svg')!
    expect(arrowSvg.classList.contains('rotate-90')).toBe(false)
    // 折叠态:"空目录"占位也跟着收起
    expect(wrapper.text()).not.toContain('空目录')
    wrapper.unmount()
  })

  // ── 1 级"空目录"探测(v0.5.1) ──

  it('父目录加载后会后台探测每个子目录是否为空 → 空子目录箭头立即隐藏', async () => {
    // 根 = [empty/, hasItems/];empty/ readDir → [];hasItems/ readDir → [note.md]。
    // 探测完成后:empty row 无箭头;hasItems row 有箭头(因为未加载,默认显示)。
    const workspace = useWorkspaceStore()
    workspace.activeRoot = '/test/root'
    vi.mocked(readDir).mockImplementation(async (p) => {
      const path = typeof p === 'string' ? p : p.toString()
      if (path === '/test/root') return [entry('empty', true), entry('hasItems', true)]
      if (path === '/test/root/empty') return []
      if (path === '/test/root/hasItems') return [entry('note.md', false)]
      return []
    })

    const wrapper = mount(FileTree, { attachTo: document.body })
    await flushPromises()
    await nextTick()
    // 探测是 fire-and-forget,再 flush 一轮等 readDir promise resolve + 模板重渲
    await flushPromises()
    await nextTick()

    const emptyRow = findRowByName(wrapper, 'empty')!
    const hasItemsRow = findRowByName(wrapper, 'hasItems')!

    expect(emptyRow.element.querySelectorAll('span.size-4 > svg').length).toBe(0) // 探测发现空 → 无箭头
    expect(hasItemsRow.element.querySelectorAll('span.size-4 > svg').length).toBe(1) // 有 child → 箭头保留
    wrapper.unmount()
  })

  // ── 复制 / 粘贴(v0.5.x) ──

  it('点击「复制」→ 剪贴板记录源路径(菜单「粘贴」随后可见)', async () => {
    const wrapper = await mountWithEntries([entry('note.md', false), entry('other.md', false)])
    // 初始:菜单无「粘贴」(clipboard 空)
    let menu = await openContextMenuOnRow(wrapper, 'other.md')
    expect(Array.from(menu.querySelectorAll('button')).some(b => b.textContent?.includes('粘贴'))).toBe(false)

    // 右键 note.md → 复制
    menu = await openContextMenuOnRow(wrapper, 'note.md')
    const copyBtn = Array.from(menu.querySelectorAll('button'))
      .find(b => b.textContent?.includes('复制')) as HTMLButtonElement
    expect(copyBtn).toBeTruthy()
    await copyBtn.click()
    await nextTick()

    // 再右键 other.md → 菜单出现「粘贴」
    menu = await openContextMenuOnRow(wrapper, 'other.md')
    const pasteBtn = Array.from(menu.querySelectorAll('button'))
      .find(b => b.textContent?.includes('粘贴')) as HTMLButtonElement
    expect(pasteBtn).toBeTruthy()
    wrapper.unmount()
  })

  // 展开目录(走真实路径:点击展开箭头,让 loadDirChildren 跑起来)。
  async function expandDir(wrapper: ReturnType<typeof mount>, dirName: string) {
    const row = findRowByName(wrapper, dirName)!
    await row.trigger('click')
    await flushPromises()
    await nextTick()
    await flushPromises()
    await nextTick()
  }

  /** 手动挂载:先设 readDir mock 实现(path 分发),再 mount;避免 mountWithEntries 的 mockResolvedValue 覆盖。 */
  async function mountWithDirImpl(rootEntries: DirEntry[], dirImpl: (path: string) => DirEntry[]): Promise<ReturnType<typeof mount>> {
    const workspace = useWorkspaceStore()
    workspace.activeRoot = '/test/root'
    vi.mocked(readDir).mockImplementation(async (p: unknown) => {
      const path = typeof p === 'string' ? p : p?.toString() ?? ''
      if (path === '/test/root') return rootEntries
      return dirImpl(path)
    })
    const w = mount(FileTree, { attachTo: document.body })
    await flushPromises()
    await nextTick()
    return w
  }

  it('复制文件 → 粘贴到兄弟目录 → fs.copyFile 调用 + 刷新目标', async () => {
    const w = await mountWithDirImpl(
      [entry('a.md', false), entry('sub', true)],
      () => [],
    )
    await expandDir(w, 'sub')

    // 复制根级 a.md(用 title 精确匹配,避免误中 sub 下的同名文件)
    let menu = await openContextMenuOnRowEl(findRowByTitle(w, '/test/root/a.md'))
    const copyBtn = Array.from(menu.querySelectorAll('button'))
      .find(b => b.textContent?.includes('复制')) as HTMLButtonElement
    await copyBtn.click()
    await nextTick()

    // 右键 sub 目录 → 粘贴
    menu = await openContextMenuOnRow(w, 'sub')
    const pasteBtn = Array.from(menu.querySelectorAll('button'))
      .find(b => b.textContent?.includes('粘贴')) as HTMLButtonElement
    expect(pasteBtn).toBeTruthy()
    await pasteBtn.click()
    await flushPromises()

    expect(copyFile).toHaveBeenCalledWith('/test/root/a.md', '/test/root/sub/a.md')
    w.unmount()
  })

  it('粘贴时目标已有同名项 → uniqueName 自动重命名(加" 副本")', async () => {
    const w = await mountWithDirImpl(
      [entry('a.md', false), entry('sub', true)],
      (path) => path === '/test/root/sub' ? [entry('a.md', false)] : [],
    )
    await expandDir(w, 'sub')

    let menu = await openContextMenuOnRowEl(findRowByTitle(w, '/test/root/a.md'))
    const copyBtn = Array.from(menu.querySelectorAll('button'))
      .find(b => b.textContent?.includes('复制')) as HTMLButtonElement
    await copyBtn.click()
    await nextTick()

    menu = await openContextMenuOnRow(w, 'sub')
    const pasteBtn = Array.from(menu.querySelectorAll('button'))
      .find(b => b.textContent?.includes('粘贴')) as HTMLButtonElement
    await pasteBtn.click()
    await flushPromises()

    expect(copyFile).toHaveBeenCalledWith('/test/root/a.md', '/test/root/sub/a 副本.md')
    w.unmount()
  })

  it('粘贴目录到自身子目录 → 拒绝 + 弹 warning(message)', async () => {
    const w = await mountWithDirImpl(
      [entry('parent', true)],
      (path) => path === '/test/root/parent' ? [entry('child', true)] : [],
    )
    await expandDir(w, 'parent')

    // 复制 parent
    let menu = await openContextMenuOnRow(w, 'parent')
    const copyBtn = Array.from(menu.querySelectorAll('button'))
      .find(b => b.textContent?.includes('复制')) as HTMLButtonElement
    await copyBtn.click()
    await nextTick()

    // 右键 child → 粘贴
    menu = await openContextMenuOnRow(w, 'child')
    const pasteBtn = Array.from(menu.querySelectorAll('button'))
      .find(b => b.textContent?.includes('粘贴')) as HTMLButtonElement
    await pasteBtn.click()
    await flushPromises()

    expect(copyFile).not.toHaveBeenCalled()
    expect(message).toHaveBeenCalledWith(
      '不能将目录粘贴到自身或其子目录',
      expect.objectContaining({ title: '粘贴失败', kind: 'warning' }),
    )
    w.unmount()
  })

  it('根节点右键无「复制」,容器空白处右键无「复制」', async () => {
    const wrapper = await mountWithEntries([entry('a.md', false)])
    // 根节点右键
    const rootRow = wrapper.findAll('.group')[0]
    triggerContextMenu(rootRow)
    await nextTick()
    let menu = document.body.querySelector('[data-tree-context-menu]')!
    expect(Array.from(menu.querySelectorAll('button')).some(b => b.textContent?.includes('复制'))).toBe(false)

    // 容器空白处右键
    const container = wrapper.find('[class*="overflow-y-auto"]').element as HTMLElement
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 })
    container.dispatchEvent(ev)
    await nextTick()
    menu = document.body.querySelector('[data-tree-context-menu]')!
    expect(Array.from(menu.querySelectorAll('button')).some(b => b.textContent?.includes('复制'))).toBe(false)
    wrapper.unmount()
  })
})
