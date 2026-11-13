// quickOpenIndex 遍历路由测试(#rust-search-quickopen-git Phase 1)
//
// 验证:Rust command 优先 / 失败回落 JS BFS / 缓存与 stale 语义不变。
// setup.ts 的 invoke stub 默认对 scan_workspace_files 抛错(模拟旧版后端),
// 需要 Rust 路径的用例用 vi.mocked(invoke) 覆盖。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { readDir } from '@tauri-apps/plugin-fs'
import { ensureIndex, invalidate, clearAll } from '@/utils/quickOpenIndex'

const ROOT = '/ws'

function rawEntry(name: string, relPath: string) {
  return { full_path: `${ROOT}/${relPath}`, name, rel_path: relPath }
}

beforeEach(() => {
  clearAll()
  vi.mocked(invoke).mockClear()
  vi.mocked(readDir).mockReset()
})

describe('quickOpenIndex Rust 单 command 路由', () => {
  it('Rust command 可用:直接用其结果,不走 JS readDir', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'scan_workspace_files') {
        return [rawEntry('a.md', 'a.md'), rawEntry('b.md', 'sub/b.md')]
      }
      return undefined
    })
    const entries = await ensureIndex(ROOT)
    expect(entries).toEqual([
      { fullPath: '/ws/a.md', name: 'a.md', relPath: 'a.md' },
      { fullPath: '/ws/sub/b.md', name: 'b.md', relPath: 'sub/b.md' },
    ])
    expect(readDir).not.toHaveBeenCalled()
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('scan_workspace_files', { root: ROOT })
  })

  it('Rust command 失败(旧版后端):回落 JS BFS', async () => {
    // setup.ts 默认 stub 即抛错;这里显式覆盖一次以示意图
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'scan_workspace_files') throw new Error('command not found')
      return undefined
    })
    vi.mocked(readDir).mockImplementation(async (path) => {
      const dir = String(path)
      if (dir === ROOT) {
        return [
          { name: 'a.md', isDirectory: false, isFile: true, isSymlink: false },
          { name: 'sub', isDirectory: true, isFile: false, isSymlink: false },
          { name: '.git', isDirectory: true, isFile: false, isSymlink: false },
        ] as never
      }
      if (dir === `${ROOT}/sub`) {
        return [{ name: 'b.md', isDirectory: false, isFile: true, isSymlink: false }] as never
      }
      return [] as never
    })
    const entries = await ensureIndex(ROOT)
    expect(entries.map(e => e.relPath).sort()).toEqual(['a.md', 'sub/b.md'])
    expect(readDir).toHaveBeenCalled()
  })

  it('缓存命中:第二次 ensureIndex 不再 invoke', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'scan_workspace_files') return [rawEntry('a.md', 'a.md')]
      return undefined
    })
    await ensureIndex(ROOT)
    await ensureIndex(ROOT)
    const scans = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'scan_workspace_files')
    expect(scans).toHaveLength(1)
  })

  it('invalidate 后重扫:再次 invoke', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'scan_workspace_files') return [rawEntry('a.md', 'a.md')]
      return undefined
    })
    await ensureIndex(ROOT)
    invalidate(ROOT)
    await ensureIndex(ROOT)
    const scans = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'scan_workspace_files')
    expect(scans).toHaveLength(2)
  })

  it('并发 ensureIndex 共享同一次扫描(pending 去重)', async () => {
    let resolveScan!: (v: unknown) => void
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'scan_workspace_files') {
        return new Promise((resolve) => { resolveScan = resolve })
      }
      return undefined
    })
    const p1 = ensureIndex(ROOT)
    const p2 = ensureIndex(ROOT)
    resolveScan([rawEntry('a.md', 'a.md')])
    const [e1, e2] = await Promise.all([p1, p2])
    expect(e1).toEqual(e2)
    const scans = vi.mocked(invoke).mock.calls.filter(c => c[0] === 'scan_workspace_files')
    expect(scans).toHaveLength(1)
  })
})
