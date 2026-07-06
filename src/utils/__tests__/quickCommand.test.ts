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

  it('@ 前缀切到 symbol 模式,剥掉 @ 与一个可选空格', () => {
    expect(parseQuickCommand('@intro')).toEqual({ mode: 'symbol', text: 'intro', prefix: '@' })
    expect(parseQuickCommand('@ intro')).toEqual({ mode: 'symbol', text: 'intro', prefix: '@' })
    expect(parseQuickCommand('@')).toEqual({ mode: 'symbol', text: '', prefix: '@' })
  })

  it(': 前缀切到 line 模式,剥掉 : 与一个可选空格', () => {
    expect(parseQuickCommand(':42')).toEqual({ mode: 'line', text: '42', prefix: ':' })
    expect(parseQuickCommand(': 42')).toEqual({ mode: 'line', text: '42', prefix: ':' })
    expect(parseQuickCommand(':')).toEqual({ mode: 'line', text: '', prefix: ':' })
  })

  it('未识别前缀(如 #)仍归 file,完整保留文本', () => {
    // # workspace-symbol 模式暂缓,首字符当普通文件名字符
    expect(parseQuickCommand('#10')).toEqual({ mode: 'file', text: '#10', prefix: '' })
  })
})
