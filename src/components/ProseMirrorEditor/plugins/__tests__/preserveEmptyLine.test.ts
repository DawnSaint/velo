import { describe, expect, it } from 'vitest'
import { preprocessBlankLines } from '../preserveEmptyLine'

describe('preprocessBlankLines', () => {
  it('单个空行不变', () => {
    expect(preprocessBlankLines('para1\n\npara2')).toBe('para1\n\npara2')
  })

  it('2 个空行 → 1 个 <br /> 块', () => {
    expect(preprocessBlankLines('para1\n\n\npara2')).toBe('para1\n\n<br />\n\npara2')
  })

  it('3 个空行 → 2 个 <br /> 块', () => {
    expect(preprocessBlankLines('para1\n\n\n\npara2')).toBe(
      'para1\n\n<br />\n\n<br />\n\npara2',
    )
  })

  it('4 个空行 → 3 个 <br /> 块', () => {
    expect(preprocessBlankLines('para1\n\n\n\n\npara2')).toBe(
      'para1\n\n<br />\n\n<br />\n\n<br />\n\npara2',
    )
  })

  it('多组空行独立处理', () => {
    expect(preprocessBlankLines('a\n\n\nb\n\n\n\nc')).toBe(
      'a\n\n<br />\n\nb\n\n<br />\n\n<br />\n\nc',
    )
  })

  it('文档开头的空行也处理', () => {
    expect(preprocessBlankLines('\n\n\npara1')).toBe('\n\n<br />\n\npara1')
  })

  it('文档末尾的空行也处理', () => {
    expect(preprocessBlankLines('para1\n\n\n')).toBe('para1\n\n<br />\n\n')
  })
})
