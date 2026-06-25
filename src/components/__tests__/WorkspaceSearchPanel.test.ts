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

function mountPanel(props: { open: boolean, root: string | null, initialQuery?: string }) {
  return mount(WorkspaceSearchPanel, {
    props,
    attachTo: document.body,
    global: { stubs: { Teleport: true } },
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

  it('打开后 focus 输入框', async () => {
    wrapper = mountPanel({ open: true, root: '/ws' })
    await nextTick()

    expect(document.activeElement).toBe(wrapper.find('[data-testid="workspace-search-input"]').element)
  })

  it('空 query 不触发搜索', async () => {
    wrapper = mountPanel({ open: true, root: '/ws' })
    await flushTimers()

    expect(searchWorkspaceMarkdown).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('输入关键词搜索工作区 .md')
  })

  it('debounce 后渲染按文件分组的命中行', async () => {
    wrapper = mountPanel({ open: true, root: '/ws' })
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()

    expect(searchWorkspaceMarkdown).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('a.md')
    expect(wrapper.text()).toContain('hello needle world')
    expect(wrapper.text()).not.toContain('line before')
    expect(wrapper.find('mark').text()).toBe('needle')
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
    wrapper = mountPanel({ open: true, root: '/ws' })
    const input = wrapper.find('[data-testid="workspace-search-input"]')
    await input.setValue('needle')
    await flushTimers()

    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter' })

    const emitted = wrapper.emitted('open-result')
    expect(emitted).toHaveLength(1)
    expect(emitted![0][0]).toMatchObject({ id: 'second' })
  })

  it('Esc 关闭并取消当前搜索', async () => {
    wrapper = mountPanel({ open: true, root: '/ws' })

    await wrapper.find('[data-testid="workspace-search-input"]').trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('update:open')?.[0]).toEqual([false])
  })

  it('Stop 取消但保留已有结果', async () => {
    vi.mocked(searchWorkspaceMarkdown).mockImplementation(async (_root, _query, _options, _controller, callbacks) => {
      callbacks?.onProgress?.({ phase: 'searching', dirsScanned: 1, filesFound: 2, filesSearched: 1, hits: 1 })
      callbacks?.onGroups?.(groups)
      return { groups, progress: { phase: 'canceled', dirsScanned: 1, filesFound: 2, filesSearched: 1, hits: 1 } }
    })
    wrapper = mountPanel({ open: true, root: '/ws' })
    await wrapper.find('[data-testid="workspace-search-input"]').setValue('needle')
    await flushTimers()

    await wrapper.find('[data-testid="workspace-search-stop"]').trigger('click')

    expect(wrapper.text()).toContain('hello needle world')
    expect(wrapper.text()).toContain('已停止')
  })
})
