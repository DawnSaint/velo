// 导出 store —— 把当前 markdown 文档导出为 PDF (默认) 或 HTML (可选)。
//
// 设计要点:
// 1) **saveDialog 多 filter,PDF 排第一**:saveDialog 的 filters 数组第一项
//    就是默认筛选项,用户回车 / 不动鼠标直接走 PDF;切到 "HTML" filter 才
//    走 HTML 路径。`defaultExportPath` 默认补 `.pdf` 后缀,跟默认 filter
//    对齐 —— 不补的话默认文件名没扩展名,saveDialog 也不会自动补,落盘
//    会写出一个无扩展名的 PDF。
// 2) **HTML 路径**:`buildExportHtml` 生成完整 HTML 字符串 → `writeTextFile` 落盘。
//    自包含(所有 CSS inline),用户拿到 HTML 任何浏览器都能开。
// 3) **PDF 路径 (v0.4.7 后)**:`invoke('export_pdf', { outputPath, html })` 调
//    平台原生 PrintToPDF API (Windows WebView2 ICoreWebView2_7::PrintToPdf),
//    静默写到 target 路径,无任何系统对话框。HTML 已经在前端 buildExportHtml
//    渲染好,只把字符串传给 Rust 端。Rust 端在一个**隐藏的打印专用 webview 窗口**
//    里 navigate(data:...) + PrintToPdf,主应用 webview 全程不动 —— 这样
//    `invoke` 的 promise 能正常 resolve,下面才能弹成功 / 失败反馈。
//    macOS / Linux 当前在 Rust 端返回 PdfError::Unsupported,前端把它映射成
//    "PDF 导出当前平台暂不支持" 错误提示。
// 4) **成功 / 失败反馈**:成功弹 Toast success 告知路径;失败弹 Toast error
//    (同 document.ts)。早先 PDF 导出后主 webview 被 navigate 走导致
//    JS 上下文销毁,既看不到反馈、顶栏也回不来 —— 隐藏窗口方案同时解决这两点。
//
// 不动 currentFilePath / lastSavedContent / fs:watch —— 导出是"产出一份
// 静态文件",不是"切换到那个文件继续编辑",跟保存 / 另存为是不同语义。

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { save as saveDialog } from '@/tauri/dialog'
import { writeTextFile } from '@/tauri/fs'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { useDocumentStore } from './document'
import { useEditorStore } from './editor'
import { useNotifyStore } from './notify'
import type { buildExportHtml } from '@/lib/export/htmlRenderer'

// 懒加载导出渲染:htmlRenderer 顶层静态 import 了 katexCss + jetbrainsCss,二者
// 各自 import.meta.glob(?inline, eager) 把 ~845KB base64 字体(20 katex + 4 jetbrains)
// 烘进模块。若 eager 走静态 import,这 ~845KB 常驻主 bundle —— 即使用户从不导出。
// 推迟到首次导出才加载(用户点导出时多一次 chunk fetch,可接受,与 katex 懒加载同范式)。
// type 只用 `Parameters<typeof buildExportHtml>[0]`,import type 在运行时擦除不拉模块。
let exportHtmlMod: Promise<typeof import('@/lib/export/htmlRenderer')> | null = null
function loadExportHtml() {
  if (!exportHtmlMod) exportHtmlMod = import('@/lib/export/htmlRenderer')
  return exportHtmlMod
}

// filter 顺序 == saveDialog 默认 filter:PDF 在前 → 默认选 PDF。
const EXPORT_FILTERS = [
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'HTML', extensions: ['html', 'htm'] },
]

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try { return JSON.stringify(e) } catch { return String(e) }
}

/**
 * 计算默认 save 路径:有 currentFilePath 用它(去掉 .md 后补 .pdf),
 * 无则用 'untitled.pdf'。补 .pdf 是为了让 saveDialog 默认走 PDF filter ——
 * 不补默认文件名没扩展名,落盘会写出无扩展名的 PDF。
 */
function defaultExportPath(fileName: string | null): string {
  if (!fileName || fileName === '未命名') return 'untitled.pdf'
  return fileName.replace(/\.[^.]+$/, '') + '.pdf'
}

export const useExportStore = defineStore('export', () => {
  /** 标记导出进行中,UI 可据此 disable 按钮 / 显示 spinner。 */
  const exporting = ref(false)

  /**
   * 主入口。流程:
   * 1) saveDialog 拿 target(用户可取消 → return false)
   * 2) 按扩展名 dispatch:HTML / PDF
   * 3) 失败 → Toast error 告知
   * 成功 → Toast success + return true
   */
  async function exportDocument(): Promise<boolean> {
    const notify = useNotifyStore()
    if (exporting.value) return false
    if (!isTauri()) {
      notify.info('导出功能仅在桌面端可用')
      return false
    }
    const docStore = useDocumentStore()
    const editorStore = useEditorStore()
    const target = await saveDialog({
      filters: EXPORT_FILTERS,
      defaultPath: defaultExportPath(docStore.fileName),
    })
    if (!target) return false
    const isPdf = target.toLowerCase().endsWith('.pdf')
    exporting.value = true
    let succeeded = false
    try {
      if (isPdf) {
        await exportToPdf(target, {
          content: docStore.content,
          fileName: docStore.fileName,
          darkMode: editorStore.darkMode,
          primaryColor: editorStore.primaryColor,
          applyThemeColorToContent: editorStore.themeColorAffectsDoc,
          fontFamily: editorStore.fontFamily,
          fontSize: editorStore.fontSize,
          currentFilePath: docStore.currentFilePath,
          lightTheme: editorStore.codeLightTheme,
          darkTheme: editorStore.codeDarkTheme,
        })
      }
      else {
        await exportToHtml(target, {
          content: docStore.content,
          fileName: docStore.fileName,
          darkMode: editorStore.darkMode,
          primaryColor: editorStore.primaryColor,
          applyThemeColorToContent: editorStore.themeColorAffectsDoc,
          fontFamily: editorStore.fontFamily,
          fontSize: editorStore.fontSize,
          currentFilePath: docStore.currentFilePath,
          lightTheme: editorStore.codeLightTheme,
          darkTheme: editorStore.codeDarkTheme,
        })
      }
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
    exportDocument,
  }
})
