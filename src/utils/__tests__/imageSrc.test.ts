import { describe, it, expect, afterEach, vi } from 'vitest'
import { convertFileSrc } from '@tauri-apps/api/core'
import { resolveImageSrc } from '../imageSrc'

// setup.ts 把 convertFileSrc mock 成 identity,所以断言里看到的就是传入它的路径
function enterTauri(): void {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
}

function leaveTauri(): void {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
}

afterEach(() => {
  leaveTauri()
  vi.mocked(convertFileSrc).mockClear()
})

describe('resolveImageSrc(主编辑器与 diff 预览共用)', () => {
  it('非 Tauri 环境原样返回', () => {
    expect(resolveImageSrc('assets/x.png', '/docs/note.md')).toBe('assets/x.png')
    expect(convertFileSrc).not.toHaveBeenCalled()
  })

  it('http(s) / data: / asset: / tauri: 透传,不二次包装', () => {
    enterTauri()
    for (const url of [
      'https://example.com/x.png',
      'http://example.com/x.png',
      'data:image/png;base64,AAAA',
      'asset://localhost/C%3A/docs/x.png',
      'tauri://localhost/x.png',
    ]) {
      expect(resolveImageSrc(url, '/docs/note.md')).toBe(url)
    }
    expect(convertFileSrc).not.toHaveBeenCalled()
  })

  it('相对路径按当前文档目录拼成绝对路径再转 asset:', () => {
    enterTauri()
    // 这正是 diff view 之前漏掉的一步:直接 convertFileSrc('assets/…') 会 404
    expect(resolveImageSrc('assets/图解.png', '/docs/note.md')).toBe('/docs/assets/图解.png')
    expect(convertFileSrc).toHaveBeenCalledWith('/docs/assets/图解.png')
  })

  it('Windows 文档目录下的相对路径同样归一成 forward slash', () => {
    enterTauri()
    expect(resolveImageSrc('assets\\x.png', 'C:\\docs\\note.md')).toBe('C:/docs/assets/x.png')
    expect(convertFileSrc).toHaveBeenCalledWith('C:/docs/assets/x.png')
  })

  it('src 本身是绝对路径 → 不拼目录,直接转换', () => {
    enterTauri()
    expect(resolveImageSrc('/opt/img/x.png', '/docs/note.md')).toBe('/opt/img/x.png')
    expect(convertFileSrc).toHaveBeenCalledWith('/opt/img/x.png')
  })

  it('无 currentFilePath 且 src 是相对路径 → 没有基准目录,原样返回', () => {
    enterTauri()
    expect(resolveImageSrc('assets/x.png', null)).toBe('assets/x.png')
    expect(convertFileSrc).not.toHaveBeenCalled()
  })

  it('空 src 原样返回', () => {
    enterTauri()
    expect(resolveImageSrc('', '/docs/note.md')).toBe('')
  })
})
