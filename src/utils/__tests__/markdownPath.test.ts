import { describe, expect, it } from 'vitest'
import { isMarkdownPath, MARKDOWN_DIALOG_FILTERS, MARKDOWN_EXTENSIONS } from '../markdownPath'

describe('markdownPath', () => {
  it('识别支持的 markdown 扩展名,大小写不敏感', () => {
    expect(isMarkdownPath('README.md')).toBe(true)
    expect(isMarkdownPath('guide.markdown')).toBe(true)
    expect(isMarkdownPath('note.mdown')).toBe(true)
    expect(isMarkdownPath('C:/Docs/UPPER.MD')).toBe(true)
  })

  it('不误识别非 markdown 或无扩展名路径', () => {
    expect(isMarkdownPath('image.png')).toBe(false)
    expect(isMarkdownPath('archive.md.bak')).toBe(false)
    expect(isMarkdownPath('README')).toBe(false)
  })

  it('dialog filter 与扩展名常量共用同一份列表', () => {
    expect(MARKDOWN_DIALOG_FILTERS).toEqual([
      { name: 'Markdown', extensions: [...MARKDOWN_EXTENSIONS] },
    ])
  })
})
