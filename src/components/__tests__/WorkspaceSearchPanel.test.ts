import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import WorkspaceSearchPanel from '../WorkspaceSearchPanel.vue'
import { searchWorkspaceMarkdown, type WorkspaceSearchGroup, type WorkspaceSearchProgress } from '@/utils/workspaceSearch'

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

function mountPanel(props: { root: string | null, initialQuery?: string }) {
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

  it('ArrowDown/Enter 选中并 emit open-result', async () => {
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

    await input.trigger('keydown', { key: 'ArrowDown' })
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
    expect(searchWorkspaceMarkdown).toHaveBeenLastCalledWith('/ws', 'old', expect.anything(), expect.anything(), expect.anything())

    // 模拟 Ctrl+Shift+F 触发:App.vue 改写 initialQuery 透传过来
    await wrapper.setProps({ initialQuery: 'fromSelection' })
    await flushTimers()

    const updatedInput = wrapper.find('[data-testid="workspace-search-input"]')
    expect((updatedInput.element as HTMLInputElement).value).toBe('fromSelection')
    // 搜索用新 query 重新跑
    expect(searchWorkspaceMarkdown).toHaveBeenLastCalledWith('/ws', 'fromSelection', expect.anything(), expect.anything(), expect.anything())
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

    // 默认 selectedFlatIndex = 0 → 第一条 inline style 主色底
    const firstHit = wrapper.find('[data-testid="workspace-search-hit-0-0"]')
    const secondHit = wrapper.find('[data-testid="workspace-search-hit-0-1"]')
    expect(firstHit.classes()).not.toContain('velo-ws-hovered')
    expect(firstHit.attributes('style') ?? '').toContain('--md-primary-color')

    // hover 第二条:selectedFlatIndex 不变(仍 0),hoveredFlatIndex = 1
    await secondHit.trigger('mouseenter')
    expect(firstHit.classes()).not.toContain('velo-ws-hovered')
    expect(secondHit.classes()).toContain('velo-ws-hovered')
    // 第一条仍 selected 主色底 → inline style 保留
    expect(firstHit.attributes('style') ?? '').toContain('--md-primary-color')
    // 第二条没被 selected → 无 inline style,hover 走 .velo-ws-hovered class
    expect(secondHit.attributes('style') ?? '').not.toContain('--md-primary-color')

    // mouseleave 第二条:hoveredFlatIndex = null,class 移除
    await secondHit.trigger('mouseleave')
    expect(secondHit.classes()).not.toContain('velo-ws-hovered')
    // 第一条 selected 仍保留
    expect(firstHit.attributes('style') ?? '').toContain('--md-primary-color')
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

    // 默认 selectedFlatIndex = 0 → 第一条主色底
    expect(firstHit.attributes('style') ?? '').toContain('--md-primary-color')
    expect(secondHit.attributes('style') ?? '').not.toContain('--md-primary-color')

    // 点击第二条:emit open-result,selectedFlatIndex 推到 1
    await secondHit.trigger('click')
    const emitted = wrapper.emitted('open-result')
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toMatchObject({ id: 'second' })

    // selected 主色底移到第二条;第一条失去 selected
    expect(secondHit.attributes('style') ?? '').toContain('--md-primary-color')
    expect(firstHit.attributes('style') ?? '').not.toContain('--md-primary-color')

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
})
