// ProseMirror Widget innerHTML 专用的 SVG 字符串源。
//
// 为什么单独存在:Widget(代码块工具栏 / mermaid 工具栏 / TOC 删除按钮)
// 通过 innerHTML 注入 DOM,拿不到 Vue 组件实例,只能用字符串。集中在此
// 消除原本散落在 CodeHighlightWidget.ts / MermaidDecoration.ts /
// TocDecoration.ts 三处各自复制 chevron / trash 的问题。
//
// path 与 @lucide/vue 同名图标对齐;尺寸通过 size 参数传入,避免同一图标
// 在不同工具栏用不同尺寸时各抄一份。

/** 拼 complete <svg> 字符串,内部固定 24×24 网格 / lucide 描边约定。 */
function makeSvg(inner: string, size: number, strokeWidth = 2): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}">${inner}</svg>`
}

const CHEVRON_DOWN_INNER = '<polyline points="6 9 12 15 18 9" />'
const CHEVRON_UP_INNER = '<polyline points="18 15 12 9 6 15" />'
const COPY_INNER
  = '<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />'
  + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />'
const CHECK_INNER = '<polyline points="20 6 9 17 4 12" />'
// code-xml:lucide 标准 path(左 < + 右 > + 中间斜杠 /)
const CODE_XML_INNER
  = '<path d="m18 16 4-4-4-4" />'
  + '<path d="m6 8-4 4 4 4" />'
  + '<path d="m14.5 4-5 16" />'
// wrap-text:lucide 标准 path(横线 + 弯曲箭头,表示自动换行)
const WRAP_TEXT_INNER
  = '<line x1="3" y1="6" x2="21" y2="6" />'
  + '<path d="M3 12h15a3 3 0 0 1 0 6h-4" />'
  + '<polyline points="16 16 14 18 16 20" />'
  + '<line x1="3" y1="18" x2="10" y2="18" />'
// nowrap:横线 + 右箭头,表示文本向右溢出不换行(与 wrap-text 对仗)
const NOWRAP_INNER
  = '<line x1="3" y1="6" x2="21" y2="6" />'
  + '<line x1="3" y1="12" x2="18" y2="12" />'
  + '<polyline points="15 9 18 12 15 15" />'
  + '<line x1="3" y1="18" x2="21" y2="18" />'
// Trash2:lucide 标准 path(lid + body 合并,line 表中间两条竖线)
const TRASH_INNER
  = '<polyline points="3 6 5 6 21 6" />'
  + '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />'
  + '<line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />'

/** 向下箭头(代码块语言下拉、mermaid 收起)。 */
export const chevronDownSvg = (size: number): string => makeSvg(CHEVRON_DOWN_INNER, size)

/** 向上箭头(mermaid 展开)。 */
export const chevronUpSvg = (size: number): string => makeSvg(CHEVRON_UP_INNER, size)

/** 复制图标(代码块复制按钮)。 */
export const copySvg = (size: number): string => makeSvg(COPY_INNER, size)

/** 对勾(代码块复制成功 flash)。描边略粗(2.5)以增强确认感。 */
export const checkSvg = (size: number): string => makeSvg(CHECK_INNER, size, 2.5)

/** 垃圾桶(mermaid 删除、TOC 删除)。 */
export const trashSvg = (size: number): string => makeSvg(TRASH_INNER, size)

/** code-xml 图标(图片源码编辑按钮)。 */
export const codeXmlSvg = (size: number): string => makeSvg(CODE_XML_INNER, size)

/** 自动换行图标(代码块 wrap toggle 按钮,wrap 开启态)。 */
export const wrapTextSvg = (size: number): string => makeSvg(WRAP_TEXT_INNER, size)

/** 不换行图标(代码块 wrap toggle 按钮,wrap 关闭态:横线 + 右箭头表示溢出)。 */
export const nowrapSvg = (size: number): string => makeSvg(NOWRAP_INNER, size)
