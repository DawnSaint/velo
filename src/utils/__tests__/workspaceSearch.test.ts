import type { DirEntry } from '@tauri-apps/plugin-fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readDir, readTextFile } from '@tauri-apps/plugin-fs'
import { searchWorkspaceMarkdown, createWorkspaceSearchController, revealWorkspaceSearchMatch, __workspaceSearchTest, type WorkspaceSearchProgress } from '../workspaceSearch'

const defaultOptions = { caseSensitive: false, wholeWord: false, regex: false }

function dir(name: string): DirEntry {
  return { name, isDirectory: true, isFile: false, isSymlink: false }
}

function file(name: string): DirEntry {
  return { name, isDirectory: false, isFile: true, isSymlink: false }
}

describe('workspaceSearch', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('递归扫描 markdown 文件并跳过隐藏目录', async () => {
    vi.mocked(readDir).mockImplementation(async (path) => {
      const p = String(path)
      if (p === '/ws') return [dir('docs'), dir('.git'), file('README.md'), file('image.png')]
      if (p === '/ws/docs') return [file('guide.markdown'), file('note.txt')]
      if (p === '/ws/.git') return [file('hidden.md')]
      return []
    })
    vi.mocked(readTextFile).mockImplementation(async (path) => {
      const p = String(path)
      if (p.endsWith('README.md')) return 'hello root'
      if (p.endsWith('guide.markdown')) return 'nested hello'
      return 'hidden hello'
    })

    const result = await searchWorkspaceMarkdown('/ws', 'hello', defaultOptions)

    expect(result.groups.map(g => g.file.relPath)).toEqual(['README.md', 'docs/guide.markdown'])
    expect(readDir).not.toHaveBeenCalledWith('/ws/.git')
  })

  it('单个目录或文件读取失败不会终止整次搜索', async () => {
    vi.mocked(readDir).mockImplementation(async (path) => {
      const p = String(path)
      if (p === '/ws') return [dir('bad'), file('bad.md'), file('ok.md')]
      if (p === '/ws/bad') throw new Error('permission denied')
      return []
    })
    vi.mocked(readTextFile).mockImplementation(async (path) => {
      const p = String(path)
      if (p.endsWith('bad.md')) throw new Error('locked')
      return 'needle'
    })

    const result = await searchWorkspaceMarkdown('/ws', 'needle', defaultOptions)

    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].file.relPath).toBe('ok.md')
    expect(result.progress.phase).toBe('done')
  })

  it('普通文本匹配大小写默认不敏感,caseSensitive 时区分大小写', async () => {
    vi.mocked(readDir).mockResolvedValue([file('a.md')])
    vi.mocked(readTextFile).mockResolvedValue('Hello\nhello')

    const insensitive = await searchWorkspaceMarkdown('/ws', 'hello', defaultOptions)
    const sensitive = await searchWorkspaceMarkdown('/ws', 'hello', { ...defaultOptions, caseSensitive: true })

    expect(insensitive.progress.hits).toBe(2)
    expect(sensitive.progress.hits).toBe(1)
    expect(sensitive.groups[0].hits[0].lineText).toBe('hello')
  })

  it('wholeWord 只匹配完整单词', async () => {
    vi.mocked(readDir).mockResolvedValue([file('a.md')])
    vi.mocked(readTextFile).mockResolvedValue('cat scatter cat')

    const result = await searchWorkspaceMarkdown('/ws', 'cat', { ...defaultOptions, wholeWord: true })

    expect(result.progress.hits).toBe(2)
    expect(result.groups[0].hits.map(h => h.matchStartInLine)).toEqual([0, 12])
  })

  it('regex 模式沿用 buildPattern 语义', async () => {
    vi.mocked(readDir).mockResolvedValue([file('a.md')])
    vi.mocked(readTextFile).mockResolvedValue('id:123 id:abc')

    const result = await searchWorkspaceMarkdown('/ws', 'id:\\d+', { ...defaultOptions, regex: true })

    expect(result.progress.hits).toBe(1)
    expect(result.groups[0].hits[0].matchText).toBe('id:123')
  })

  it('invalid regex 不扫描文件', async () => {
    const result = await searchWorkspaceMarkdown('/ws', '[', { ...defaultOptions, regex: true })

    expect(result.progress.phase).toBe('error')
    expect(result.progress.error).toBe('正则表达式无效')
    expect(readDir).not.toHaveBeenCalled()
  })

  it('同一行多命中生成多条 hit 并保存 ordinal/count', async () => {
    vi.mocked(readDir).mockResolvedValue([file('a.md')])
    vi.mocked(readTextFile).mockResolvedValue('foo foo')

    const result = await searchWorkspaceMarkdown('/ws', 'foo', defaultOptions)

    const hits = result.groups[0].hits
    expect(hits).toHaveLength(2)
    expect(hits.map(h => h.matchOrdinal)).toEqual([0, 1])
    expect(hits.map(h => h.fileMatchCount)).toEqual([2, 2])
    expect(hits.map(h => h.rawFrom)).toEqual([0, 4])
  })

  it('CRLF 文本展示行去掉 \r 且 raw offset 保持原文坐标', () => {
    const hits = __workspaceSearchTest.searchFileContent(
      { fullPath: '/ws/a.md', name: 'a.md', relPath: 'a.md' },
      'one\r\ntwo needle\r\nthree',
      'needle',
      defaultOptions,
    )

    expect(hits[0].lineNumber).toBe(2)
    expect(hits[0].lineText).toBe('two needle')
    expect(hits[0].rawFrom).toBe('one\r\ntwo '.length)
  })

  it('取消后停止后续处理并返回 canceled progress', async () => {
    vi.mocked(readDir).mockImplementation(async (path) => {
      const p = String(path)
      if (p === '/ws') return [file('a.md'), file('b.md')]
      return []
    })
    vi.mocked(readTextFile).mockResolvedValue('needle')
    const controller = createWorkspaceSearchController()
    const progress: WorkspaceSearchProgress[] = []

    const result = await searchWorkspaceMarkdown('/ws', 'needle', defaultOptions, controller, {
      onProgress(p) {
        progress.push(p)
        if (p.phase === 'searching') controller.cancel()
      },
    })

    expect(result.progress.phase).toBe('canceled')
    expect(vi.mocked(readTextFile).mock.calls.length).toBeLessThanOrEqual(1)
    expect(progress.some(p => p.phase === 'canceled')).toBe(true)
  })

  it('跳转命中时先 focus 再选区和滚动,避免当前文件被 late focus 覆盖滚动', () => {
    const calls: string[] = []
    const backend = {
      focus: vi.fn(() => calls.push('focus')),
      setSelection: vi.fn(() => calls.push('setSelection')),
      clearHighlight: vi.fn(() => calls.push('clearHighlight')),
      scrollMatchIntoView: vi.fn(() => calls.push('scrollMatchIntoView')),
      getSelectionText: vi.fn(),
      getRangeText: vi.fn(),
      findMatches: vi.fn(),
      setHighlight: vi.fn(),
      replaceRange: vi.fn(),
    }

    const selected = revealWorkspaceSearchMatch(backend, 12, 18)

    expect(selected).toBe(true)
    expect(backend.setSelection).toHaveBeenCalledWith(12, 18)
    expect(backend.scrollMatchIntoView).toHaveBeenCalledWith(12)
    expect(calls).toEqual(['focus', 'setSelection', 'clearHighlight', 'scrollMatchIntoView'])
  })
})
