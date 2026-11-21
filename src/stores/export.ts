// 导出 store —— 把当前 markdown 文档导出为 PDF (默认) / Word / HTML。
//
// 设计要点:
// 1) **内置导出面板优先**:`openExportPanel()` 打开 ExportPanel,让用户先选类型
//    (PDF / Word / HTML) + 确认文件名,再走系统 saveDialog 选路径。类型选择
//    内置化后,系统框只负责「存哪」,不再兼管「存成什么」。
// 2) **saveDialog 多 filter,PDF 排第一**:面板确认后按所选类型**锁死** filter
//    (不再暴露三个选项),默认路径后缀与类型一致 —— 用户回车即走该类型。
//    程序化调用仍可 `exportDocument(type)` 直接导出(默认 pdf)。
// 3) **HTML 路径**:`buildExportHtml` 生成完整 HTML 字符串 → `writeTextFile` 落盘。
//    自包含(所有 CSS inline),用户拿到 HTML 任何浏览器都能开。
// 3b) **Word 路径**:`buildExportDocx`(复用 htmlRenderer + docx.js
//     `htmlToContent`)→ `writeFile` 写二进制。图片 / SVG 由 docxRenderer
//     走 inlineAssets 自包含。选型见 docs/research/export-more.md。
// 4) **PDF 路径 (v0.4.7 后)**:`invoke('export_pdf', { outputPath, html })` 调
//    平台原生 PrintToPDF API (Windows WebView2 ICoreWebView2_7::PrintToPdf),
//    静默写到 target 路径,无任何系统对话框。HTML 已经在前端 buildExportHtml
//    渲染好,只把字符串传给 Rust 端。Rust 端在一个**隐藏的打印专用 webview 窗口**
//    里 navigate(data:...) + PrintToPdf,主应用 webview 全程不动 —— 这样
//    `invoke` 的 promise 能正常 resolve,下面才能弹成功 / 失败反馈。
//    macOS / Linux 当前在 Rust 端返回 PdfError::Unsupported,前端把它映射成
//    "PDF 导出当前平台暂不支持" 错误提示。
// 5) **成功 / 失败反馈**:成功弹 Toast success 告知路径;失败弹 Toast error
//    (同 document.ts)。早先 PDF 导出后主 webview 被 navigate 走导致
//    JS 上下文销毁,既看不到反馈、顶栏也回不来 —— 隐藏窗口方案同时解决这两点。
//
// 6) **PDF 预览(未发版)**:`pdf-preview` 是第 4 个面板选项,不是新格式 ——
//    确认后打开 PdfPreviewPanel,实时调页边距 / 字号 / 行距 / 页眉页脚,
//    由前端 Display List 直接写 PDF(不依赖 WebView2,三平台一致)。旧 PDF
//    路径保持不变。见 docs/architecture/export.md。
//
// 不动 currentFilePath / lastSavedContent / fs:watch —— 导出是"产出一份
// 静态文件",不是"切换到那个文件继续编辑",跟保存 / 另存为是不同语义。

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { save as saveDialog } from '@/tauri/dialog'
import { writeTextFile, writeFile } from '@/tauri/fs'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { formatError } from '@/utils/formatError'
import { useDocumentStore } from './document'
import { useEditorStore } from './editor'
import { useNotifyStore } from './notify'
import type { buildExportHtml } from '@/lib/export/htmlRenderer'
import type { buildExportDocx } from '@/lib/export/docxRenderer'

// ========== 导出类型 ==========

export type ExportType = 'pdf' | 'docx' | 'html' | 'pdf-preview'

export interface ExportTypeSpec {
  type: ExportType
  /** 面板 / filter 显示名 */
  label: string
  /** 主扩展名(默认路径后缀) */
  ext: string
  /** saveDialog filter 覆盖的扩展名 */
  exts: string[]
  /** 一句话说明,面板里展示 */
  desc: string
}

/**
 * 支持的导出类型。顺序即面板展示顺序,PDF 在前(默认推荐)。
 *
 * `pdf-preview` 不是「另一种文件格式」,而是一个入口:选中后打开分页预览面板,
 * 在面板里调页边距 / 字号 / 行距 / 页眉页脚并实时重排,再由前端 Display List
 * 直接写出 PDF。与旧 `pdf`(WebView2 PrintToPdf)互不干扰,三平台一致。
 * 方案评估见 docs/research/pdf-preview.md 附录 C。
 */
export const EXPORT_TYPES: ExportTypeSpec[] = [
  { type: 'pdf', label: 'PDF', ext: 'pdf', exts: ['pdf'], desc: '版式与分页最稳，适合分享 / 打印' },
  { type: 'docx', label: 'Word', ext: 'docx', exts: ['docx'], desc: '保留样式，便于二次编辑' },
  { type: 'html', label: 'HTML', ext: 'html', exts: ['html', 'htm'], desc: '自包含单文件，浏览器直接打开' },
  { type: 'pdf-preview', label: 'PDF 预览', ext: 'pdf', exts: ['pdf'], desc: '实时分页预览 · 可调边距字号' },
]

function specOf(type: ExportType): ExportTypeSpec {
  return EXPORT_TYPES.find(t => t.type === type) ?? EXPORT_TYPES[0]
}

// 懒加载导出渲染:htmlRenderer 顶层静态 import 了 katexCss + fontFaceCss,二者
// 各自 import.meta.glob(?inline, eager) 把 base64 字体(20 katex woff2 + 24 内嵌等宽字体 woff2)
// 烘进模块。若 eager 走静态 import,这 ~845KB 常驻主 bundle —— 即使用户从不导出。
// 推迟到首次导出才加载(用户点导出时多一次 chunk fetch,可接受,与 katex 懒加载同范式)。
// type 只用 `Parameters<typeof buildExportHtml>[0]`,import type 在运行时擦除不拉模块。
let exportHtmlMod: Promise<typeof import('@/lib/export/htmlRenderer')> | null = null
function loadExportHtml() {
  if (!exportHtmlMod) exportHtmlMod = import('@/lib/export/htmlRenderer')
  return exportHtmlMod
}

// docxRenderer 顶层静态 import docx(20MB 包,实际 tree-shake 后小得多)——
// 同 htmlRenderer 的理由推迟到首次导出才加载,不让主 bundle 常驻。
let exportDocxMod: Promise<typeof import('@/lib/export/docxRenderer')> | null = null
function loadExportDocx() {
  if (!exportDocxMod) exportDocxMod = import('@/lib/export/docxRenderer')
  return exportDocxMod
}

/**
 * 计算默认 save 路径:有 fileName 用它(去掉原扩展名后补目标类型后缀),
 * 无则用 `untitled.<ext>`。补后缀是为了让 saveDialog 默认走对应类型 filter。
 */
function defaultExportPath(fileName: string | null, type: ExportType): string {
  const base = !fileName || fileName === '未命名'
    ? 'untitled'
    : fileName.replace(/\.[^.]+$/, '')
  return `${base}.${specOf(type).ext}`
}

export const useExportStore = defineStore('export', () => {
  /** 标记导出进行中,UI 可据此 disable 按钮 / 显示 spinner。 */
  const exporting = ref(false)

  // ========== 内置导出面板状态 ==========
  const panelOpen = ref(false)
  /** 当前选中的导出类型(面板分段控件)。 */
  const selectedType = ref<ExportType>('pdf')
  /** 面板里的文件名(不含扩展名)。 */
  const panelFileName = ref('')
  /** PDF 预览面板开关 + 默认导出文件名。 */
  const previewOpen = ref(false)
  const previewFileName = ref('')

  /**
   * 主入口。面板确认后调用;也可直接程序化调用(默认 PDF)。
   * @param type 导出类型
   * @param name 覆盖默认文件名(不含扩展名);null 用当前文档名
   */
  async function exportDocument(type: ExportType = 'pdf', name: string | null = null): Promise<boolean> {
    const notify = useNotifyStore()
    if (exporting.value) return false
    if (!isTauri()) {
      notify.info('导出功能仅在桌面端可用')
      return false
    }
    // 预览入口不落盘,只开面板;参数调完后由 PdfPreviewPanel 自己写 PDF。
    if (type === 'pdf-preview') {
      openPdfPreview(name)
      return true
    }
    const docStore = useDocumentStore()
    const editorStore = useEditorStore()
    const spec = specOf(type)
    const target = await saveDialog({
      filters: [{ name: spec.label, extensions: spec.exts }],
      defaultPath: defaultExportPath(name ?? docStore.fileName, type),
    })
    if (!target) return false
    const lower = target.toLowerCase()
    const isPdf = lower.endsWith('.pdf')
    const isDocx = lower.endsWith('.docx')
    exporting.value = true
    let succeeded = false
    const opts: Parameters<typeof buildExportHtml>[0] = {
      content: docStore.content,
      fileName: docStore.fileName,
      darkMode: editorStore.darkMode,
      primaryColor: editorStore.primaryColor,
      applyThemeColorToContent: editorStore.themeColorAffectsDoc,
      fontFamily: editorStore.fontFamily,
      fontMono: editorStore.fontMono,
      fontSize: editorStore.fontSize,
      currentFilePath: docStore.currentFilePath,
      lightTheme: editorStore.codeLightTheme,
      darkTheme: editorStore.codeDarkTheme,
    }
    try {
      if (isPdf) await exportToPdf(target, opts)
      else if (isDocx) await exportToDocx(target, opts)
      else await exportToHtml(target, opts)
      succeeded = true
    }
    catch (e) {
      console.error('导出失败', e)
      notify.error(`导出失败:${formatError(e)}`)
    }
    finally {
      exporting.value = false
    }
    // 成功才弹成功提示 —— 放在 catch 之外,免得 toast 本身抛错被当成"导出失败"。
    if (succeeded) {
      notify.success(`已导出:${target}`)
      return true
    }
    return false
  }

  /** 打开内置导出面板(文件菜单 / 命令面板 / 快捷键共用)。 */
  function openExportPanel(): void {
    if (exporting.value) return
    if (!isTauri()) {
      useNotifyStore().info('导出功能仅在桌面端可用')
      return
    }
    const docStore = useDocumentStore()
    const raw = docStore.fileName
    panelFileName.value = !raw || raw === '未命名' ? '' : raw.replace(/\.[^.]+$/, '')
    selectedType.value = 'pdf'
    panelOpen.value = true
  }

  function closeExportPanel(): void {
    panelOpen.value = false
  }

  function selectExportType(type: ExportType): void {
    selectedType.value = type
  }

  /** 打开 PDF 预览面板(导出面板确认 / 程序化调用共用)。 */
  function openPdfPreview(name: string | null = null): void {
    const raw = name ?? useDocumentStore().fileName
    previewFileName.value = !raw || raw === '未命名' ? '' : raw.replace(/\.[^.]+$/, '')
    previewOpen.value = true
  }

  function closePdfPreview(): void {
    previewOpen.value = false
  }

  /** 面板确认:关闭面板并按所选类型导出 / 打开预览。 */
  async function confirmExportPanel(): Promise<void> {
    const type = selectedType.value
    const name = panelFileName.value.trim()
    panelOpen.value = false
    if (type === 'pdf-preview') {
      openPdfPreview(name || null)
      return
    }
    await exportDocument(type, name || null)
  }

  /**
   * HTML 导出:buildExportHtml + writeTextFile
   * 失败抛错由 exportDocument 外层 catch + Toast 兜底。
   */
  async function exportToHtml(target: string, opts: Parameters<typeof buildExportHtml>[0]): Promise<void> {
    const { buildExportHtml } = await loadExportHtml()
    const { html } = await buildExportHtml(opts)
    await writeTextFile(target, html)
  }

  /**
   * DOCX 导出:buildExportDocx(复用 htmlRenderer + docx.js htmlToContent)
   * → writeFile 写二进制。图片 / SVG 由 docxRenderer 走 inlineAssets 自包含。
   * 失败抛错由 exportDocument 外层 catch + Toast 兜底。
   */
  async function exportToDocx(target: string, opts: Parameters<typeof buildExportDocx>[0]): Promise<void> {
    const { buildExportDocx } = await loadExportDocx()
    const { bytes } = await buildExportDocx(opts)
    await writeFile(target, bytes)
  }

  /**
   * PDF 导出 (v0.4.7 后):`invoke('export_pdf', { outputPath, html })` 调
   * Rust 端通过 Tauri `with_webview` 拿平台原生 PrintToPDF API (Windows
   * WebView2 ICoreWebView2_7::PrintToPdf) 静默生成 PDF,写到 outputPath。
   *
   * Rust 端在一个**隐藏的打印专用 webview 窗口**里 navigate(data:...) +
   * PrintToPdf,主应用 webview 全程不被触碰 —— 这一点关键:早先直接 navigate
   * 主 webview 会让 Vue 应用整个销毁(顶栏消失、文档状态丢失),`invoke` 的
   * promise 也无法 resolve,所以既没反馈、应用还回不来。隐藏窗口打印完直接
   * close,前端 promise 正常 resolve,由 exportDocument 弹成功 / 失败提示。
   *
   * macOS / Linux 当前返回 PdfError::Unsupported,前端直接抛错展示给用户。
   */
  async function exportToPdf(target: string, opts: Parameters<typeof buildExportHtml>[0]): Promise<void> {
    const { buildExportHtml } = await loadExportHtml()
    const { html } = await buildExportHtml(opts)
    await invoke<void>('export_pdf', { outputPath: target, html })
  }

  return {
    exporting,
    panelOpen,
    selectedType,
    panelFileName,
    previewOpen,
    previewFileName,
    openPdfPreview,
    closePdfPreview,
    openExportPanel,
    closeExportPanel,
    selectExportType,
    confirmExportPanel,
    exportDocument,
  }
})
