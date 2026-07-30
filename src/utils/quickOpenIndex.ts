// Ctrl+P 查找文件:工作区 .md 文件索引(v0.5.2)
//
// 一个 module-level 单例 Map<root, Entry[]>。首次 `ensureIndex(root)`
// 触发递归 readDir 收集所有 .md 文件;后续命中缓存直接返回。
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

import { readDir } from '@/tauri/fs'
import { join } from '@/tauri/path'
import { isMarkdownPath } from '@/utils/markdownPath'

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

async function walkRoot(root: string): Promise<QuickOpenEntry[]> {
  const out: QuickOpenEntry[] = []
  // 单条 readDir 失败不影响整次 walk
  const queue: string[] = [root]
  while (queue.length) {
    const dir = queue.shift()!
    let entries
    try {
      entries = await readDir(dir)
    }
    catch {
      continue
    }
    for (const e of entries) {
      if (!e.name) continue
      if (e.isDirectory) {
        if (e.name.startsWith('.')) continue // 隐藏目录(.git 等)整段跳过
        try {
          queue.push(await join(dir, e.name))
        }
        catch { /* join 极少失败,静默 */ }
      }
      else if (isMarkdownPath(e.name)) {
        try {
          const fullPath = await join(dir, e.name)
          // relPath:去掉 root 前缀 + 起始分隔符,再归一斜杠
          let rel = fullPath.startsWith(root) ? fullPath.slice(root.length) : fullPath
          if (rel.startsWith('/') || rel.startsWith('\\')) rel = rel.slice(1)
          out.push({ fullPath, name: e.name, relPath: normalizeSep(rel) })
        }
        catch { /* 同上 */ }
      }
    }
  }
  return out
}

/**
 * 取工作区索引;命中且非 stale 直接返回缓存,否则重建。
 *
 * 并发安全:重建中的 promise 挂在 slot.pending,后续调用 await 同一份 promise,
 * 不重复 walk。
 */
export async function ensureIndex(root: string): Promise<QuickOpenEntry[]> {
  let slot = cache.get(root)
  if (slot && !slot.stale && !slot.pending) return slot.entries
  if (slot?.pending) return slot.pending
  if (!slot) {
    slot = { entries: [], stale: true, pending: null }
    cache.set(root, slot)
  }
  const p = walkRoot(root).then((entries) => {
    slot!.entries = entries
    slot!.stale = false
    slot!.pending = null
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
