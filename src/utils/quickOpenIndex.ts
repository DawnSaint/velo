// Ctrl+P 查找文件:工作区 .md 文件索引(v0.5.2)
//
// 一个 module-level 单例 Map<root, Entry[]>。首次 `ensureIndex(root)`
// 触发遍历收集所有 .md 文件;后续命中缓存直接返回。
//
// #rust-search-quickopen-git Phase 1:遍历优先走 Rust 单 command
// (scan_workspace_files,1 次 IPC 返回全量条目);旧版后端 / web 端 /
// command 失败时回落原 JS 按层并发 BFS。缓存 / stale / pending 语义不变。
//
// 失效策略走"标记 stale 而非局部 patch":App.vue 的工作区 fs.watch 回调
// 任何脏事件都 `invalidate(root)`,下次面板打开时重扫。简单可靠,与
// FileTree 的"脏目录集 + 子树重拉"是同一哲学;真撞性能墙再上精细化 diff。
//
// 切工作区(`workspaceStore.activeRoot` 变化)调 `clearAll()` 清整张表 ——
// 工作区之间互不复用索引;且旧工作区路径上的 watch 也已停,无再 invalidate 通路。
//
// 隐藏目录(.git/.vscode 等)跟 FileTree 一样过滤;复用 `treeUtils.isVisible`
// 的隐藏目录约定但内联实现(本模块不需要图片过滤,只收 .md)。

import { readDir, tauriOnly } from '@/tauri/fs'
import { join } from '@/tauri/path'
import { scanWorkspaceFiles } from '@/tauri/workspace'
import { isMarkdownPath } from '@/utils/markdownPath'
import { mapWithConcurrency, WALK_CONCURRENCY } from '@/utils/mapWithConcurrency'

export interface QuickOpenEntry {
  fullPath: string
  /** 文件名(含 .md 后缀);展示时面板会去掉后缀 */
  name: string
  /** 相对 root 的展示路径(分隔符归一为 `/`);形如 `docs/ARCHITECTURE.md` */
  relPath: string
}

interface CacheSlot {
  entries: QuickOpenEntry[]
  stale: boolean
  /** 重建中的 promise,避免并发 ensureIndex 重复 walk */
  pending: Promise<QuickOpenEntry[]> | null
}

const cache = new Map<string, CacheSlot>()

/** 把 Windows 反斜杠归一为正斜杠,供 relPath 展示用。 */
function normalizeSep(s: string): string {
  return s.replace(/\\/g, '/')
}

interface LevelResult {
  dirs: string[]
  files: QuickOpenEntry[]
}

async function scanDir(root: string, dir: string): Promise<LevelResult> {
  const dirs: string[] = []
  const files: QuickOpenEntry[] = []
  let entries
  try {
    entries = await readDir(dir)
  }
  catch {
    // 单条 readDir 失败不影响整次 walk
    return { dirs, files }
  }
  for (const e of entries) {
    if (!e.name) continue
    if (e.isDirectory) {
      if (e.name.startsWith('.')) continue // 隐藏目录(.git 等)整段跳过
      try {
        dirs.push(await join(dir, e.name))
      }
      catch { /* join 极少失败,静默 */ }
    }
    else if (isMarkdownPath(e.name)) {
      try {
        const fullPath = await join(dir, e.name)
        // relPath:去掉 root 前缀 + 起始分隔符,再归一斜杠
        let rel = fullPath.startsWith(root) ? fullPath.slice(root.length) : fullPath
        if (rel.startsWith('/') || rel.startsWith('\\')) rel = rel.slice(1)
        files.push({ fullPath, name: e.name, relPath: normalizeSep(rel) })
      }
      catch { /* 同上 */ }
    }
  }
  return { dirs, files }
}

/** JS 按层并发 BFS —— Rust command 不可用时的 fallback(web 端 / 旧版后端)。 */
async function walkRootJs(root: string): Promise<QuickOpenEntry[]> {
  const out: QuickOpenEntry[] = []
  let level: string[] = [root]
  while (level.length) {
    const results = await mapWithConcurrency(level, WALK_CONCURRENCY, dir => scanDir(root, dir))
    const nextLevel: string[] = []
    for (const r of results) {
      if (!r) continue
      nextLevel.push(...r.dirs)
      out.push(...r.files)
    }
    level = nextLevel
  }
  return out
}

async function walkRoot(root: string): Promise<QuickOpenEntry[]> {
  // 优先 Rust 单 command:1 次 IPC 返回全量条目(现状 BFS 每目录一次
  // readDir + 每条目一次 join,5k 文件 ≈ 上万次往返)。
  // 旧版后端无此 command / web 端无 Tauri → 回落 JS BFS,行为不回退。
  if (tauriOnly()) {
    try {
      return await scanWorkspaceFiles(root)
    }
    catch { /* 回落 JS 遍历 */ }
  }
  return walkRootJs(root)
}

/**
 * 取工作区索引;命中且非 stale 直接返回缓存,否则重建。
 *
 * 并发安全:重建中的 promise 挂在 slot.pending,后续调用 await 同一份 promise,
 * 不重复 walk。
 */
export async function ensureIndex(root: string): Promise<QuickOpenEntry[]> {
  const cached = cache.get(root)
  if (cached && !cached.stale && !cached.pending) return cached.entries
  if (cached?.pending) return cached.pending
  const slot: CacheSlot = cached ?? { entries: [], stale: true, pending: null }
  if (!cached) cache.set(root, slot)
  const p = walkRoot(root).then((entries) => {
    slot.entries = entries
    slot.stale = false
    slot.pending = null
    return entries
  })
  slot.pending = p
  return p
}

/** 标记 root 索引为 stale —— 下次 ensureIndex 重扫。如果 root 无缓存,no-op。 */
export function invalidate(root: string | null): void {
  if (!root) return
  const slot = cache.get(root)
  if (slot) slot.stale = true
}

/** 清整张表(切工作区调一次). */
export function clearAll(): void {
  cache.clear()
}
