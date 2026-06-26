import { describe, expect, it } from 'vitest'
import { basenameOfPath, displayFilePath, normalizeDisplayPath, relativePathWithinRoot } from '../statusPath'

describe('status path helpers', () => {
  it('normalizes display separators', () => {
    expect(normalizeDisplayPath('C:\\notes\\a.md')).toBe('C:/notes/a.md')
  })

  it('returns basename for Windows and POSIX paths', () => {
    expect(basenameOfPath('C:\\notes\\a.md')).toBe('a.md')
    expect(basenameOfPath('/home/me/notes/a.md')).toBe('a.md')
  })

  it('returns relative path for a file inside a Windows root', () => {
    expect(relativePathWithinRoot('C:\\Notes\\Drafts\\a.md', 'c:/notes')).toBe('Drafts/a.md')
  })

  it('returns relative path for a file inside a POSIX root', () => {
    expect(relativePathWithinRoot('/home/me/notes/drafts/a.md', '/home/me/notes')).toBe('drafts/a.md')
  })

  it('does not match root path prefixes without a boundary', () => {
    expect(relativePathWithinRoot('/home/me/notes2/a.md', '/home/me/notes')).toBeNull()
  })

  it('falls back to basename when no root or outside root', () => {
    expect(displayFilePath('/outside/a.md', '/ws')).toBe('a.md')
    expect(displayFilePath('/ws/a.md', null)).toBe('a.md')
  })

  it('uses 未命名 when there is no current file path', () => {
    expect(displayFilePath(null, '/ws')).toBe('未命名')
  })
})
