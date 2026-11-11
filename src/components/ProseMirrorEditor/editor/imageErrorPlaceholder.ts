// 图片加载失败占位符 —— 全项目唯一的 DOM 工厂 + 唯一的 error 绑定入口。
//
// 为什么收敛到一处:图片有四条命令式 DOM 渲染路径(image NodeView、diff 删除片段
// 的 DOMSerializer、HTML 块内 <img>、源码编辑态的预览 widget)。文案与形态必须
// 只有一份,否则本地 / 外链 / 文件被删会各长出一套提示。AssetPanel 的 Vue 模板
// 另有 @error 兜底,只共用图标。
//
// 语义:不区分来源。<img> 的 error 事件对 asset://、http(s)、data: 一视同仁,
// 也不需要 exists / stat 预检 —— 文件被删与 404 在浏览器里是同一个事件。
// 原始 src 只放进 title 供排查,不渲染第二行文案。
//
// 两种失败表现:
//  1. attachImageErrorFallback —— error 时 replaceWith 占位符。适用于 <img>
//     只是普通子节点(NodeView / HTML 块 / 已有稳定容器的 diff 删除片段)。
//  2. createImageErrorContainer —— 稳定容器内预放 img + 占位符,error 只切
//     class,零 DOM 增删。**PM Decoration.widget 的根节点必须用这个**:
//     WidgetViewDesc 持有 toDOM 返回的根节点引用,替换根节点会让 viewdesc 与
//     真实 DOM 在下次 renderDescs / destroy 时对不上。

import { imageOffSvg } from '@/components/icons/widgetIcons'

const ERROR_TEXT = '图片加载异常'

export const IMAGE_ERROR_CONTAINER_CLASS = 'velo-image-error-container'
export const IMAGE_ERROR_BROKEN_CLASS = 'is-broken'
export const IMAGE_ERROR_PENDING_CLASS = 'is-pending'

/** 生成占位 DOM。用 span 而非 div:diff 删除片段里的 <img> 可能位于 <p> 内。 */
export function createImageErrorPlaceholder(source?: string): HTMLSpanElement {
  const box = document.createElement('span')
  box.className = 'velo-image-error'
  if (source) box.title = source

  const icon = document.createElement('span')
  icon.className = 'velo-image-error-icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.innerHTML = imageOffSvg(20)

  const text = document.createElement('span')
  text.className = 'velo-image-error-text'
  text.textContent = ERROR_TEXT

  box.append(icon, text)
  return box
}

/** 给 <img> 挂一次性失败兜底,失败时原位替换成占位符。
 *
 * 必须用 addEventListener:HtmlNodeView 的 DOMPurify FORBID_ATTR 禁掉了内联
 * onerror。调用方要在给 img.src 赋值之前调用,否则 asset:// 的同步失败会漏掉。
 * 仅用于「<img> 不是 PM widget 根节点」的场景,见模块头注释。 */
export function attachImageErrorFallback(img: HTMLImageElement, source?: string): void {
  img.addEventListener('error', () => {
    const label = source || img.getAttribute('alt') || img.getAttribute('src') || ''
    img.replaceWith(createImageErrorPlaceholder(label))
  }, { once: true })
}

export interface ImageErrorContainer {
  /** 稳定根节点,始终留在 DOM 里,可安全作为 Decoration.widget 的 toDOM 返回值。 */
  root: HTMLSpanElement
  /** 调用方设置 class / alt / src 的目标;error 监听已挂好。 */
  img: HTMLImageElement
}

/** 创建「稳定容器 + img + 占位符」结构,失败时只给容器切 class。
 *
 * 用于 PM decoration widget:根节点不能被 replaceWith 掉,所以不能在 error 时
 * 增删 DOM。CSS 按 .is-pending / .is-broken 决定显示 img 还是占位符。
 * 占位符仍由 createImageErrorPlaceholder() 生成 —— 文案 / 图标只有一份。 */
export function createImageErrorContainer(
  source: string,
  rootClass = IMAGE_ERROR_CONTAINER_CLASS,
): ImageErrorContainer {
  const root = document.createElement('span')
  root.className = rootClass
  root.classList.add(IMAGE_ERROR_CONTAINER_CLASS)

  const img = document.createElement('img')
  img.addEventListener('error', () => {
    root.classList.remove(IMAGE_ERROR_PENDING_CLASS)
    root.classList.add(IMAGE_ERROR_BROKEN_CLASS)
  }, { once: true })

  root.append(img, createImageErrorPlaceholder(source))
  return { root, img }
}
