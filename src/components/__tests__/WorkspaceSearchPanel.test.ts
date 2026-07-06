import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import WorkspaceSearchPanel from '../WorkspaceSearchPanel.vue'
import { searchWorkspaceMarkdown, type WorkspaceSearchGroup, type WorkspaceSearchHit, type WorkspaceSearchProgress } from '@/utils/workspaceSearch'

vi.mock('@/utils/workspaceSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/workspaceSearch')>()
  return {
    ...actual,
    searchWorkspaceMarkdown: vi.fn(),
  }
})

const baseProgress: WorkspaceSearchProgress = {
  phase: 'done',
  dirsScanned: 1,
  filesFound: 1,
  filesSearched: 1,
  hits: 1,
}

const groups: WorkspaceSearchGroup[] = [{
  file: { fullPath: '/ws/a.md', name: 'a.md', relPath: 'a.md' },
  hits: [{
    id: '/ws/a.md:2:6:0',
    fullPath: '/ws/a.md',
    relPath: 'a.md',
    fileName: 'a.md',
    lineNumber: 2,
    lineText: 'hello needle world',
    matchStartInLine: 6,
    matchEndInLine: 12,
    rawFrom: 12,
    rawTo: 18,
    matchText: 'needle',
    matchOrdinal: 0,
    fileMatchCount: 1,
    query: 'needle',
    options: { caseSensitive: false, wholeWord: false, regex: false },
  }],
}]

async function flushTimers() {
  await nextTick()
  vi.advanceTimersByTime(260)
  await Promise.resolve()
  await nextTick()
}

function mountPanel(props: { root: string | null, initialQuery?: string, scopeDir?: string | null, replaceStatus?: string, rerunToken?: number }) {
  return mount(WorkspaceSearchPanel, {
    props,
    attachTo: document.body,
  })
}

describe('WorkspaceSearchPanel', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    vi.mocked(searchWorkspaceMarkdown).mockImplementation(async (_root, _query, _options, _controller, callbacks) => {
      callbacks?.onProgress?.({ phase: 'searching', dirsScanned: 1, filesFound: 1, filesSearched: 0, hits: 0 })
      callbacks?.onGroups?.(groups)
      callbacks?.onProgress?.(baseProgress)
      return { groups, progress: baseProgress }
    })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('挂载后 focus 输入框', async () => {
    wrapper = mountPanel({ root: '/ws' })
    await nextTick()

    expect(document.activeElement).toBe(wrapper.find('[data-testid="workspace-search-input"]').element)
  })

  it('空 query 不触发搜索', async () => {
    wrapper = mountPanel({ root: '/ws' })
    await flushTimers()

    expect(searchWorkspaceMarkdown).not.toHaveBeenCalled()
    // 空 query 走"不渲染空态文字"语义(v0.6.x):面板只露输入框,无引导文案
    expect(wrapper.text()).not.toContain('输入关键词搜索工作区 .md')
  })

  it('无工作区时显示"请先打开一个工作区"', async () => {
    wrapper = mountPanel({ root: null })
    await nextTick()

    expect(wrapper.text()).toContain('请先打开一个工作区')
  })

  it('debounce 后渲染按文件分组的命中行', async () => {
    wrapper = mountPanel({ root: '/ws' })
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()

    expect(searchWorkspaceMarkdown).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('a.md')
    expect(wrapper.text()).toContain('hello needle world')
    expect(wrapper.text()).not.toContain('line before')
    // 行内命中段改用 .velo-find-match(与 FindReplace 高亮同款样式),
    // 不再渲染行号与 <mark> 元素
    expect(wrapper.find('.velo-find-match').text()).toBe('needle')
  })

  it('初始不自动选中条目;ArrowDown 从 null 落到第一条,再 ArrowDown 到第二条,Enter 打开', async () => {
    const moreGroups: WorkspaceSearchGroup[] = [{
      ...groups[0],
      hits: [
        groups[0].hits[0],
        { ...groups[0].hits[0], id: 'second', lineNumber: 3, lineText: 'second needle', rawFrom: 20, rawTo: 26, matchOrdinal: 1, fileMatchCount: 2 },
      ],
    }]
    vi.mocked(searchWorkspaceMarkdown).mockImplementation(async (_root, _query, _options, _controller, callbacks) => {
      callbacks?.onGroups?.(moreGroups)
      callbacks?.onProgress?.({ ...baseProgress, hits: 2 })
      return { groups: moreGroups, progress: { ...baseProgress, hits: 2 } }
    })
    wrapper = mountPanel({ root: '/ws' })
    const input = wrapper.find('[data-testid="workspace-search-input"]')
    await input.setValue('needle')
    await flushTimers()

    // 初始:没有任何条目被 selected(无主色底)
    const firstHit = wrapper.find('[data-testid="workspace-search-hit-0-0"]')
    const secondHit = wrapper.find('[data-testid="workspace-search-hit-0-1"]')
    expect((firstHit.attributes('style') ?? '')).not.toContain('--md-primary-color')
    expect((secondHit.attributes('style') ?? '')).not.toContain('--md-primary-color')

    // ArrowDown 从 null 落到第一条 → 第一条变 selected
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(firstHit.attributes('style') ?? '').toContain('--md-primary-color')
    expect((secondHit.attributes('style') ?? '')).not.toContain('--md-primary-color')

    // 再 ArrowDown → 跳到第二条
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect((firstHit.attributes('style') ?? '')).not.toContain('--md-primary-color')
    expect(secondHit.attributes('style') ?? '').toContain('--md-primary-color')

    // Enter 打开当前选中(第二条)
    await input.trigger('keydown', { key: 'Enter' })
    const emitted = wrapper.emitted('open-result')
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toMatchObject({ id: 'second' })
  })

  it('ArrowUp 从 null 落到最后一条', async () => {
    const moreGroups: WorkspaceSearchGroup[] = [{
      ...groups[0],
      hits: [
        groups[0].hits[0],
        { ...groups[0].hits[0], id: 'second', lineNumber: 3, lineText: 'second needle', rawFrom: 20, rawTo: 26, matchOrdinal: 1, fileMatchCount: 2 },
      ],
    }]
    vi.mocked(searchWorkspaceMarkdown).mockImplementation(async (_root, _query, _options, _controller, callbacks) => {
      callbacks?.onGroups?.(moreGroups)
      callbacks?.onProgress?.({ ...baseProgress, hits: 2 })
      return { groups: moreGroups, progress: { ...baseProgress, hits: 2 } }
    })
    wrapper = mountPanel({ root: '/ws' })
    const input = wrapper.find('[data-testid="workspace-search-input"]')
    await input.setValue('needle')
    await flushTimers()

    // ArrowUp 从 null 应落到最后一条(第二条),而不是模 n 落到第一条
    await input.trigger('keydown', { key: 'ArrowUp' })
    await input.trigger('keydown', { key: 'Enter' })

    const emitted = wrapper.emitted('open-result')
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toMatchObject({ id: 'second' })
  })

  it('Esc emit update:open=false 让父级收起侧栏', async () => {
    wrapper = mountPanel({ root: '/ws' })

    await wrapper.find('[data-testid="workspace-search-input"]').trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })

  it('initialQuery 变化时(Ctrl+Shift+F 改写)把内容写进搜索框并触发搜索', async () => {
    wrapper = mountPanel({ root: '/ws' })
    await nextTick()

    // 用户先在编辑器选区外随便输入一个词
    const input = wrapper.find('[data-testid="workspace-search-input"]')
    await input.setValue('old')
    await flushTimers()
    expect(searchWorkspaceMarkdown).toHaveBeenLastCalledWith('/ws', 'old', expect.anything(), expect.anything(), expect.anything(), null)

    // 模拟 Ctrl+Shift+F 触发:App.vue 改写 initialQuery 透传过来
    await wrapper.setProps({ initialQuery: 'fromSelection' })
    await flushTimers()

    const updatedInput = wrapper.find('[data-testid="workspace-search-input"]')
    expect((updatedInput.element as HTMLInputElement).value).toBe('fromSelection')
    // 搜索用新 query 重新跑
    expect(searchWorkspaceMarkdown).toHaveBeenLastCalledWith('/ws', 'fromSelection', expect.anything(), expect.anything(), expect.anything(), null)
  })

  it('mouseenter/mouseleave 切 hoveredFlatIndex,不影响 selectedFlatIndex', async () => {
    const moreGroups: WorkspaceSearchGroup[] = [{
      ...groups[0],
      hits: [
        groups[0].hits[0],
        { ...groups[0].hits[0], id: 'second', lineNumber: 3, lineText: 'second needle', rawFrom: 20, rawTo: 26, matchOrdinal: 1, fileMatchCount: 2 },
      ],
    }]
    vi.mocked(searchWorkspaceMarkdown).mockImplementation(async (_root, _query, _options, _controller, callbacks) => {
      callbacks?.onGroups?.(moreGroups)
      callbacks?.onProgress?.({ ...baseProgress, hits: 2 })
      return { groups: moreGroups, progress: { ...baseProgress, hits: 2 } }
    })
    wrapper = mountPanel({ root: '/ws' })
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()

    // v0.6.x:默认无选中 —— 没有 hit 有主色底
    const firstHit = wrapper.find('[data-testid="workspace-search-hit-0-0"]')
    const secondHit = wrapper.find('[data-testid="workspace-search-hit-0-1"]')
    expect(firstHit.classes()).not.toContain('velo-ws-hovered')
    expect((firstHit.attributes('style') ?? '')).not.toContain('--md-primary-color')
    expect((secondHit.attributes('style') ?? '')).not.toContain('--md-primary-color')

    // hover 第二条:selectedFlatIndex 不变(仍 null),hoveredFlatIndex = 1
    await secondHit.trigger('mouseenter')
    expect(firstHit.classes()).not.toContain('velo-ws-hovered')
    expect(secondHit.classes()).toContain('velo-ws-hovered')
    // 两条都没被 selected(用户没按 ArrowDown/Click) → 无 inline style
    expect((firstHit.attributes('style') ?? '')).not.toContain('--md-primary-color')
    expect((secondHit.attributes('style') ?? '')).not.toContain('--md-primary-color')

    // mouseleave 第二条:hoveredFlatIndex = null,class 移除
    await secondHit.trigger('mouseleave')
    expect(secondHit.classes()).not.toContain('velo-ws-hovered')
    expect((firstHit.attributes('style') ?? '')).not.toContain('--md-primary-color')
  })

  it('click 把 selectedFlatIndex 推到被点击条目,并 emit open-result', async () => {
    const moreGroups: WorkspaceSearchGroup[] = [{
      ...groups[0],
      hits: [
        groups[0].hits[0],
        { ...groups[0].hits[0], id: 'second', lineNumber: 3, lineText: 'second needle', rawFrom: 20, rawTo: 26, matchOrdinal: 1, fileMatchCount: 2 },
      ],
    }]
    vi.mocked(searchWorkspaceMarkdown).mockImplementation(async (_root, _query, _options, _controller, callbacks) => {
      callbacks?.onGroups?.(moreGroups)
      callbacks?.onProgress?.({ ...baseProgress, hits: 2 })
      return { groups: moreGroups, progress: { ...baseProgress, hits: 2 } }
    })
    wrapper = mountPanel({ root: '/ws' })
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()

    const firstHit = wrapper.find('[data-testid="workspace-search-hit-0-0"]')
    const secondHit = wrapper.find('[data-testid="workspace-search-hit-0-1"]')

    // v0.6.x:默认无选中 —— 两条 hit 都无主色底
    expect((firstHit.attributes('style') ?? '')).not.toContain('--md-primary-color')
    expect((secondHit.attributes('style') ?? '')).not.toContain('--md-primary-color')

    // 点击第二条:emit open-result,selectedFlatIndex 推到 1
    await secondHit.trigger('click')
    const emitted = wrapper.emitted('open-result')
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toMatchObject({ id: 'second' })

    // selected 主色底移到第二条;第一条失去 selected
    expect(secondHit.attributes('style') ?? '').toContain('--md-primary-color')
    expect((firstHit.attributes('style') ?? '')).not.toContain('--md-primary-color')

    // 后续 Enter 仍打开被点击的条目(selectedFlatIndex = 1 保留)
    const input = wrapper.find('[data-testid="workspace-search-input"]')
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('open-result')).toHaveLength(2)
    expect(wrapper.emitted('open-result')![1][0]).toMatchObject({ id: 'second' })
  })

  it('Stop 取消但保留已有结果', async () => {
    vi.mocked(searchWorkspaceMarkdown).mockImplementation(async (_root, _query, _options, _controller, callbacks) => {
      callbacks?.onProgress?.({ phase: 'searching', dirsScanned: 1, filesFound: 2, filesSearched: 1, hits: 1 })
      callbacks?.onGroups?.(groups)
      return { groups, progress: { phase: 'canceled', dirsScanned: 1, filesFound: 2, filesSearched: 1, hits: 1 } }
    })
    wrapper = mountPanel({ root: '/ws' })
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()

    await wrapper.find('[data-testid="workspace-search-stop"]').trigger('click')

    expect(wrapper.text()).toContain('hello needle world')
    expect(wrapper.text()).toContain('已停止')
  })

  // ============ v0.6.0 替换 + scope ============

  it('chevron 切换显示替换行', async () => {
    wrapper = mountPanel({ root: '/ws' })
    await nextTick()

    // 默认折叠
    expect(wrapper.find('[data-testid="workspace-search-replacement"]').exists()).toBe(false)

    await wrapper.find('[data-testid="workspace-search-toggle-replace"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-search-replacement"]').exists()).toBe(true)

    // 再点收起
    await wrapper.find('[data-testid="workspace-search-toggle-replace"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-search-replacement"]').exists()).toBe(false)
  })

  it('「替换」按钮 emit apply-replace scope=one,带当前选中条目所在文件的所有 hit', async () => {
    const moreGroups: WorkspaceSearchGroup[] = [{
      ...groups[0],
      hits: [
        groups[0].hits[0],
        { ...groups[0].hits[0], id: 'second', lineNumber: 3, lineText: 'second needle', rawFrom: 20, rawTo: 26, matchOrdinal: 1, fileMatchCount: 2 },
      ],
    }]
    vi.mocked(searchWorkspaceMarkdown).mockImplementation(async (_root, _query, _options, _controller, callbacks) => {
      callbacks?.onGroups?.(moreGroups)
      callbacks?.onProgress?.({ ...baseProgress, hits: 2 })
      return { groups: moreGroups, progress: { ...baseProgress, hits: 2 } }
    })
    wrapper = mountPanel({ root: '/ws' })
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()
    // v0.6.x:无默认选中 —— 先 ArrowDown 选中一条 hit,scope='one' 才有目标
    await wrapper.find('[data-testid="workspace-search-input"]').trigger('keydown', { key: 'ArrowDown' })
    // 展开替换行
    await wrapper.find('[data-testid="workspace-search-toggle-replace"]').trigger('click')
    await wrapper.find('[data-testid="workspace-search-replacement"]').setValue('knife')

    await wrapper.find('[data-testid="workspace-search-replace-one"]').trigger('click')

    const emitted = wrapper.emitted('apply-replace') as Array<[{ hits: WorkspaceSearchHit[], replacement: string, scope: 'one' | 'all' }]>
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toMatchObject({
      replacement: 'knife',
      scope: 'one',
    })
    // scope=one 只携带当前选中所在 file 的所有 hit(本例两 hit 同文件 → 都带上)
    expect(emitted![0][0].hits).toHaveLength(2)
  })

  it('「全部替换」按钮 emit apply-replace scope=all,带所有 hit', async () => {
    vi.mocked(searchWorkspaceMarkdown).mockImplementation(async (_root, _query, _options, _controller, callbacks) => {
      callbacks?.onGroups?.(groups)
      callbacks?.onProgress?.(baseProgress)
      return { groups, progress: baseProgress }
    })
    wrapper = mountPanel({ root: '/ws' })
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()
    await wrapper.find('[data-testid="workspace-search-toggle-replace"]').trigger('click')
    await wrapper.find('[data-testid="workspace-search-replacement"]').setValue('knife')

    await wrapper.find('[data-testid="workspace-search-replace-all"]').trigger('click')

    const emitted = wrapper.emitted('apply-replace') as Array<[{ hits: WorkspaceSearchHit[], replacement: string, scope: 'one' | 'all' }]>
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toMatchObject({ replacement: 'knife', scope: 'all' })
    expect(emitted![0][0].hits).toHaveLength(1)
  })

  it('替换按钮在无结果 / 空 replacement / invalid regex 时 disabled', async () => {
    wrapper = mountPanel({ root: '/ws' })
    await nextTick()
    // 默认折叠,先展开替换行才能拿到按钮
    await wrapper.find('[data-testid="workspace-search-toggle-replace"]').trigger('click')
    await nextTick()

    // 无结果时:替换 / 全部替换 都应 disabled
    expect((wrapper.find('[data-testid="workspace-search-replace-one"]').element as HTMLButtonElement).disabled).toBe(true)
    expect((wrapper.find('[data-testid="workspace-search-replace-all"]').element as HTMLButtonElement).disabled).toBe(true)

    // 输入查询得到结果
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()

    // 空 replacement:替换 disabled(需要 replacement 非空),全部替换 enabled(replacement 可空)
    expect((wrapper.find('[data-testid="workspace-search-replace-one"]').element as HTMLButtonElement).disabled).toBe(true)
    expect((wrapper.find('[data-testid="workspace-search-replace-all"]').element as HTMLButtonElement).disabled).toBe(false)

    // 填 replacement:替换 enabled
    await wrapper.find('[data-testid="workspace-search-replacement"]').setValue('knife')
    expect((wrapper.find('[data-testid="workspace-search-replace-one"]').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('scopeDir prop 非 null 时显示 chip + 清除按钮 emit clear-scope', async () => {
    wrapper = mountPanel({ root: '/ws', scopeDir: '/ws/docs' })
    await nextTick()
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()

    expect(wrapper.find('[data-testid="workspace-search-scope-chip"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('docs')

    await wrapper.find('[data-testid="workspace-search-scope-clear"]').trigger('click')
    expect(wrapper.emitted('clear-scope')).toHaveLength(1)
  })

  it('scopeDir prop 变化时重新触发 searchWorkspaceMarkdown', async () => {
    wrapper = mountPanel({ root: '/ws' })
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()
    expect(searchWorkspaceMarkdown).toHaveBeenLastCalledWith('/ws', 'needle', expect.anything(), expect.anything(), expect.anything(), null)

    await wrapper.setProps({ scopeDir: '/ws/docs' })
    await flushTimers()
    expect(searchWorkspaceMarkdown).toHaveBeenLastCalledWith('/ws', 'needle', expect.anything(), expect.anything(), expect.anything(), '/ws/docs')
  })

  it('replaceStatus prop 显示一次性文案,优先于 statusText', async () => {
    wrapper = mountPanel({ root: '/ws' })
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()

    await wrapper.setProps({ replaceStatus: '已替换 5 处，2 个文件因有未保存修改被跳过' })
    expect(wrapper.find('[data-testid="workspace-search-replace-status"]').text()).toContain('已替换 5 处')
    expect(wrapper.find('[data-testid="workspace-search-replace-status"]').text()).toContain('跳过')

    // 清掉 replaceStatus 后回到常规 statusText
    await wrapper.setProps({ replaceStatus: '' })
    expect(wrapper.find('[data-testid="workspace-search-replace-status"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-search-status"]').exists()).toBe(true)
  })

  it('rerunToken prop 变化触发 scheduleSearch 重跑', async () => {
    wrapper = mountPanel({ root: '/ws' })
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()
    const before = vi.mocked(searchWorkspaceMarkdown).mock.calls.length

    await wrapper.setProps({ rerunToken: 1 })
    await flushTimers()
    expect(vi.mocked(searchWorkspaceMarkdown).mock.calls.length).toBeGreaterThan(before)
  })

  // ============ v0.6.x 文件分组折叠 ============

  it('点文件分组 header 折叠/展开,命中行随之隐藏/恢复', async () => {
    const moreGroups: WorkspaceSearchGroup[] = [{
      ...groups[0],
      hits: [
        groups[0].hits[0],
        { ...groups[0].hits[0], id: 'second', lineNumber: 3, lineText: 'second needle', rawFrom: 20, rawTo: 26, matchOrdinal: 1, fileMatchCount: 2 },
      ],
    }]
    vi.mocked(searchWorkspaceMarkdown).mockImplementation(async (_root, _query, _options, _controller, callbacks) => {
      callbacks?.onGroups?.(moreGroups)
      callbacks?.onProgress?.({ ...baseProgress, hits: 2 })
      return { groups: moreGroups, progress: { ...baseProgress, hits: 2 } }
    })
    wrapper = mountPanel({ root: '/ws' })
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()

    // 初始两条 hit 都在
    expect(wrapper.find('[data-testid="workspace-search-hit-0-0"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-search-hit-0-1"]').exists()).toBe(true)

    // 点 group header 折叠
    const header = wrapper.find('[data-testid="workspace-search-group-0"]')
    expect(header.exists()).toBe(true)
    expect(header.attributes('aria-expanded')).toBe('true')
    await header.trigger('click')

    // 折叠后 hit 行全部消失,header 保留 + aria-expanded=false
    expect(wrapper.find('[data-testid="workspace-search-group-0"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-search-group-0"]').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-testid="workspace-search-hit-0-0"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-search-hit-0-1"]').exists()).toBe(false)

    // 再点展开,hit 行回来
    await wrapper.find('[data-testid="workspace-search-group-0"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-search-group-0"]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-testid="workspace-search-hit-0-0"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-search-hit-0-1"]').exists()).toBe(true)
  })

  it('ArrowDown 跳过折叠中的文件分组的命中', async () => {
    // 两个文件分组,各 1 个 hit
    const twoGroups: WorkspaceSearchGroup[] = [
      { ...groups[0] },
      {
        file: { fullPath: '/ws/b.md', name: 'b.md', relPath: 'b.md' },
        hits: [{ ...groups[0].hits[0], id: '/ws/b.md:2:6:0', fullPath: '/ws/b.md', fileName: 'b.md', relPath: 'b.md' }],
      },
    ]
    vi.mocked(searchWorkspaceMarkdown).mockImplementation(async (_root, _query, _options, _controller, callbacks) => {
      callbacks?.onGroups?.(twoGroups)
      callbacks?.onProgress?.({ ...baseProgress, filesFound: 2, hits: 2 })
      return { groups: twoGroups, progress: { ...baseProgress, filesFound: 2, hits: 2 } }
    })
    wrapper = mountPanel({ root: '/ws' })
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()

    // 初始两条 hit 都在
    expect(wrapper.find('[data-testid="workspace-search-hit-0-0"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-search-hit-1-0"]').exists()).toBe(true)

    // 折叠第一个文件分组(a.md),b.md 的 hit 仍可见
    await wrapper.find('[data-testid="workspace-search-group-0"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-search-hit-0-0"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-search-hit-1-0"]').exists()).toBe(true)

    // 默认 selectedFlatIndex = 0,但 flatRows 折叠后只剩 1 条 → clamp 到 0 (b.md 的 hit)
    // ArrowDown + Enter 应打开 b.md 的 hit,不是已经被隐藏的 a.md
    const input = wrapper.find('[data-testid="workspace-search-input"]')
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter' })

    const emitted = wrapper.emitted('open-result')
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toMatchObject({ fullPath: '/ws/b.md' })

    // 展开 a.md,现在 flatRows 是 [a.md hit, b.md hit](原始 groups 顺序),
    // 再 ArrowDown 进入 b.md 的 hit(扁平索引 1)
    await wrapper.find('[data-testid="workspace-search-group-0"]').trigger('click')
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('open-result')).toHaveLength(2)
    expect(wrapper.emitted('open-result')![1][0]).toMatchObject({ fullPath: '/ws/b.md' })
  })

  it('折叠状态下替换仍按 file 聚合所有命中(scope=one 走 fullPath 过滤,不被折叠影响)', async () => {
    const moreGroups: WorkspaceSearchGroup[] = [{
      ...groups[0],
      hits: [
        groups[0].hits[0],
        { ...groups[0].hits[0], id: 'second', lineNumber: 3, lineText: 'second needle', rawFrom: 20, rawTo: 26, matchOrdinal: 1, fileMatchCount: 2 },
      ],
    }]
    vi.mocked(searchWorkspaceMarkdown).mockImplementation(async (_root, _query, _options, _controller, callbacks) => {
      callbacks?.onGroups?.(moreGroups)
      callbacks?.onProgress?.({ ...baseProgress, hits: 2 })
      return { groups: moreGroups, progress: { ...baseProgress, hits: 2 } }
    })
    wrapper = mountPanel({ root: '/ws' })
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()

    // 折叠该分组,所有 hit 行被隐藏
    await wrapper.find('[data-testid="workspace-search-group-0"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-search-hit-0-0"]').exists()).toBe(false)

    // 展开替换行 + 输入 replacement + 点"全部替换"
    await wrapper.find('[data-testid="workspace-search-toggle-replace"]').trigger('click')
    await wrapper.find('[data-testid="workspace-search-replacement"]').setValue('knife')
    await wrapper.find('[data-testid="workspace-search-replace-all"]').trigger('click')

    // 全部替换仍按文件聚合所有 hit,折叠态不影响 IO 语义
    const emitted = wrapper.emitted('apply-replace') as Array<[{ hits: WorkspaceSearchHit[], replacement: string, scope: 'one' | 'all' }]>
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toMatchObject({ replacement: 'knife', scope: 'all' })
    expect(emitted![0][0].hits).toHaveLength(2)
  })
})
