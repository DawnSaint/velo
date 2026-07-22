// export store 合约测试:saveDialog → writeTextFile (HTML) / invoke('export_pdf') (PDF) 路径。
//
// 复刻 src/stores/__tests__/document.test.ts 的 store 单元测试模式:
//   - setActivePinia(createPinia()) + vi.resetAllMocks() in beforeEach
//   - mock Tauri module,断言合约不变量

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { save as saveDialog, message } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import { invoke, isTauri } from '@tauri-apps/api/core'

import { useExportStore } from '../export'
import { useDocumentStore } from '../document'
import { useEditorStore } from '../editor'

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
    expect(message).not.toHaveBeenCalled()
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
    editorStore.fontFamily = 'sans'
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
    editorStore.fontFamily = 'sans'
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
    const store = useExportStore()
    const ok = await store.exportDocument()
    expect(ok).toBe(false)
    expect(message).toHaveBeenCalledWith(
      expect.stringContaining('disk full'),
      expect.objectContaining({ title: '导出失败', kind: 'error' }),
    )
  })

  it('shows error message when invoke throws (PDF path, e.g. unsupported platform)', async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce('/tmp/foo.pdf')
    vi.mocked(invoke).mockRejectedValueOnce(new Error('PDF export is not supported on this platform yet (macOS)'))
    const docStore = useDocumentStore()
    docStore.content = '# z'
    docStore.currentFilePath = '/tmp/z.md'
    const store = useExportStore()
    const ok = await store.exportDocument()
    expect(ok).toBe(false)
    expect(message).toHaveBeenCalledWith(
      expect.stringContaining('not supported'),
      expect.objectContaining({ title: '导出失败', kind: 'error' }),
    )
  })

  it('refuses to run when not in Tauri (browser dev web)', async () => {
    vi.mocked(isTauri).mockReturnValue(false)
    const store = useExportStore()
    const ok = await store.exportDocument()
    expect(ok).toBe(false)
    expect(saveDialog).not.toHaveBeenCalled()
    expect(message).toHaveBeenCalledWith(
      expect.stringContaining('桌面端'),
      expect.objectContaining({ title: '导出', kind: 'info' }),
    )
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
