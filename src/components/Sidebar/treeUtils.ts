// 文件树纯函数工具(v0.5.1 抽组件):路径、过滤、排序、命名校验、错误格式。
//
// 全部不依赖 Vue / Pinia / Tauri,纯字符串 / 数组操作,便于直接 vitest。
// 任何需要状态机 / refs / fs 调用的逻辑留在 FileTree.vue 或对应 composable 里。

import type { DirEntry } from '@/tauri/fs'
import { isImageExt } from '@/utils/imagePath'
import { MARKDOWN_EXT_RE } from '@/utils/markdownPath'

/** Markdown 文件扩展名:树展示 + 点击打开 + 重命名 .md 静态后缀检测共用。 */
export const MD_EXT_RE = MARKDOWN_EXT_RE

/** 文件名禁用字符(Windows + POSIX 取并集,跨平台一份). */
export const FORBIDDEN_NAME_CHARS = /[\\/:*\?"<>|\0]/

/** 取路径 basename;双分隔符兼容 / 与 \,避免引入异步 sep()。 */
export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

/** 取路径父目录;根级路径(无分隔符 / 单个 /)返回原值。 */
export function parentDirOfPath(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i <= 0 ? p : p.slice(0, i)
}

/** p 是否落在 ancestor 内(等于自身亦算)。双分隔符判定避免 `/a/b1` 误中 `/a/b`。 */
export function isAncestorOrSelf(ancestor: string, p: string): boolean {
  if (p === ancestor) return true
  return p.startsWith(ancestor + '/') || p.startsWith(ancestor + '\\')
}

/** 文件名是否图片(树图标分支 / 拖入判定共用)。 */
export function isImageName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot === -1 || dot === name.length - 1) return false
  return isImageExt(name.slice(dot + 1))
}

/** 树是否展示某条目:.md / 图片 / 非隐藏目录;.git / .vscode 等隐藏目录整段过滤。 */
export function isVisible(entry: DirEntry): boolean {
  if (!entry.name) return false
  if (entry.isDirectory) return !entry.name.startsWith('.')
  if (MD_EXT_RE.test(entry.name)) return true
  const dot = entry.name.lastIndexOf('.')
  if (dot === -1 || dot === entry.name.length - 1) return false
  return isImageExt(entry.name.slice(dot + 1))
}

/** 目录在前,同类按 name 本地化排序(中文按拼音). */
export function sortEntries(entries: DirEntry[]): DirEntry[] {
  const visible = entries.filter(isVisible)
  const dirs = visible.filter(e => e.isDirectory)
  const files = visible.filter(e => !e.isDirectory)
  const cmp = (a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name, 'zh-Hans-CN')
  dirs.sort(cmp)
  files.sort(cmp)
  return [...dirs, ...files]
}

/**
 * 校验新建 / 重命名的名称。返回错误描述或 null(通过)。
 * @param raw 用户输入(尾部 .md 已由 finalName 决定是否拼上,这里收完整名)
 * @param siblingNames 同级已有名集合(目录已加载时传入,未加载传 null 表示"无法判同名,交给后端")
 * @param ignoreName 重命名时跳过自己旧名(避免改回原名报"同名")
 */
export function validateName(
  raw: string,
  siblingNames: Set<string> | null,
  ignoreName: string | null,
): string | null {
  const name = raw.trim()
  if (!name) return '名称不能为空'
  if (name === '.' || name === '..') return '不能使用 . 或 ..'
  if (FORBIDDEN_NAME_CHARS.test(name)) return '名称包含非法字符 (/ \\ : * ? " < > |)'
  if (siblingNames && name !== ignoreName && siblingNames.has(name)) {
    return '已存在同名项'
  }
  return null
}

/** 把用户输入拼成"最终落地名":新建文件补 .md;新建目录原值;重命名 .md 文件补 .md;其它原值。 */
export function finalName(
  value: string,
  options: { kind: 'newFile' | 'newDir' | 'renameMdFile' | 'renameOther' },
): string {
  if (options.kind === 'newFile' || options.kind === 'renameMdFile') return `${value}.md`
  return value
}

/** Tauri 各 plugin-fs 错误形态不一致(Error / string / 对象),统一拼前缀字符串供 message 弹窗。 */
export function formatFsError(e: unknown, prefix: string): string {
  const msg = e instanceof Error
    ? e.message
    : (typeof e === 'string' ? e : JSON.stringify(e))
  return `${prefix}:${msg}`
}
