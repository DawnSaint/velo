// export store 合约测试:saveDialog → writeTextFile (HTML) / invoke('export_pdf') (PDF) 路径。
//
// 复刻 src/stores/__tests__/document.test.ts 的 store 单元测试模式:
//   - setActivePinia(createPinia()) + vi.resetAllMocks() in beforeEach
//   - mock Tauri module,断言合约不变量

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { writeTextFile, writeFile } from '@tauri-apps/plugin-fs'
import { invoke, isTauri } from '@tauri-apps/api/core'

import { EXPORT_TYPES, useExportStore } from '../export'
import { useDocumentStore } from '../document'
import { useEditorStore } from '../editor'
import { useNotifyStore } from '../notify'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  vi.mocked(isTauri).mockReturnValue(true)
  // invoke 默认成功(每个测试按需 mockResolvedValueOnce / mockRejectedValueOnce)
  vi.mocked(invoke).mockResolvedValue(undefined)
})

describe('useExportStore.exportDocument', () => {
  it('returns false when user cancels saveDialog', async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce(null as any)
    const store = useExportStore()
    const ok = await store.exportDocument()
    expect(ok).toBe(false)
    expect(writeTextFile).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(useNotifyStore().toasts).toHaveLength(0)
  })

  it('writes HTML file when target ends with .html', async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce('/tmp/foo.html')
    vi.mocked(writeTextFile).mockResolvedValueOnce()
    // 准备 document store 内容
    const docStore = useDocumentStore()
    docStore.content = '# hello'
    docStore.currentFilePath = '/tmp/foo.md'
    const editorStore = useEditorStore()
    editorStore.themeMode = 'light'
    editorStore.primaryColor = '#000'
    editorStore.latinFont = 'georgia'
    editorStore.cjkFont = 'sourcehans'
    editorStore.fontSize = '14px'
    editorStore.codeLightTheme = 'github-light'
    editorStore.codeDarkTheme = 'github-dark'

    const store = useExportStore()
    const ok = await store.exportDocument()
    expect(ok).toBe(true)
    expect(writeTextFile).toHaveBeenCalledTimes(1)
    const [path, content] = vi.mocked(writeTextFile).mock.calls[0]
    expect(path).toBe('/tmp/foo.html')
    expect(content).toContain('<!DOCTYPE html>')
    expect(content).toContain('<h1')
    expect(content).toContain('hello')
  })

  it('invokes export_pdf with html + outputPath for PDF target', async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce('/tmp/foo.pdf')
    const docStore = useDocumentStore()
    docStore.content = '# hi'
    docStore.currentFilePath = '/tmp/foo.md'
    const editorStore = useEditorStore()
    editorStore.themeMode = 'light'
    editorStore.primaryColor = '#000'
    editorStore.latinFont = 'georgia'
    editorStore.cjkFont = 'sourcehans'
    editorStore.fontSize = '14px'
    editorStore.codeLightTheme = 'github-light'
    editorStore.codeDarkTheme = 'github-dark'

    const store = useExportStore()
    const ok = await store.exportDocument()
    expect(ok).toBe(true)
    // PDF 路径走 invoke('export_pdf', { outputPath, html }),不走 writeTextFile
    expect(writeTextFile).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('export_pdf', expect.objectContaining({
      outputPath: '/tmp/foo.pdf',
    }))
    const [, payload] = vi.mocked(invoke).mock.calls[0]
    expect((payload as any).html).toContain('<!DOCTYPE html>')
    expect((payload as any).html).toContain('hi')
  })

  it('shows error message when writeTextFile throws (HTML path)', async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce('/tmp/foo.html')
    vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('disk full'))
    const docStore = useDocumentStore()
    docStore.content = '# x'
    docStore.currentFilePath = '/tmp/x.md'
    const notify = useNotifyStore()
    const errorSpy = vi.spyOn(notify, 'error')
    const store = useExportStore()
    const ok = await store.exportDocument()
    expect(ok).toBe(false)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('disk full'),
    )
  })

  it('shows error message when invoke throws (PDF path, e.g. unsupported platform)', async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce('/tmp/foo.pdf')
    vi.mocked(invoke).mockRejectedValueOnce(new Error('PDF export is not supported on this platform yet (macOS)'))
    const docStore = useDocumentStore()
    docStore.content = '# z'
    docStore.currentFilePath = '/tmp/z.md'
    const notify = useNotifyStore()
    const errorSpy = vi.spyOn(notify, 'error')
    const store = useExportStore()
    const ok = await store.exportDocument()
    expect(ok).toBe(false)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('not supported'),
    )
  })

  it('refuses to run when not in Tauri (browser dev web)', async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const notify = useNotifyStore()
    const infoSpy = vi.spyOn(notify, 'info')
    const store = useExportStore()
    const ok = await store.exportDocument()
    expect(ok).toBe(false)
    expect(saveDialog).not.toHaveBeenCalled()
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('桌面端'),
    )
  })

  it('image export offers PNG + JPEG filters and invokes export_image (png)', async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce('/tmp/foo.png')
    const docStore = useDocumentStore()
    docStore.content = '# pic'
    docStore.currentFilePath = '/tmp/foo.md'
    const store = useExportStore()
    const ok = await store.exportDocument('image')
    expect(ok).toBe(true)
    // 图片是唯一不锁死 filter 的类型:系统保存框可切换 PNG / JPEG
    expect(saveDialog).toHaveBeenCalledWith(expect.objectContaining({
      filters: [
        { name: 'PNG 图片', extensions: ['png'] },
        { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
      ],
      defaultPath: 'foo.png',
    }))
    expect(writeTextFile).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('export_image', expect.objectContaining({
      outputPath: '/tmp/foo.png',
      format: 'png',
    }))
    const [, payload] = vi.mocked(invoke).mock.calls[0]
    expect((payload as any).html).toContain('<!DOCTYPE html>')
    expect((payload as any).html).toContain('pic')
  })

  it('image export dispatches jpeg when target ends with .jpg', async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce('/tmp/foo.jpg')
    const docStore = useDocumentStore()
    docStore.content = '# pic'
    docStore.currentFilePath = '/tmp/foo.md'
    const store = useExportStore()
    const ok = await store.exportDocument('image')
    expect(ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith('export_image', expect.objectContaining({
      outputPath: '/tmp/foo.jpg',
      format: 'jpeg',
    }))
  })

  it('image export appends .png when target has no image extension', async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce('/tmp/foo')
    const docStore = useDocumentStore()
    docStore.content = '# pic'
    docStore.currentFilePath = '/tmp/foo.md'
    const store = useExportStore()
    const ok = await store.exportDocument('image')
    expect(ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith('export_image', expect.objectContaining({
      outputPath: '/tmp/foo.png',
      format: 'png',
    }))
  })

  it('is reentrant: a second call while exporting returns false immediately', async () => {
    // 让 saveDialog 走挂起,期间第二次 exportDocument 应当立刻返回 false
    let resolveSave: (v: string | null) => void = () => {}
    vi.mocked(saveDialog).mockImplementationOnce(() => new Promise((r) => { resolveSave = r }) as any)
    const docStore = useDocumentStore()
    docStore.content = '# y'
    docStore.currentFilePath = '/tmp/y.md'
    const store = useExportStore()
    const first = store.exportDocument() // exporting.value = true after saveDialog
    const second = await store.exportDocument() // 同步返回 false
    expect(second).toBe(false)
    resolveSave(null)
    await first
  })
})

describe('useExportStore 内置导出面板', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('openExportPanel opens panel and defaults to PDF', () => {
    const docStore = useDocumentStore()
    docStore.content = '# hi'
    docStore.currentFilePath = '/tmp/foo.md'
    const store = useExportStore()
    store.openExportPanel()
    expect(store.panelOpen).toBe(true)
    expect(store.selectedType).toBe('pdf')
  })

  it('openExportPanel refuses outside Tauri (browser dev web)', () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const store = useExportStore()
    store.openExportPanel()
    expect(store.panelOpen).toBe(false)
  })

  it('confirmExportPanel locks saveDialog filter to selected type and closes on success', async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce('/tmp/out.docx')
    vi.mocked(writeFile).mockResolvedValueOnce()
    const docStore = useDocumentStore()
    docStore.content = '# hi'
    docStore.currentFilePath = '/tmp/foo.md'
    const editorStore = useEditorStore()
    editorStore.themeMode = 'light'
    editorStore.primaryColor = '#000'
    editorStore.latinFont = 'georgia'
    editorStore.cjkFont = 'sourcehans'
    editorStore.fontSize = '14px'
    editorStore.codeLightTheme = 'github-light'
    editorStore.codeDarkTheme = 'github-dark'
    const store = useExportStore()
    store.openExportPanel()
    store.selectExportType('docx')
    await store.confirmExportPanel()
    // 成功后才关(失败时保持打开,便于改选项重试)
    expect(store.panelOpen).toBe(false)
    expect(saveDialog).toHaveBeenCalledWith(expect.objectContaining({
      filters: [{ name: 'Word', extensions: ['docx'] }],
      defaultPath: 'foo.docx',
    }))
    expect(writeFile).toHaveBeenCalledTimes(1)
  })

  it('confirmExportPanel keeps panel open while saveDialog / export is pending', async () => {
    let resolveSave: (v: string | null) => void = () => {}
    vi.mocked(saveDialog).mockImplementationOnce(() => new Promise((r) => { resolveSave = r }) as any)
    vi.mocked(writeTextFile).mockResolvedValueOnce()
    const docStore = useDocumentStore()
    docStore.content = '# hi'
    docStore.currentFilePath = '/tmp/foo.md'
    const store = useExportStore()
    store.openExportPanel()
    // 系统保存框还开着时:面板不关、exporting 不启(loading 只在真正导出时出现)
    const pending = store.confirmExportPanel()
    expect(store.panelOpen).toBe(true)
    expect(store.exporting).toBe(false)
    resolveSave(null) // 用户在系统框取消 → 面板仍开
    await pending
    expect(store.panelOpen).toBe(true)
    expect(store.exporting).toBe(false)
  })

  it('confirmExportPanel with pdf-preview opens the preview panel instead of saveDialog', async () => {
    const store = useExportStore()
    store.openExportPanel()
    store.selectExportType('pdf-preview')
    await store.confirmExportPanel()
    expect(store.panelOpen).toBe(false)
    expect(store.previewOpen).toBe(true)
    expect(saveDialog).not.toHaveBeenCalled()
    store.closePdfPreview()
    expect(store.previewOpen).toBe(false)
  })

  it('EXPORT_TYPES exposes exactly 5 options with pdf-preview last', () => {
    expect(EXPORT_TYPES.map(t => t.type)).toEqual(['pdf', 'docx', 'html', 'image', 'pdf-preview'])
    expect(EXPORT_TYPES[3].ext).toBe('png')
    expect(EXPORT_TYPES[3].exts).toEqual(['png', 'jpg', 'jpeg'])
    expect(EXPORT_TYPES[4].ext).toBe('pdf')
  })
})
