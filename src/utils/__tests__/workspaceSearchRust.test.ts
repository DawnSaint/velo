// workspaceSearch Rust 路径测试(#rust-search-quickopen-git Phase 2)
//
// setup.ts 的 invoke stub 默认对 search_workspace / replace_workspace 抛错
// (模拟旧版后端 → JS fallback)。本文件用 vi.mocked(invoke) 覆盖,模拟 Rust
// 流式回传:从 invoke 参数里拿到 Channel 实例,手动调 onmessage 注入事件。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import {
  searchWorkspaceMarkdown,
  createWorkspaceSearchController,
  applyWorkspaceReplace,
  type WorkspaceSearchHit,
  type WorkspaceSearchProgress,
} from '../workspaceSearch'

const defaultOptions = { caseSensitive: false, wholeWord: false, regex: false }

/** invoke mock 回调的 args 是 InvokeArgs(联合类型),统一收 unknown 再断言 */
type InvokeMockArgs = unknown
function channelOf(args: InvokeMockArgs): { onmessage: (e: unknown) => void } {
  return (args as { channel: { onmessage: (e: unknown) => void } }).channel
}

function rawHit(over: Partial<Record<string, unknown>> = {}) {
  return {
    fullPath: '/ws/a.md',
    relPath: 'a.md',
    fileName: 'a.md',
    lineNumber: 1,
    lineText: 'needle here',
    matchStartInLine: 0,
    matchEndInLine: 6,
    rawFrom: 0,
    rawTo: 6,
    matchText: 'needle',
    matchOrdinal: 0,
    fileMatchCount: 1,
    ...over,
  }
}

beforeEach(() => {
  vi.mocked(invoke).mockReset()
  vi.mocked(readTextFile).mockReset()
  vi.mocked(writeTextFile).mockReset()
})

describe('searchWorkspaceMarkdown Rust 流式路径', () => {
  it('Rust 命中经 Channel 回传,hydrate 回填 id/query/options', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string, args?: InvokeMockArgs) => {
      if (command === 'search_workspace') {
        const channel = channelOf(args)
        channel.onmessage({ kind: 'scanned', filesFound: 1 })
        // 真实 Rust 线上格式:WorkspaceFileEntry 默认 snake_case 序列化,
        // SearchHit 带 camelCase —— 嵌套 file 不随外层事件改名(回归:分组标题空白)
        channel.onmessage({
          kind: 'file',
          file: { full_path: '/ws/a.md', name: 'a.md', rel_path: 'a.md' },
          hits: [rawHit()],
          filesSearched: 1,
          hitsTotal: 1,
        })
        channel.onmessage({ kind: 'done', canceled: false, filesSearched: 1, hitsTotal: 1 })
        return undefined
      }
      throw new Error(`unexpected command ${command}`)
    })

    const result = await searchWorkspaceMarkdown('/ws', 'needle', defaultOptions)
    expect(result.progress.phase).toBe('done')
    expect(result.progress.hits).toBe(1)
    expect(result.groups).toHaveLength(1)
    // 分组头字段必须归一为 camelCase,否则面板 relPath 标题空白 / 折叠 key 失效
    expect(result.groups[0].file).toEqual({ fullPath: '/ws/a.md', name: 'a.md', relPath: 'a.md' })
    const hit = result.groups[0].hits[0]
    expect(hit.id).toBe('/ws/a.md:1:0:0')
    expect(hit.query).toBe('needle')
    expect(hit.options).toEqual(defaultOptions)
    expect(hit.rawFrom).toBe(0)
    // Rust 路径不应走 JS readTextFile
    expect(readTextFile).not.toHaveBeenCalled()
  })

  it('snake_case 嵌套 file 归一:子目录 relPath 完整保留(分组标题回归)', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string, args?: InvokeMockArgs) => {
      if (command === 'search_workspace') {
        const channel = channelOf(args)
        channel.onmessage({ kind: 'scanned', files_found: 1 })
        channel.onmessage({
          kind: 'file',
          file: { full_path: 'C:\\ws\\docs\\guide.md', name: 'guide.md', rel_path: 'docs/guide.md' },
          hits: [rawHit({ fullPath: 'C:\\ws\\docs\\guide.md', relPath: 'docs/guide.md', fileName: 'guide.md' })],
          files_searched: 1,
          hits_total: 1,
        })
        channel.onmessage({ kind: 'done', canceled: false, files_searched: 1, hits_total: 1 })
        return undefined
      }
      throw new Error('unexpected')
    })
    const result = await searchWorkspaceMarkdown('C:\\ws', 'needle', defaultOptions)
    expect(result.groups[0].file.relPath).toBe('docs/guide.md')
    expect(result.groups[0].file.fullPath).toBe('C:\\ws\\docs\\guide.md')
    expect(result.groups[0].file.name).toBe('guide.md')
    expect(result.progress.filesFound).toBe(1)
    expect(result.progress.filesSearched).toBe(1)
  })

  it('progress 事件推进 filesSearched 计数', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string, args?: InvokeMockArgs) => {
      if (command === 'search_workspace') {
        const channel = channelOf(args)
        channel.onmessage({ kind: 'scanned', filesFound: 3 })
        channel.onmessage({ kind: 'progress', filesSearched: 1, hitsTotal: 0 })
        channel.onmessage({ kind: 'progress', filesSearched: 2, hitsTotal: 0 })
        channel.onmessage({ kind: 'done', canceled: false, filesSearched: 3, hitsTotal: 0 })
        return undefined
      }
      throw new Error('unexpected')
    })
    const progress: WorkspaceSearchProgress[] = []
    const result = await searchWorkspaceMarkdown('/ws', 'needle', defaultOptions, undefined, {
      onProgress(p) { progress.push(p) },
    })
    expect(result.progress.filesSearched).toBe(3)
    expect(result.groups).toHaveLength(0)
    expect(progress.some(p => p.filesSearched === 2)).toBe(true)
  })

  it('done.canceled=true → phase canceled', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string, args?: InvokeMockArgs) => {
      if (command === 'search_workspace') {
        const channel = channelOf(args)
        channel.onmessage({ kind: 'scanned', filesFound: 5 })
        channel.onmessage({ kind: 'done', canceled: true, filesSearched: 2, hitsTotal: 0 })
        return undefined
      }
      throw new Error('unexpected')
    })
    const result = await searchWorkspaceMarkdown('/ws', 'needle', defaultOptions)
    expect(result.progress.phase).toBe('canceled')
  })

  it('invoke reject(正则方言不支持)且无命中 → 降级 JS 路径', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'search_workspace') throw new Error('正则编译失败: lookahead not supported')
      throw new Error('unexpected')
    })
    // JS fallback 需要 readDir / readTextFile
    const { readDir } = await import('@tauri-apps/plugin-fs')
    vi.mocked(readDir).mockResolvedValue([{ name: 'a.md', isDirectory: false, isFile: true, isSymlink: false }] as never)
    vi.mocked(readTextFile).mockResolvedValue('foobar')

    const result = await searchWorkspaceMarkdown('/ws', 'foo(?=bar)', { ...defaultOptions, regex: true })
    expect(result.progress.phase).toBe('done')
    expect(result.progress.hits).toBe(1)
    expect(readTextFile).toHaveBeenCalled() // 证明走了 JS
  })

  it('cancel 触发 cancel_workspace_search 并绑定 searchId', async () => {
    let capturedId: number | null = null
    vi.mocked(invoke).mockImplementation(async (command: string, args?: InvokeMockArgs) => {
      if (command === 'search_workspace') {
        capturedId = (args as { searchId: number }).searchId
        const channel = channelOf(args)
        channel.onmessage({ kind: 'scanned', filesFound: 1 })
        // 模拟搜索进行中:不立即 done,让 controller 有机会 cancel
        await new Promise(r => setTimeout(r, 10))
        channel.onmessage({ kind: 'done', canceled: true, filesSearched: 0, hitsTotal: 0 })
        return undefined
      }
      if (command === 'cancel_workspace_search') return undefined
      throw new Error('unexpected')
    })
    const controller = createWorkspaceSearchController()
    const p = searchWorkspaceMarkdown('/ws', 'needle', defaultOptions, controller)
    await new Promise(r => setTimeout(r, 5))
    controller.cancel()
    const result = await p
    expect(controller.canceled).toBe(true)
    expect(capturedId).not.toBeNull()
    const cancelCalls = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'cancel_workspace_search')
    expect(cancelCalls).toHaveLength(1)
    expect(cancelCalls[0][1]).toEqual({ searchId: capturedId })
    expect(result.progress.phase).toBe('canceled')
  })
})

describe('applyWorkspaceReplace Rust 路径', () => {
  function makeHit(fullPath: string): WorkspaceSearchHit {
    return {
      id: `${fullPath}:1:0:0`,
      fullPath,
      relPath: fullPath.split('/').pop() ?? fullPath,
      fileName: fullPath.split('/').pop() ?? fullPath,
      lineNumber: 1,
      lineText: 'needle',
      matchStartInLine: 0,
      matchEndInLine: 6,
      rawFrom: 0,
      rawTo: 6,
      matchText: 'needle',
      matchOrdinal: 0,
      fileMatchCount: 1,
      query: 'needle',
      options: defaultOptions,
    }
  }

  it('Rust 替换结果映射为 ReplaceResult(fileContents 转 Map)', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'replace_workspace') {
        return {
          changedFiles: ['/ws/a.md'],
          replacedCount: 2,
          skippedFiles: ['/ws/b.md'],
          failedFiles: [],
          fileContents: { '/ws/a.md': 'knife one knife two' },
        }
      }
      throw new Error('unexpected')
    })
    const result = await applyWorkspaceReplace(
      [makeHit('/ws/a.md'), makeHit('/ws/b.md')],
      { query: 'needle', options: defaultOptions, replacement: 'knife' },
      new Set(['/ws/b.md']),
    )
    expect(result.changedFiles).toEqual(['/ws/a.md'])
    expect(result.replacedCount).toBe(2)
    expect(result.skippedFiles).toEqual(['/ws/b.md'])
    expect(result.fileContents.get('/ws/a.md')).toBe('knife one knife two')
    // Rust 路径不应走 JS writeTextFile
    expect(writeTextFile).not.toHaveBeenCalled()
    // dirtyPaths 正确传给后端
    const call = vi.mocked(invoke).mock.calls.find(c => c[0] === 'replace_workspace')
    expect((call![1] as { dirtyPaths: string[] }).dirtyPaths).toEqual(['/ws/b.md'])
  })

  it('Rust invoke reject → 降级 JS 逐文件替换', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'replace_workspace') throw new Error('command not found')
      throw new Error('unexpected')
    })
    vi.mocked(readTextFile).mockResolvedValue('needle one')
    vi.mocked(writeTextFile).mockResolvedValue()
    const result = await applyWorkspaceReplace(
      [makeHit('/ws/a.md')],
      { query: 'needle', options: defaultOptions, replacement: 'knife' },
      new Set(),
    )
    expect(result.changedFiles).toEqual(['/ws/a.md'])
    expect(result.replacedCount).toBe(1)
    expect(writeTextFile).toHaveBeenCalledWith('/ws/a.md', 'knife one')
  })
})
