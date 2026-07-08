// 资产"重新组织到 assets/"的文件操作 + 路径计算。
//
// 纯函数路径计算 + Tauri fs 编排。业务侧（AssetPanel）传入原图绝对路径、
// 当前文档路径、工作区根，得到新 absPath / 新 markdown src，然后通知 App.vue
// 重写 PM doc 中的 image 节点 src。
//
// 文件操作走 `@/tauri/fs` 薄封装层；路径计算用同步字符串操作（与 imagePath.ts 同款）。

import { copyFile, exists, mkdir, readDir, remove, rename } from '@/tauri/fs'
import { dirnameSync } from '@/utils/imagePath'
import { basename as basenameSync } from '@/components/Sidebar/treeUtils'

// ============================================================
//  纯函数：路径计算
// ============================================================

/**
 * 取文档名（不含 .md 扩展名），用于构造 `assets/<docName>/` 子目录。
 *   'tutorial.md' → 'tutorial'
 *   'my-notes.md' → 'my-notes'
 *   'README'      → 'README'（无 .md 原样返回）
 */
export function docNameFromPath(filePath: string): string {
  const name = basenameSync(filePath)
  return name.replace(/\.md$/i, '')
}

/**
 * 计算从 `from`（目录）到 `to`（文件/目录）的相对路径。
 *   from: /wiki/notes      to: /wiki/assets/tutorial/img.png → ../assets/tutorial/img.png
 *   from: /wiki             to: /wiki/assets/tutorial/img.png → assets/tutorial/img.png
 *
 * 双斜杠统一为 `/`；Windows 盘符（C:）当作普通段处理。
 * 不处理跨盘符（from=C:/.., to=D:/..）—— 调用方保证同根。
 */
export function relativePath(fromDir: string, toPath: string): string {
  const from = fromDir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  const to = toPath.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)

  let i = 0
  while (i < from.length && i < to.length && from[i] === to[i]) i++

  const up = from.length - i
  const down = to.slice(i)
  const parts = Array(up).fill('..').concat(down)
  return parts.length > 0 ? parts.join('/') : '.'
}

/**
 * 在 `existingNames` 中生成不冲突的文件名。
 *   foo.png → foo-2.png → foo-3.png → ...
 *   无扩展名 → foo → foo-2 → foo-3
 */
export function uniqueFileName(fileName: string, existingNames: Set<string>): string {
  if (!existingNames.has(fileName)) return fileName
  const dot = fileName.lastIndexOf('.')
  const hasExt = dot > 0 && dot < fileName.length - 1
  const stem = hasExt ? fileName.slice(0, dot) : fileName
  const ext = hasExt ? fileName.slice(dot) : ''
  let n = 2
  while (existingNames.has(`${stem}-${n}${ext}`)) n++
  return `${stem}-${n}${ext}`
}

/**
 * 文档是否落在工作区根内（用于判断"重新组织"是否可用）。
 * 双分隔符判定避免 `/a/b1` 误中 `/a/b`。
 */
export function isPathInRoot(filePath: string, root: string): boolean {
  const f = filePath.replace(/\\/g, '/')
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return f === r || f.startsWith(r + '/')
}

// ============================================================
//  编排：复制 / 移动
// ============================================================

export interface ReorganizeResult {
  /** 新的磁盘绝对路径（forward-slash） */
  newAbsPath: string
  /** 写入 markdown src 的新字符串（从 docDir 到 newAbsPath 的相对路径） */
  newSrc: string
  /** 落地的文件名（可能因冲突重命名） */
  fileName: string
  /** 操作是否实际执行（源===目标时为 false，表示 no-op） */
  moved: boolean
}

/**
 * 把一张图片复制 / 移动到 `<workspaceRoot>/assets/<docName>/` 下，
 * 并返回新的 markdown src（相对 docDir 的路径）。
 *
 *  - copy → `fs.copyFile`，源文件保留
 *  - move → `fs.rename`，跨设备 fallback: `copyFile` + `remove`
 *
 * 同名冲突：目标已存在同名文件 → 生成 `foo-2.png` 唯一名。
 * 源===目标：no-op，返回原路径 + 原 src。
 *
 * 失败 throw —— 调用方决定反馈策略。
 */
export async function reorganizeAsset(opts: {
  sourceAbsPath: string
  currentFilePath: string
  workspaceRoot: string
  mode: 'copy' | 'move'
}): Promise<ReorganizeResult> {
  const { sourceAbsPath, currentFilePath, workspaceRoot, mode } = opts

  const docName = docNameFromPath(currentFilePath)
  const docDir = dirnameSync(currentFilePath)
  const targetDir = `${workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/assets/${docName}`
  const originalName = basenameSync(sourceAbsPath)

  // 源已在目标位置 → no-op
  const targetOriginal = `${targetDir}/${originalName}`
  if (sourceAbsPath.replace(/\\/g, '/') === targetOriginal.replace(/\\/g, '/')) {
    const newSrc = relativePath(docDir, targetOriginal)
    return { newAbsPath: targetOriginal, newSrc, fileName: originalName, moved: false }
  }

  // 确保目标目录存在
  if (!(await exists(targetDir))) {
    await mkdir(targetDir, { recursive: true })
  }

  // 收集目标目录已有文件名，算唯一名
  const existing = new Set<string>()
  try {
    const entries = await readDir(targetDir)
    for (const e of entries) {
      if (e.name) existing.add(e.name)
    }
  } catch {
    // 目录刚创建，空目录 → existing 为空
  }
  const fileName = uniqueFileName(originalName, existing)
  const targetAbsPath = `${targetDir}/${fileName}`
  const newSrc = relativePath(docDir, targetAbsPath)

  if (mode === 'copy') {
    await copyFile(sourceAbsPath, targetAbsPath)
  } else {
    // move: rename 优先，跨设备失败 fallback copy + remove
    try {
      await rename(sourceAbsPath, targetAbsPath)
    } catch {
      await copyFile(sourceAbsPath, targetAbsPath)
      await remove(sourceAbsPath)
    }
  }

  return { newAbsPath: targetAbsPath, newSrc, fileName, moved: true }
}
