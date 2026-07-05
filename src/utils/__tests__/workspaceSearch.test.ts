import type { DirEntry } from '@tauri-apps/plugin-fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import {
  searchWorkspaceMarkdown,
  createWorkspaceSearchController,
  revealWorkspaceSearchMatch,
  applyWorkspaceReplace,
  __workspaceSearchTest,
  type WorkspaceSearchProgress,
  type WorkspaceSearchHit,
} from '../workspaceSearch'

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

  // ============ v0.6.0 替换 + scope ============

  function makeHit(fullPath: string, relPath: string): WorkspaceSearchHit {
    return {
      id: `${fullPath}:1:0:0`,
      fullPath,
      relPath,
      fileName: relPath.split('/').pop() ?? relPath,
      lineNumber: 1,
      lineText: 'needle here',
      matchStartInLine: 0,
      matchEndInLine: 6,
      rawFrom: 0,
      rawTo: 6,
      matchText: 'needle',
      matchOrdinal: 0,
      fileMatchCount: 1,
      query: 'needle',
      options: { caseSensitive: false, wholeWord: false, regex: false },
    }
  }

  it('applyWorkspaceReplace: 替换命中文件,写盘 + 计数 + 跳过 dirty', async () => {
    vi.mocked(readTextFile).mockImplementation(async (p) => {
      const s = String(p)
      if (s.endsWith('a.md')) return 'needle one needle two'
      if (s.endsWith('b.md')) return 'no match here'
      return ''
    })
    vi.mocked(writeTextFile).mockResolvedValue()

    const hits = [makeHit('/ws/a.md', 'a.md'), makeHit('/ws/b.md', 'b.md')]
    const result = await applyWorkspaceReplace(hits, {
      query: 'needle',
      options: defaultOptions,
      replacement: 'knife',
    }, new Set(['/ws/b.md'])) // b.md 标记为 dirty 跳过

    expect(result.skippedFiles).toEqual(['/ws/b.md'])
    expect(result.changedFiles).toEqual(['/ws/a.md'])
    expect(result.replacedCount).toBe(2)
    expect(result.failedFiles).toEqual([])
    expect(result.fileContents.get('/ws/a.md')).toBe('knife one knife two')
    // b.md 跳过 → 不应被读或写
    expect(vi.mocked(writeTextFile)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeTextFile)).toHaveBeenCalledWith('/ws/a.md', 'knife one knife two')
  })

  it('applyWorkspaceReplace: writeTextFile 抛错入 failedFiles,不阻塞其它文件', async () => {
    vi.mocked(readTextFile).mockImplementation(async (p) => {
      const s = String(p)
      if (s.endsWith('a.md')) return 'needle here'
      if (s.endsWith('b.md')) return 'needle there'
      return ''
    })
    vi.mocked(writeTextFile).mockImplementation(async (p) => {
      if (String(p).endsWith('a.md')) throw new Error('permission denied')
    })

    const hits = [makeHit('/ws/a.md', 'a.md'), makeHit('/ws/b.md', 'b.md')]
    const result = await applyWorkspaceReplace(hits, {
      query: 'needle',
      options: defaultOptions,
      replacement: 'knife',
    }, new Set())

    expect(result.changedFiles).toEqual(['/ws/b.md'])
    expect(result.failedFiles).toEqual([
      { fullPath: '/ws/a.md', reason: 'permission denied' },
    ])
    expect(result.replacedCount).toBe(1)
  })

  it('applyWorkspaceReplace: 内容未变化(罕见 race)不进 changedFiles', async () => {
    vi.mocked(readTextFile).mockResolvedValue('needle')
    vi.mocked(writeTextFile).mockResolvedValue()

    const hits = [makeHit('/ws/a.md', 'a.md')]
    const result = await applyWorkspaceReplace(hits, {
      query: 'no_match_query',
      options: defaultOptions,
      replacement: 'X',
    }, new Set())

    // 搜索阶段已有 hit,但磁盘上 query 已不在(被外部改动移走)→ 替换无命中可换
    expect(result.changedFiles).toEqual([])
    expect(result.replacedCount).toBe(0)
    expect(vi.mocked(writeTextFile)).not.toHaveBeenCalled()
  })

  it('applyWorkspaceReplace: 按 fullPath 去重,同文件多 hit 只读/写一次', async () => {
    vi.mocked(readTextFile).mockResolvedValue('needle\nneedle\nneedle')
    vi.mocked(writeTextFile).mockResolvedValue()

    const hits = [
      makeHit('/ws/a.md', 'a.md'),
      { ...makeHit('/ws/a.md', 'a.md'), id: 'second', matchOrdinal: 1, rawFrom: 7 },
      { ...makeHit('/ws/a.md', 'a.md'), id: 'third', matchOrdinal: 2, rawFrom: 14 },
    ]
    const result = await applyWorkspaceReplace(hits, {
      query: 'needle',
      options: defaultOptions,
      replacement: 'knife',
    }, new Set())

    expect(result.changedFiles).toEqual(['/ws/a.md'])
    expect(result.replacedCount).toBe(3)
    expect(vi.mocked(readTextFile)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeTextFile)).toHaveBeenCalledTimes(1)
  })

  it('searchWorkspaceMarkdown: scopeDir 非 null 时只从子目录开始 BFS', async () => {
    vi.mocked(readDir).mockImplementation(async (path) => {
      const p = String(path)
      if (p === '/ws') return [dir('docs'), file('top.md')]
      if (p === '/ws/docs') return [file('inside.md'), dir('other')]
      if (p === '/ws/docs/other') return [] // 不应被访问
      return []
    })
    vi.mocked(readTextFile).mockImplementation(async (p) => {
      if (String(p).endsWith('top.md')) return 'needle top'
      if (String(p).endsWith('inside.md')) return 'needle inside'
      return ''
    })

    // 不传 scopeDir → 从 /ws 开始,应扫到 top.md + inside.md
    const whole = await searchWorkspaceMarkdown('/ws', 'needle', defaultOptions)
    expect(whole.progress.filesFound).toBe(2)
    expect(readDir).toHaveBeenCalledWith('/ws')

    vi.mocked(readDir).mockClear()
    vi.mocked(readTextFile).mockClear()

    // 传 scopeDir='/ws/docs' → 只扫 docs/inside.md,top.md 被排除
    const scoped = await searchWorkspaceMarkdown('/ws', 'needle', defaultOptions, undefined, undefined, '/ws/docs')
    expect(scoped.progress.filesFound).toBe(1)
    expect(scoped.groups[0].file.relPath).toBe('inside.md')
    expect(vi.mocked(readDir)).toHaveBeenCalledWith('/ws/docs')
    expect(vi.mocked(readDir)).not.toHaveBeenCalledWith('/ws')
  })
})
