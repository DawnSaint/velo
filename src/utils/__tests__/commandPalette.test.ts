import { describe, expect, it, vi } from 'vitest'
import { buildCommandPaletteSections, type CommandPaletteItem } from '@/utils/commandPalette'

function item(partial: Partial<CommandPaletteItem> & Pick<CommandPaletteItem, 'id' | 'title' | 'group'>): CommandPaletteItem {
  return {
    run: vi.fn(),
    ...partial,
  }
}

const items: CommandPaletteItem[] = [
  item({ id: 'save', title: '保存', group: 'app', shortcut: 'Ctrl+S', keywords: ['save file'] }),
  item({ id: 'open', title: '打开文件', group: 'app', shortcut: 'Ctrl+O', keywords: ['open file'] }),
  item({ id: 'quick', title: '快速打开文件', group: 'workspace', shortcut: 'Ctrl+P', keywords: ['quick open'], disabled: true, disabledReason: '需要先打开工作区' }),
  item({ id: 'recent', title: '打开最近文件: notes.md', group: 'recent', subtitle: 'C:/docs/notes.md', keywords: ['recent file'] }),
]

describe('commandPalette', () => {
  it('空 query 保持分组顺序和组内源顺序（recent 组不进命令模式）', () => {
    const sections = buildCommandPaletteSections(items, '')

    expect(sections.map(s => s.key)).toEqual(['app', 'workspace'])
    expect(sections[0].rows.map(r => r.item.id)).toEqual(['save', 'open'])
    expect(sections[1].rows.map(r => r.item.id)).toEqual(['quick'])
  })

  it('title 命中时返回高亮段', () => {
    const sections = buildCommandPaletteSections(items, '打开')
    const open = sections.flatMap(s => s.rows).find(r => r.item.id === 'open')

    expect(open?.titleSegments.some(seg => seg.match && seg.text === '打开')).toBe(true)
  })

  it('可通过 keywords 匹配', () => {
    const byKeyword = buildCommandPaletteSections(items, 'open file').flatMap(s => s.rows)

    expect(byKeyword.map(r => r.item.id)).toContain('open')
  })

  it('disabled 项仍可匹配并保留状态', () => {
    const rows = buildCommandPaletteSections(items, 'quick').flatMap(s => s.rows)

    expect(rows).toHaveLength(1)
    expect(rows[0].item.id).toBe('quick')
    expect(rows[0].item.disabled).toBe(true)
    expect(rows[0].item.disabledReason).toBe('需要先打开工作区')
  })

  it('过滤掉不匹配项', () => {
    const rows = buildCommandPaletteSections(items, '不存在').flatMap(s => s.rows)

    expect(rows).toHaveLength(0)
  })
})
