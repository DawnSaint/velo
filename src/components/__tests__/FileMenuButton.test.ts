import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import FileMenuButton from '../FileMenuButton.vue'
import type { RecentFileEntry } from '@/stores/persistence'

// 与 TabContextMenu.test.ts 同款:产品里 <Teleport to="body"> 把菜单搬到
// body 顶层避开父级 overflow:hidden,测试里 stub Teleport 让 wrapper.find()
// 能直接定位到菜单节点(不关心 Teleport 行为,只验证条件渲染 / emit)。
function mountMenu(props: Partial<{
  isTauri: boolean
  exporting: boolean
  recentEntries: RecentFileEntry[]
  alwaysOnTop: boolean
  focusMode: boolean
  typewriterMode: boolean
  hasDocument: boolean
}> = {}) {
  return mount(FileMenuButton, {
    props: {
      isTauri: true,
      exporting: false,
      recentEntries: [],
      alwaysOnTop: false,
      focusMode: false,
      typewriterMode: false,
      hasDocument: true,
      ...props,
    },
    global: {
      stubs: { Teleport: true },
    },
  })
}

async function openMenu(wrapper: ReturnType<typeof mountMenu>) {
  await wrapper.get('[aria-label="文件"]').trigger('click')
  await wrapper.vm.$nextTick()
}

/** 同步到 recomputeMenuPos 内部两个 nextTick 都 resolve —— 位置算法需要等
 * menuRef DOM 节点存在后再读 getBoundingClientRect,否则 menuPos 是 stale。 */
async function openMenuAndWaitPosition(wrapper: ReturnType<typeof mountMenu>) {
  await wrapper.get('[aria-label="文件"]').trigger('click')
  await flushPromises()
  await wrapper.vm.$nextTick()
}

describe('FileMenuButton', () => {
  it('默认收起:仅渲染图标按钮', () => {
    const wrapper = mountMenu()

    expect(wrapper.find('[aria-label="文件"]').exists()).toBe(true)
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
  })

  it('打开后展示所有命令 + 快捷键', async () => {
    const wrapper = mountMenu({ isTauri: true })

    await openMenu(wrapper)

    for (const label of ['新建文件', '新窗口', '打开文件', '打开文件夹', '最近文件', '保存', '另存为', '导出', '格式化排版', '专注模式', '保持窗口最前']) {
      expect(wrapper.find(`[aria-label="${label}"]`).exists()).toBe(true)
    }
    for (const shortcut of ['Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+O', 'Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+Shift+E', 'Ctrl+Shift+L']) {
      expect(wrapper.text()).toContain(shortcut)
    }
  })

  it('点选普通条目后 emit 对应事件 + 自动关闭', async () => {
    const wrapper = mountMenu()

    await openMenu(wrapper)
    await wrapper.get('[aria-label="新建文件"]').trigger('click')
    expect(wrapper.emitted('new-doc')).toHaveLength(1)
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
  })

  it('非 Tauri 环境下隐藏「新窗口」', async () => {
    const wrapper = mountMenu({ isTauri: false })

    await openMenu(wrapper)

    expect(wrapper.find('[aria-label="新窗口"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="新建文件"]').exists()).toBe(true)
    // 非 Tauri 环境不显示窗口最前 toggle,但专注模式仍可用
    expect(wrapper.find('[aria-label="保持窗口最前"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="专注模式"]').exists()).toBe(true)
  })

  it('导出中时禁用「导出」', async () => {
    const wrapper = mountMenu({ exporting: true })

    await openMenu(wrapper)
    const button = wrapper.get('[aria-label="导出中…"]')

    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(wrapper.emitted('export')).toBeUndefined()
  })

  it('点击「保持窗口最前」emit toggle-always-on-top 并关闭', async () => {
    const wrapper = mountMenu({ alwaysOnTop: false })

    await openMenu(wrapper)
    await wrapper.get('[aria-label="保持窗口最前"]').trigger('click')

    expect(wrapper.emitted('toggle-always-on-top')).toHaveLength(1)
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
  })

  it('点击「专注模式」emit toggle-focus-mode 并关闭', async () => {
    const wrapper = mountMenu({ focusMode: false })

    await openMenu(wrapper)
    await wrapper.get('[aria-label="专注模式"]').trigger('click')

    expect(wrapper.emitted('toggle-focus-mode')).toHaveLength(1)
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
  })

  it('专注模式开启时菜单项显示勾选标记', async () => {
    const wrapper = mountMenu({ focusMode: true })

    await openMenu(wrapper)
    const item = wrapper.get('[aria-label="专注模式"]')
    // checked=true 时右侧显示 Check 图标(svg)代替 shortcut badge
    expect(item.find('svg').exists()).toBe(true)
    // 不再显示 F8 shortcut badge(checked 优先于 shortcut)
    expect(item.text()).not.toContain('F8')
  })

  it('「最近文件」条目右侧带 ChevronRight 子菜单提示', async () => {
    const wrapper = mountMenu()

    await openMenu(wrapper)
    const recent = wrapper.get('[aria-label="最近文件"]')

    expect(recent.attributes('aria-haspopup')).toBe('menu')
    // ChevronRight 是 lucide 的 svg,只要该行内嵌一个 svg 即可
    expect(recent.find('svg').exists()).toBe(true)
  })

  it('点「最近文件」展开右侧子菜单,展示最近文件列表', async () => {
    const wrapper = mountMenu({
      recentEntries: [
        { path: 'C:\\docs\\note.md', openedAt: 1 },
        { path: 'C:\\docs\\two.md', openedAt: 2 },
      ],
    })

    await openMenu(wrapper)
    await wrapper.get('[aria-label="最近文件"]').trigger('click')
    await wrapper.vm.$nextTick()

    // 出现两个 role=menu(主菜单 + 子菜单)
    expect(wrapper.findAll('[role="menu"]').length).toBeGreaterThanOrEqual(2)
    expect(wrapper.text()).toContain('note.md')
    expect(wrapper.text()).toContain('two.md')
  })

  it('子菜单点击具体文件 emit open-recent + 关闭全部', async () => {
    const wrapper = mountMenu({
      recentEntries: [{ path: 'C:\\docs\\note.md', openedAt: 1 }],
    })

    await openMenu(wrapper)
    await wrapper.get('[aria-label="最近文件"]').trigger('click')
    await wrapper.vm.$nextTick()

    await wrapper.get('[role="menuitem"][title="C:/docs/note.md"]').trigger('click')

    expect(wrapper.emitted('open-recent')).toEqual([['C:\\docs\\note.md']])
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
  })

  it('最近文件为空时显示空态', async () => {
    const wrapper = mountMenu({ recentEntries: [] })

    await openMenu(wrapper)
    await wrapper.get('[aria-label="最近文件"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('暂无最近文件')
  })

  it('再次点击「最近文件」收起已展开的子菜单', async () => {
    const wrapper = mountMenu({
      recentEntries: [{ path: 'C:\\docs\\note.md', openedAt: 1 }],
    })

    await openMenu(wrapper)
    // 第一次点击:展开子菜单
    await wrapper.get('[aria-label="最近文件"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('[role="menu"]').length).toBeGreaterThanOrEqual(2)

    // 第二次点击:收起子菜单,主菜单仍在
    await wrapper.get('[aria-label="最近文件"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('[role="menu"]').length).toBe(1)
    // 子菜单内容不再可见
    expect(wrapper.text()).not.toContain('note.md')
  })

  it('无活动文档时隐藏保存/另存为/导出/格式化排版', async () => {
    const wrapper = mountMenu({ hasDocument: false })

    await openMenu(wrapper)

    expect(wrapper.find('[aria-label="保存"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="另存为"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="导出"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="格式化排版"]').exists()).toBe(false)
    // 其他菜单项仍可用
    expect(wrapper.find('[aria-label="新建文件"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="最近文件"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="专注模式"]').exists()).toBe(true)
  })

  // 守住"向下展开"语义:主菜单从触发器正下方展开,x = trigger.left(左对齐),
  // y = trigger.bottom(贴按钮底)。jsdom 下 trigger 默认 (0,0) 宽高 0 →
  // left = 0,bottom = 0,故 left/top 都落在 <=1 内。断言守住"不偏移过大"。
  it('主菜单从触发器正下方展开(左对齐 + 贴按钮底)', async () => {
    const wrapper = mountMenu()

    await openMenuAndWaitPosition(wrapper)

    const menu = wrapper.find('[data-file-menu-panel="main"]')
    expect(menu.exists()).toBe(true)
    const style = menu.attributes('style') ?? ''
    // jsdom 下 trigger 默认 (0,0) 宽高 0;left = 0,bottom = 0。
    // 当前算法: x = rect.left(左对齐),y = rect.bottom(贴按钮底)。
    const left = Number((style.match(/left:\s*(\d+(?:\.\d+)?)px/) ?? [, '-1'])[1])
    const top = Number((style.match(/top:\s*(\d+(?:\.\d+)?)px/) ?? [, '-1'])[1])
    expect(left).toBeLessThanOrEqual(1)
    expect(top).toBeLessThanOrEqual(1)
  })
})