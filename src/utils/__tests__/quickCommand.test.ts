import { describe, expect, it } from 'vitest'
import { parseQuickCommand } from '@/utils/quickCommand'

describe('parseQuickCommand', () => {
  it('空 query 与无前缀都归 file 模式', () => {
    expect(parseQuickCommand('')).toEqual({ mode: 'file', text: '', prefix: '' })
    expect(parseQuickCommand('notes')).toEqual({ mode: 'file', text: 'notes', prefix: '' })
  })

  it('> 前缀切到 command 模式,剥掉 > 与一个可选空格', () => {
    expect(parseQuickCommand('>save')).toEqual({ mode: 'command', text: 'save', prefix: '>' })
    expect(parseQuickCommand('> save')).toEqual({ mode: 'command', text: 'save', prefix: '>' })
    expect(parseQuickCommand('>')).toEqual({ mode: 'command', text: '', prefix: '>' })
  })

  it('未识别前缀(如 @ # :)在当前阶段仍归 file,完整保留文本', () => {
    // 这些模式在后续提交接入,此阶段首字符当普通文件名字符
    expect(parseQuickCommand('@heading')).toEqual({ mode: 'file', text: '@heading', prefix: '' })
    expect(parseQuickCommand(':10')).toEqual({ mode: 'file', text: ':10', prefix: '' })
  })
})
