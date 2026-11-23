// PDF 预览 / 导出共用的 Display List 类型。
//
// 一致性来源：预览直接绘制这份指令，导出把它序列化成 PDF；两者不共享慢引擎，
// 只共享同一棵布局结果。富片段以 id 引用，DOM 只存在于 fragments 表，
// 不进 Display List 本身 —— 布局结果保持纯数据，可缓存 / 可比较。

export type FontKey = 'sans' | 'bold' | 'mono'
export type PdfColor = string

export interface TextOp {
  op: 'text'
  x: number
  y: number
  size: number
  color: PdfColor
  font: FontKey
  gids: number[]
  /** 原始字符：DOM 预览与文本层调试用，PDF 绘制只用 gids */
  text: string
}

export interface RectOp {
  op: 'rect'
  x: number
  y: number
  w: number
  h: number
  fill: PdfColor
}

export interface StrokeRectOp {
  op: 'strokeRect'
  x: number
  y: number
  w: number
  h: number
  color: PdfColor
  width: number
}

export interface LineOp {
  op: 'line'
  x1: number
  y1: number
  x2: number
  y2: number
  color: PdfColor
  width: number
}

export interface FragmentOp {
  op: 'fragment'
  x: number
  y: number
  w: number
  h: number
  id: string
}

/**
 * 自写 HTML 行内标签的底衬（kbd / mark / sub / sup / abbr / 自定义标签）。
 *
 * 与 text 算子同层画，能叠加在任何文字上：mark 就是半透明黄底 + 上方文字；
 * kbd 是圆角边框 + 2px 下沿（近似 CSS 的 border-bottom-width:2px）+ 内边距。
 * DOM 预览复用 previewRenderer 已有的 roundedRect / strokeRect 算子。
 */
export interface DecoOp {
  op: 'deco'
  x: number
  y: number
  w: number
  h: number
  /** 背景填充（mark 用；无则 null） */
  fill?: PdfColor | null
  /** 描边色（kbd / 自定义边框用；无则 null） */
  stroke?: PdfColor | null
  /** 描边宽度（同时决定下沿加粗量） */
  width?: number
  radius?: number
}

/**
 * 链接热区。放在 text 算子**之后**入栈，PDF 里注释也画在文字上层；
 * 因为 /Border [0 0 0] 不描边，不影响观感。合并自同一链接的连续矩形，
 * 避免一个跨行链接产生几十条注解。
 */
export interface LinkOp {
  op: 'link'
  /** 页内锚点名（内部跳转）；与 uri 二选一 */
  dest?: string
  /** 外部地址（https: / mailto: 等） */
  uri?: string
  /** 该链接在本页的矩形（左上角原点、y 向下、pt），可多块 */
  rects: { x: number; y: number; w: number; h: number }[]
}

export type DisplayOp = TextOp | RectOp | StrokeRectOp | LineOp | FragmentOp | LinkOp | DecoOp

export interface PdfPage {
  ops: DisplayOp[]
}

/** 命名目标：名字 → 落点页 + 页内坐标（左上角原点、y 向下） */
export interface PdfDestinations {
  [name: string]: { page: number; x: number; y: number }
}

/** 位图富片段（A 档）：JPEG 字节可直接作 /DCTDecode 流 */
export interface FragmentImage {
  jpeg: Uint8Array
  pxW: number
  pxH: number
}

/**
 * 富片段：预览用真实 DOM，导出用矢量内容流（B 档）或位图（A 档）。
 * pdf 与 image / rasterize 至少有一个；都没有时降级为文本并进 warnings。
 */
export interface RichFragment {
  id: string
  kind: 'katex-inline' | 'katex-block' | 'mermaid' | 'code' | 'image'
  /** 版面上的尺寸（pt）—— 随字号 / 内容宽度变化由 layoutEngine 覆盖 */
  w: number
  h: number
  previewEl: Element
  /** B 档：PDF 内容流，使用「已翻转成 y 向上」的 SVG 用户坐标（不含外层 q/Q） */
  pdf: string | null
  /** B 档内容源的 viewBox 尺寸，PdfWriter 用它算缩放 */
  srcW: number
  srcH: number
  /**
   * 内容盒（CSS px）。A 档主路径已按真实像素裁剪过：contentSize 就是位图
   * 尺寸、contentOffset 为 {0,0}，预览 <img> 直接铺满。只有 foreignObject
   * 不可用、退回 DOM 预览的兜底路径才用非零偏移平移溢出的 KaTeX 行盒。
   */
  contentSize: { w: number; h: number }
  contentOffset: { x: number; y: number }
  /** A 档：位图（JPEG）字节；主路径在 buildPdf 阶段即就绪，导出不再二次光栅化 */
  image: FragmentImage | null
  /** A 档兜底：foreignObject 不可用时的惰性光栅化 */
  rasterize?: () => Promise<FragmentImage | null>
  /** 降级时显示的纯文本 */
  fallbackText?: string
}

export interface PdfDocument {
  pages: PdfPage[]
  fragments: Record<string, RichFragment>
  /** 内部锚点表：relayout 时按当前分页重建 */
  destinations: PdfDestinations
  warnings: string[]
  missingGlyphs: string[]
  pageWidth: number
  pageHeight: number
  options: PdfLayoutOptions
}

/**
 * 页边距（mm）。面板只暴露「水平 / 垂直」两项：
 * horizontal → 左右，vertical → 上下（多数文档左右、上下各自对称）。
 */
export interface PdfMargins {
  horizontal: number
  vertical: number
}

/** 可选纸张（宽度 / 高度单位 pt，与 PDF 用户单位一致）。 */
export type PdfPaperSize = 'a4' | 'a5' | 'letter' | 'legal'

export interface PdfPaperSpec {
  /** 下拉里展示的名字（含尺寸标注） */
  label: string
  width: number
  height: number
}

/**
 * 纸张表。A 系列由 mm 折算（×72/25.4），Letter / Legal 由英寸折算（×72）。
 * 新增纸张只需在这里加一条 + 给 PdfPaperSize 加字面量。
 */
export const PDF_PAPER_SIZES: Record<PdfPaperSize, PdfPaperSpec> = {
  a4: { label: 'A4 · 210 × 297 mm', width: 595.28, height: 841.89 },
  a5: { label: 'A5 · 148 × 210 mm', width: 419.53, height: 595.28 },
  letter: { label: 'Letter · 8.5 × 11 in', width: 612, height: 792 },
  legal: { label: 'Legal · 8.5 × 14 in', width: 612, height: 1008 },
}

export interface PdfLayoutOptions {
  /** mm —— 面板里用户实时调整的值 */
  margins: PdfMargins
  /** 纸张；不传按 A4 */
  paperSize?: PdfPaperSize
  /** pt —— 正文基准字号 */
  fontSize: number
  /** 倍数 —— 行高 / 字号 */
  lineHeight: number
  showHeader: boolean
  showFooter: boolean
  headerText: string
  dark: boolean
  /**
   * 主题主色（编辑器 primaryColor）。webview 侧脚注引用 / 回链取
   * `--md-doc-primary-color`，未开启「主题色影响正文」时回退 #1F71D9；
   * 不传按默认主色。
   */
  primaryColor?: string
}

export const DEFAULT_PDF_LAYOUT_OPTIONS: PdfLayoutOptions = {
  margins: { horizontal: 16, vertical: 18 },
  paperSize: 'a4',
  fontSize: 12,
  lineHeight: 1.75,
  showHeader: false,
  showFooter: true,
  headerText: '',
  dark: false,
  primaryColor: '#1F71D9',
}

export const MM_TO_PT = 72 / 25.4
/** CSS px → PDF pt（96dpi） */
export const PX_TO_PT = 0.75

/** 构建 PDF 文档所需的源文件上下文（内容与主题；不含实时可调的版式参数）。 */
export interface PdfSource {
  content: string
  /** 当前 .md 路径，用于解析相对图片；null 表示未命名文档 */
  currentFilePath: string | null
  lightTheme: string
  darkTheme: string
}
