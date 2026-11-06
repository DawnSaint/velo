// 图片 src 解析:markdown 里的路径 → WebView 能加载的 URL。
//
// 主编辑器(EditorInner)与版本对比预览(WysiwygDiffView)必须共用这一份。
// 之前两边各写了一份「同逻辑」实现,diff view 那份少了「基于当前文档目录
// 把相对路径转绝对路径」这一步,直接对 `assets/x.png` 调 convertFileSrc,
// 结果 asset:// 指向一个不存在的相对位置,预览模式里本地图片全部裂图。
//
// 保持纯函数:currentFilePath 由调用方从 documentStore 取,本模块不依赖 Pinia,
// 也便于在 jsdom 里单测。不调 convertFileSrc 的情况一律原样返回。

import { convertFileSrc } from '@tauri-apps/api/core'
import { resolveImageAssetAbsPath } from './imagePath'

function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 外链 / data URI / 已经代理过的 asset:、tauri: 都不需要再转 */
const ALREADY_LOADABLE = /^(https?:|data:|asset:|tauri:)/

/**
 * @param url               markdown 里的 src(可能是相对 / 绝对 / 外链)
 * @param currentFilePath   当前打开文档的磁盘路径;null = 未命名文档
 */
export function resolveImageSrc(url: string, currentFilePath: string | null): string {
  if (!url || !isTauriEnv()) return url
  if (ALREADY_LOADABLE.test(url)) return url
  const absPath = resolveImageAssetAbsPath(url, currentFilePath)
  // 无 currentFilePath 且 src 本身是相对路径时,没有可靠的基准目录,原样返回
  if (!absPath.startsWith('/') && !/^[A-Z]:/i.test(absPath)) return absPath
  return convertFileSrc(absPath)
}
