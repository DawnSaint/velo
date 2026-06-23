// ========== 同步路径工具 ==========

/**
 * 同步取 dirname。Tauri 的 dirname() 是 async,proxyDomURL 这种同步回调
 * 走不了。简单字符串处理够用 —— Tauri convertFileSrc 内部会规范化。
 */
export function dirnameSync(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? '' : p.slice(0, i)
}

/**
 * 把 markdown 里的 image src 转成磁盘绝对路径(用于 Tauri fs API):
 *  - 有 currentFilePath:相对路径 → 拼到 docDir 后面;绝对路径 → 原样
 *  - 无 currentFilePath(untitled):src 原样返回(它本身就是绝对路径)
 *
 * 不调 convertFileSrc —— 这一层只算"磁盘位置",asset 协议转换是渲染层的事。
 * 输出统一 forward slashes(Tauri 偏好),即便输入有混合斜杠。
 */
export function resolveImageAssetAbsPath(
  src: string,
  currentFilePath: string | null,
): string {
  if (!currentFilePath) return src
  const docDir = dirnameSync(currentFilePath)
  if (src.startsWith('/') || /^[A-Z]:/i.test(src)) return src.replace(/\\/g, '/')
  return `${docDir}/${src}`.replace(/\\/g, '/')
}

// ========== 落点决策 ==========

export interface ResolvedImagePath {
  /** 图片所在的目录(磁盘上,调用方再 join fileName) */
  assetsDir: string
  /** 完整文件名,例如 "image-1700000000000.png" */
  fileName: string
  /** 写到 markdown src 字段的字符串(有 path 走相对,无 path 走绝对) */
  srcForMarkdown: string
}

/**
 * 决定一张粘贴/拖拽图片的落点和 markdown src。纯函数,便于单测。
 *
 *  - 有 currentFilePath:落 <fileDir>/assets/,src 写 "assets/<name>"(相对)
 *  - 无 currentFilePath:落 <appDataAssetsDir>,src 写绝对路径
 *
 * fileDir 预期来自 Tauri `dirname()`(forward-slash),Tauri 2 在 Windows 上
 * 也会规范化成 `/`。srcForMarkdown 不做 normalize,按字面拼 —— 因为有 path
 * 的情况 src 必然是相对路径 "assets/...";无 path 的情况用 `<appDataAssetsDir>/<fileName>`
 * 也是 forward-slash。
 *
 * 同毫秒多次粘贴会撞名。当前用 timestamp 区分,极端密集场景(counter / random)
 * 留到出现 bug 再加。
 */
export function resolveImagePath(opts: {
  currentFilePath: string | null
  /** 原文件名(用于 debug/审计,目前不参与命名) */
  originalName: string
  /** 扩展名,不含点,如 "png" */
  ext: string
  /** dirname(currentFilePath);currentFilePath 为 null 时忽略 */
  fileDir: string
  /** appDataDir()/assets */
  appDataAssetsDir: string
  /** 毫秒时间戳,用于文件名唯一性 */
  timestamp: number
}): ResolvedImagePath {
  const { currentFilePath, ext, fileDir, appDataAssetsDir, timestamp } = opts
  const fileName = `image-${timestamp}.${ext}`
  if (currentFilePath !== null) {
    return {
      assetsDir: `${fileDir}/assets`,
      fileName,
      srcForMarkdown: `assets/${fileName}`,
    }
  }
  return {
    assetsDir: appDataAssetsDir,
    fileName,
    srcForMarkdown: `${appDataAssetsDir}/${fileName}`,
  }
}

// ========== 扩展名工具 ==========

/**
 * 支持的图片扩展名(不含点,小写)。
 * 与 mimeToExt / extToMime 的覆盖范围一致 —— 这是图片落盘 / 文件树过滤 /
 * drop 分流的单一真相源,避免三处各写一份正则散落。
 */
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] as const

/** 扩展名(不含点,大小写不敏感)是否是支持的图片类型。 */
export function isImageExt(ext: string): boolean {
  return (IMAGE_EXTS as readonly string[]).includes(ext.toLowerCase())
}

/**
 * MIME type → 文件扩展名(不含点)。仅覆盖常见图片类型,未知返回 'bin'。
 * 优先用 file.type 拿 MIME,失败时回退到文件名后缀(见 extFromFileName)。
 */
export function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png'
    case 'image/jpeg':
    case 'image/jpg': return 'jpg'
    case 'image/gif': return 'gif'
    case 'image/webp': return 'webp'
    case 'image/svg+xml': return 'svg'
    case 'image/bmp': return 'bmp'
    case 'image/avif': return 'avif'
    default: return 'bin'
  }
}

/**
 * 从文件名取扩展名(小写,不含点)。
 *   'foo.png'        → 'png'
 *   'foo.bar.png'    → 'png'   多个点取最后一个
 *   'foo'            → 'bin'   无扩展
 *   'foo.'           → 'bin'   末尾只有点不算
 */
export function extFromFileName(name: string): string {
  const i = name.lastIndexOf('.')
  if (i === -1 || i === name.length - 1) return 'bin'
  return name.slice(i + 1).toLowerCase()
}

/**
 * 扩展名 → MIME type。仅覆盖常见图片,未知 → 'application/octet-stream'。
 * "选择本地文件"流程用:Tauri dialog.open 拿到的是路径,要造一个 File 对象
 * 给 saveImageAsset,需要 MIME,所以走扩展名查表(路径里没有 MIME 信息)。
 */
export function extToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'svg': return 'image/svg+xml'
    case 'bmp': return 'image/bmp'
    case 'avif': return 'image/avif'
    default: return 'application/octet-stream'
  }
}
