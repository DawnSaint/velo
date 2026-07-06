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
  welcomeEnabled: boolean
  alwaysOnTop: boolean
}> = {}) {
  return mount(FileMenuButton, {
    props: {
      isTauri: true,
      exporting: false,
      recentEntries: [],
      welcomeEnabled: false,
      alwaysOnTop: false,
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

    for (const label of ['新建文件', '新窗口', '打开文件', '打开文件夹', '最近文件', '保存', '另存为', '导出', '保持窗口最前']) {
      expect(wrapper.find(`[aria-label="${label}"]`).exists()).toBe(true)
    }
    for (const shortcut of ['Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+O', 'Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+Shift+E']) {
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
    // 非 Tauri 环境也不显示窗口最前 toggle
    expect(wrapper.find('[aria-label="保持窗口最前"]').exists()).toBe(false)
  })

  it('导出中时禁用「导出」', async () => {
    const wrapper = mountMenu({ exporting: true })

    await openMenu(wrapper)
    const button = wrapper.get('[aria-label="导出中…"]')

    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(wrapper.emitted('export')).toBeUndefined()
  })

  it('默认不显示「欢迎对话框」入口,welcomeEnabled = true 时显示', async () => {
    const wrapperHidden = mountMenu({ welcomeEnabled: false })
    await openMenu(wrapperHidden)
    expect(wrapperHidden.find('[aria-label="欢迎对话框"]').exists()).toBe(false)

    const wrapperShown = mountMenu({ welcomeEnabled: true })
    await openMenu(wrapperShown)
    expect(wrapperShown.find('[aria-label="欢迎对话框"]').exists()).toBe(true)
  })

  it('点击「欢迎对话框」emit open-welcome 并关闭', async () => {
    const wrapper = mountMenu({ welcomeEnabled: true })

    await openMenu(wrapper)
    await wrapper.get('[aria-label="欢迎对话框"]').trigger('click')

    expect(wrapper.emitted('open-welcome')).toHaveLength(1)
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
  })

  it('点击「保持窗口最前」emit toggle-always-on-top 并关闭', async () => {
    const wrapper = mountMenu({ alwaysOnTop: false })

    await openMenu(wrapper)
    await wrapper.get('[aria-label="保持窗口最前"]').trigger('click')

    expect(wrapper.emitted('toggle-always-on-top')).toHaveLength(1)
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
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

  // 守住"右侧贴 border 展开"语义:主菜单位置 x = trigger.right(0 gap,
  // 与 ActivityBar 的 border-right 那条 1px 边线重合),y = trigger.top(贴顶)。
  // 旧版下方展开会得到 x = trigger.left(=0 jsdom 与新版同,无法区分),
  // y = trigger.bottom + 4(=4 jsdom) → 与新版 y=0 区分。
  // 早期横版 +4 gap 也会得到 x=4,与新版 x=0 区分,但仍非用户最终要的"贴 border"。
  it('主菜单左边界贴触发器右边界(0 gap,重合 ActivityBar border-right)且垂直贴顶', async () => {
    const wrapper = mountMenu()

    await openMenuAndWaitPosition(wrapper)

    const menu = wrapper.find('[data-file-menu-panel="main"]')
    expect(menu.exists()).toBe(true)
    const style = menu.attributes('style') ?? ''
    // jsdom 下 trigger 默认 (0,0) 宽 0;right = 0,top = 0。
    // 当前算法: x = rect.right(0 gap),y = rect.top(贴顶)。
    const left = Number((style.match(/left:\s*(\d+(?:\.\d+)?)px/) ?? [, '-1'])[1])
    const top = Number((style.match(/top:\s*(\d+(?:\.\d+)?)px/) ?? [, '-1'])[1])
    // x <= 1:0 gap(= rect.right = 0)。区分不开 +4 gap(= 4)与下方展开(= rect.left = 0),
    // 但后者会让 y 跑到 4,所以 y 这条断言已经够用;x 这条作为冗余 / 守住"不偏移过大"。
    expect(left).toBeLessThanOrEqual(1)
    // y <= 1:贴顶对齐 rect.top(=0)。**核心断言** —— 下方展开会得到 y = rect.bottom + 4 = 4,
    // 失败即旧版本逻辑被改回去了。
    expect(top).toBeLessThanOrEqual(1)
  })
})