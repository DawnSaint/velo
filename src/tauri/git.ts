// Git 历史集成 Tauri 封装层(#local-timeline-git)
//
// 薄封装 invoke 调用 Rust 端 git 命令,与 fs.ts / dialog.ts 同模式:
// 单一入口 + tauriOnly() 守门,非 Tauri 环境走降级。
// 测试 mock 统一打本模块,不散布 @tauri-apps/api/core。

import { invoke } from '@tauri-apps/api/core'
import { tauriOnly } from './fs'

export interface GitCommitEntry {
  /** commit hash (full SHA) */
  hash: string
  /** commit hash 短格式 (7 位) */
  shortHash: string
  /** 作者名 */
  author: string
  /** 作者时间戳 (ms) */
  authorDate: number
  /** commit message 第一行 */
  subject: string
  /** commit message 完整内容(subject + body) */
  message: string
}

/** Rust 端返回的 JSON 结构(serde 默认 camelCase 不开启,字段是 snake_case) */
interface GitCommitEntryRaw {
  hash: string
  short_hash: string
  author: string
  author_date: number
  subject: string
  message: string
}

function toEntry(raw: GitCommitEntryRaw): GitCommitEntry {
  return {
    hash: raw.hash,
    shortHash: raw.short_hash,
    author: raw.author,
    authorDate: raw.author_date,
    subject: raw.subject,
    message: raw.message,
  }
}

/** 检测文件是否在 Git 仓库内。返回仓库根路径或 null。 */
export async function gitRepoRoot(filePath: string): Promise<string | null> {
  if (!tauriOnly()) return null
  try {
    const result = await invoke<string | null>('git_repo_root', { filePath })
    return result ?? null
  }
  catch {
    return null
  }
}

/** 获取文件的 Git commit 历史(metadata only,不含 content)。按时间倒序(最新在前)。 */
export async function gitFileHistory(filePath: string): Promise<GitCommitEntry[]> {
  if (!tauriOnly()) return []
  try {
    const result = await invoke<GitCommitEntryRaw[]>('git_file_history', { filePath })
    return result.map(toEntry)
  }
  catch {
    return []
  }
}

/** 获取某 commit 中该文件的内容(git show <hash>:<path>)。懒加载用。 */
export async function gitShowFile(repoRoot: string, commitHash: string, filePath: string): Promise<string> {
  if (!tauriOnly()) return ''
  return invoke<string>('git_show_file', { repoRoot, commitHash, filePath })
}

