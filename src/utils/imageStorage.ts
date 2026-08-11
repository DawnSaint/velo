// 图片落盘 / 删除 Tauri 服务。
//
// 纯函数路径决策在 `src/utils/imagePath.ts`,这里只做 I/O:
//   - 拿 dirname / appDataDir
//   - mkdir 兜底
//   - writeBinaryFile / remove
//
// 错误一律 throw(不静默吞)—— 调用方根据上下文决定 fallback
// (paste 路径可以降级到 base64;删除失败可以让用户再试一次)。

import { appDataDir, dirname, join } from '@/tauri/path'
import {
  exists,
  mkdir,
  readDir,
  readFile,
  writeFile,
} from '@/tauri/fs'
import {
  extFromFileName,
  extToMime,
  mimeToExt,
  resolveImagePath,
} from '@/utils/imagePath'

/** 同步取 basename —— Tauri 的 basename() 是 async,NodeView 同步构造时用 */
function basenameSync(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

/**
 * 确保目录存在;不存在就 mkdir(recursive)。
 * 已存在 → no-op。失败 throw。
 */
async function ensureAssetsDir(dirPath: string): Promise<void> {
  if (!(await exists(dirPath))) {
    await mkdir(dirPath, { recursive: true })
  }
}

/**
 * 把一个 File 对象写到 absPath(覆盖式)。失败 throw。
 * File → Uint8Array → writeFile,所有错误透传。
 */
async function writeImageFile(absPath: string, file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  await writeFile(absPath, bytes)
}

// ========== 同内容去重 ==========
//
// 优化场景:用户从 doc 自己的 assets/ 里拖一张图进 editor,我们不再
// 复制一份 `image-{新ts}.{ext}`,直接复用已有文件,markdown src 也走
// 原文件名(`assets/foo.png`)。
//
// 用 SHA-256 内容哈希,不同名但同内容的图也能识别(比如用户在外部
// rename 过)。Web Crypto API(`crypto.subtle`)在 Tauri webview / 现代
// 浏览器都可用;jsdom 不支持 → 拿不到就直接返回 null 走正常落盘。

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  // crypto.subtle.digest 要 ArrayBuffer(不是 ArrayBufferLike)—— 严格模式下
  // Uint8Array.buffer 是 ArrayBufferLike,这里 slice 出独立的 ArrayBuffer
  const buffer: ArrayBuffer = data instanceof ArrayBuffer
    ? data
    : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  const hashBuf = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 在 `assetsDir` 里找跟 `file` 内容相同的文件。
 *  - 先用扩展名过滤一遍(避免无意义 hash)
 *  - 同扩展名的逐个 hash 比对
 *  - 找到 → 返回现有文件信息
 *  - 找不到 / crypto 不可用 / 目录不存在 → null(走正常落盘)
 */
async function findDuplicateInAssetsDir(
  file: File,
  assetsDir: string,
): Promise<{ absPath: string, fileName: string } | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null
  if (!(await exists(assetsDir))) return null

  let entries
  try {
    entries = await readDir(assetsDir)
  }
  catch {
    return null
  }
  if (!entries.length) return null

  const droppedExt = extFromFileName(file.name)
  const droppedHash = await sha256Hex(await file.arrayBuffer())

  for (const entry of entries) {
    if (!entry.isFile || !entry.name) continue
    // 扩展名过滤(不区分大小写 —— extFromFileName 已经 lowercase)
    if (extFromFileName(entry.name) !== droppedExt) continue

    const entryPath = await join(assetsDir, entry.name)
    try {
      const bytes = await readFile(entryPath)
      const entryHash = await sha256Hex(bytes)
      if (entryHash === droppedHash) {
        return { absPath: entryPath, fileName: entry.name }
      }
    }
    catch {
      // 读不到(权限 / 文件锁 / 文件被删了)→ 跳过这个,继续找下一个
    }
  }
  return null
}

// ========== 编排:粘贴 / 拖拽时一步落盘 ==========

export interface SaveImageAssetResult {
  /** 实际写入的磁盘绝对路径(给后续删除用) */
  absPath: string
  /** markdown src 字段应该写的字符串(有 path 走相对,无 path 走绝对) */
  srcForMarkdown: string
  /** 落盘的文件名(给差量跟踪 / 用户提示用) */
  fileName: string
}

export interface SaveImageAssetOptions {
  currentFilePath: string | null
  file: File
  /** 自定义 timestamp,缺省 Date.now() —— 测试用 */
  timestamp?: number
}

/**
 * 从磁盘路径加载图片并落盘到 doc 的 assets/(走和 saveImageAsset 一样的逻辑 + 去重)。
 * "选择本地文件"按钮调这个:用户从系统对话框选了一个文件,我们读它再保存。
 *
 * 失败 throw —— 调用方决定 fallback。
 */
export async function saveImageAssetFromPath(opts: {
  currentFilePath: string | null
  sourcePath: string
  timestamp?: number
}): Promise<SaveImageAssetResult> {
  const { currentFilePath, sourcePath, timestamp = Date.now() } = opts
  const bytes = await readFile(sourcePath)
  const filename = basenameSync(sourcePath)
  const ext = extFromFileName(filename)
  const mime = extToMime(ext)
  // File 构造器在 webview / 现代浏览器都可用
  const file = new File([bytes], filename, { type: mime })
  return saveImageAsset({ currentFilePath, file, timestamp })
}

/**
 * 把粘贴/拖拽的图片文件落盘到合适位置。
 *
 *  1. 拿 ext(file.type 优先,失败回退文件名后缀)
 *  2. 调纯函数 resolveImagePath 算 assetsDir / fileName / srcForMarkdown
 *  3. (v0.3.2 去重)扫 assetsDir 找内容相同的文件,有就复用 —— 避免
 *     "拖自己的图进去复制出一份新文件"
 *  4. ensureAssetsDir(mkdir recursive 兜底)
 *  5. writeFile 写盘
 *
 * 失败 throw —— 调用方决定是否 fallback 到 base64。
 */
export async function saveImageAsset(opts: SaveImageAssetOptions): Promise<SaveImageAssetResult> {
  const { currentFilePath, file, timestamp = Date.now() } = opts

  const ext = file.type ? mimeToExt(file.type) : extFromFileName(file.name)
  // mimeToExt 对未知 MIME 返回 'bin',此时降级到文件名后缀(如 .heic / .tiff)
  const finalExt = ext === 'bin' && file.name ? extFromFileName(file.name) : ext

  // currentFilePath=null 时 fileDir 用 '' 占位,resolveImagePath 不会读它
  const fileDir = currentFilePath !== null ? await dirname(currentFilePath) : ''
  const appData = await appDataDir()
  const appDataAssetsDir = `${appData}/assets`

  const resolved = resolveImagePath({
    currentFilePath,
    originalName: file.name,
    ext: finalExt,
    fileDir,
    appDataAssetsDir,
    timestamp,
  })

  // 去重:仅对有 currentFilePath 的 saved doc 生效(untitled 走 appDataAssetsDir,
  // appDataAssetsDir 下的去重不在 v0.3.2 范围内 —— 用户场景少)
  if (currentFilePath !== null) {
    const dup = await findDuplicateInAssetsDir(file, resolved.assetsDir)
    if (dup) {
      return {
        absPath: dup.absPath,
        srcForMarkdown: `assets/${dup.fileName}`,
        fileName: dup.fileName,
      }
    }
  }

  await ensureAssetsDir(resolved.assetsDir)
  const absPath = await join(resolved.assetsDir, resolved.fileName)
  await writeImageFile(absPath, file)

  return {
    absPath,
    srcForMarkdown: resolved.srcForMarkdown,
    fileName: resolved.fileName,
  }
}
