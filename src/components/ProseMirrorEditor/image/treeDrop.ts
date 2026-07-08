// 内部拖拽 → 编辑器的共享逻辑:把"从 velo 内部拖一行进编辑器"抽成共享接口,
// 让富文本(imageUploadPlugin)与源码模式(SourceModeEditor)走同一条决策路径。
//
// 两种内部来源:
//  - 树拖:FileTree.vue onRowDragStart 把 fullPath 写进 application/x-velo-tree-path
//    (自定义 MIME,避免与 OS 拖文件进来的 text/uri-list 混淆)。
//  - 资产面板拖:AssetPanel.vue onAssetDragStart 把 { src, alt } JSON 写进
//    application/x-velo-asset-image(图片已在磁盘上,不需落盘,直接插图)。
//  - OS 拖:走原生 dataTransfer.files(imageUploadPlugin 的 Files 通道)。
//
// 树拖决策(树路径非空时):
//  - .md/.markdown/.mdown:打开文件 —— confirmDiscardIfDirty 通过后 openPath + setLastFile
//  - 图片扩展名:落盘(saveImageAssetFromPath)→ 走回调插图
//    (富文本插 image 节点;源码模式插 ![](src) markdown 文本)
//  - 其它:忽略(return false 让默认/后续处理器接管)
//
// 资产面板拖决策:直接用携带的 src + alt 插图,不落盘(图片已在磁盘上 / 是外链 URL)。
//
// 落盘复用 imageStorage.saveImageAssetFromPath —— 它从磁盘路径造 File 再走
// saveImageAsset 的同一套(去重 + resolveImagePath),与粘贴/OS 拖图完全一致。

import { useDocumentStore } from '@/stores/document'
import { useWorkspaceStore } from '@/stores/workspace'
import { saveImageAssetFromPath, type SaveImageAssetResult } from '@/utils/imageStorage'
import { isImageExt } from '@/utils/imagePath'
import { isMarkdownPath } from '@/utils/markdownPath'

/** 文件树行 → 编辑器的拖拽信号 MIME(与 FileTree.vue 的 TREE_PATH_MIME 保持一致)。
 *  只在拖**文件**(.md / 图片 / 其它)时写;拖目录走 TREE_DIR_PATH_MIME,编辑器
 *  侧只看 TREE_PATH_MIME → 目录拖入编辑器自然不触发任何处理(也不携带 text/plain
 *  让 PM 当文本插)。 */
export const TREE_PATH_MIME = 'application/x-velo-tree-path'

/** 文件树 → 文件树内部:目录拖拽的独立 MIME。编辑器侧不识别此 MIME,故目录
 *  无法拖入编辑器(预期行为);FileTree 内部 drop 同时接受两种 MIME 走 rename。 */
export const TREE_DIR_PATH_MIME = 'application/x-velo-tree-dir-path'

/** 资产面板 → 编辑器:图片条目拖拽的自定义 MIME。
 *  与 TREE_PATH_MIME 不同——资产面板的图片已在磁盘上(本地图片)或是外链 URL,
 *  不需要落盘,只需直接插入 image 节点 / markdown 文本。
 *  数据为 JSON 字符串 `{ src: string, alt: string }`。 */
export const ASSET_IMAGE_MIME = 'application/x-velo-asset-image'

export interface AssetImageData {
  src: string
  alt: string
}

/** 从 dataTransfer 解析资产面板图片拖拽数据。非资产面板拖拽返回 null。 */
export function parseAssetImageMime(dt: DataTransfer | null | undefined): AssetImageData | null {
  if (!dt?.types || !Array.from(dt.types).includes(ASSET_IMAGE_MIME)) return null
  try {
    const raw = dt.getData(ASSET_IMAGE_MIME)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (typeof data?.src !== 'string') return null
    return { src: data.src, alt: typeof data.alt === 'string' ? data.alt : '' }
  }
  catch {
    return null
  }
}

/**
 * 从 FileList 里挑第一个 image/* 文件;没有返回 null。
 * 富文本(imageUploadPlugin)与源码模式(SourceModeEditor)共用 —— 避免两处各写一份。
 */
export function pickImageFile(fileList: FileList | null | undefined): File | null {
  if (!fileList) return null
  for (let i = 0; i < fileList.length; i++) {
    const f = fileList[i]
    if (f && f.type && f.type.startsWith('image/')) return f
  }
  return null
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? p : p.slice(i + 1)
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  if (i === -1 || i === name.length - 1) return ''
  return name.slice(i + 1)
}

/**
 * 把文件名 / 路径里可能破坏 markdown 链接语法的字符转义掉。
 *  - alt 里的 `[` `]` 会被 CommonMark 当成 reference link / 结束 alt → `\[` `\]`
 *  - src 里的 `(` `)` 同理 → `\(` `\)`,空格保留(CommonMark 允许行内有空格)
 *
 * 抽出来共用:富文本走 image 节点的 attrs 不需要转(PM 写盘时由 markdownIO 处理),
 * 但源码模式 / OS 拖图直接把文本插进 markdown 串,必须自己保护好语法。
 */
export function escapeMdAlt(s: string): string {
  return s.replace(/[\\\[\]]/g, m => `\\${m}`)
}
export function escapeMdUrl(s: string): string {
  return s.replace(/[\\()]/g, m => `\\${m}`)
}

export interface TreeDropResult {
  /** true = 已处理(preventDefault + 自行落地);false = 不是树拖,放行给后续处理器 */
  handled: boolean
}

/** insertImage 回调签名:第三个参数是 drop 当时的 currentFilePath snapshot,
 *  调用方据此判断"落盘期间用户是否切走了文档",切走了应当跳过插入(避免插到新 doc 里). */
export type InsertImageFn = (
  result: SaveImageAssetResult,
  alt: string,
  capturedCurrentFilePath: string | null,
) => void

/**
 * 处理一次 drop 事件中的"文件树路径"来源。
 *
 * @param event 原生 DragEvent
 * @param insertImage 落盘成功后,用结果(srcForMarkdown + 原 alt + drop 当时的 currentFilePath
 *                    snapshot)执行模式特定的插入。
 *                    富文本:造 image 节点 dispatch;源码模式:插 ![](src) 文本。
 *                    传入是为异步落盘后回调 —— saveImageAssetFromPath 是 async。
 *                    capturedCurrentFilePath 让调用方能识别"落盘期间用户切了文档" race —— 切了就跳过插入,
 *                    因为 result.srcForMarkdown 是相对旧 doc 的 assets/ 算的,新 doc 用上就错。
 * @returns handled —— 调用方据此决定 preventDefault / 是否 return true
 */
export async function handleTreePathDrop(
  event: DragEvent,
  insertImage: InsertImageFn,
): Promise<TreeDropResult> {
  const dt = event.dataTransfer
  const path = dt?.getData(TREE_PATH_MIME)
  if (!path) return { handled: false }

  // 是树拖就一律接管,不让浏览器/CM 把 text/plain 当文本插进来
  event.preventDefault()

  const name = basename(path)

  // .md → 打开到新标签(与 FileTree.onFileClick 同路径:openPathInTab + setLastFile)
  if (isMarkdownPath(name)) {
    const documentStore = useDocumentStore()
    const ok = await documentStore.openPathInTab(path)
    if (ok) useWorkspaceStore().setLastFile(path)
    return { handled: true }
  }

  // 图片 → 落盘 + 插入
  if (isImageExt(extOf(name))) {
    const documentStore = useDocumentStore()
    // snapshot:saveImageAssetFromPath 完成后可能用户已切走文档(并发 .md drop /
    // 外部 fs.watch 触发 openPath / 手动点别的文件)。capture 现状,callback 里比对。
    const captured = documentStore.currentFilePath
    try {
      const result = await saveImageAssetFromPath({
        currentFilePath: captured,
        sourcePath: path,
      })
      insertImage(result, name, captured)
    }
    catch (e) {
      console.error('拖入图片落盘失败', path, e)
    }
    return { handled: true }
  }

  // 其它扩展名(树里理论上不会出现,但兜底):吞掉,不插垃圾文本
  return { handled: true }
}
