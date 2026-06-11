import { describe, it, expect } from 'vitest'
import {
  resolveImagePath,
  mimeToExt,
  extFromFileName,
  extToMime,
  dirnameSync,
  resolveImageAssetAbsPath,
} from '../imagePath'

describe('resolveImagePath', () => {
  it('有 currentFilePath:相对路径,落 fileDir/assets', () => {
    const r = resolveImagePath({
      currentFilePath: 'C:/Users/foo/docs/note.md',
      originalName: 'screenshot.png',
      ext: 'png',
      fileDir: 'C:/Users/foo/docs',
      appDataAssetsDir: '/appData/assets',
      timestamp: 1700000000000,
    })
    expect(r).toEqual({
      assetsDir: 'C:/Users/foo/docs/assets',
      fileName: 'image-1700000000000.png',
      srcForMarkdown: 'assets/image-1700000000000.png',
    })
  })

  it('无 currentFilePath:绝对路径,落 appDataAssetsDir', () => {
    const r = resolveImagePath({
      currentFilePath: null,
      originalName: 'screenshot.png',
      ext: 'png',
      fileDir: 'C:/Users/foo/docs', // currentFilePath=null 时忽略
      appDataAssetsDir: '/appData/assets',
      timestamp: 1700000000000,
    })
    expect(r).toEqual({
      assetsDir: '/appData/assets',
      fileName: 'image-1700000000000.png',
      srcForMarkdown: '/appData/assets/image-1700000000000.png',
    })
  })

  it('不同 timestamp → 不同 filename(防同名覆盖)', () => {
    const a = resolveImagePath({
      currentFilePath: 'docs/note.md',
      originalName: 'a.png',
      ext: 'png',
      fileDir: 'docs',
      appDataAssetsDir: '/appData/assets',
      timestamp: 1000,
    })
    const b = resolveImagePath({
      currentFilePath: 'docs/note.md',
      originalName: 'a.png',
      ext: 'png',
      fileDir: 'docs',
      appDataAssetsDir: '/appData/assets',
      timestamp: 2000,
    })
    expect(a.fileName).not.toBe(b.fileName)
  })

  it('originalName 不参与命名(避免恶意文件名/路径穿越)', () => {
    const r = resolveImagePath({
      currentFilePath: 'docs/note.md',
      originalName: '../../etc/passwd',
      ext: 'png',
      fileDir: 'docs',
      appDataAssetsDir: '/appData/assets',
      timestamp: 1700000000000,
    })
    expect(r.fileName).toBe('image-1700000000000.png')
  })
})

describe('mimeToExt', () => {
  it('常见 image MIME 正确映射', () => {
    expect(mimeToExt('image/png')).toBe('png')
    expect(mimeToExt('image/jpeg')).toBe('jpg')
    expect(mimeToExt('image/jpg')).toBe('jpg')
    expect(mimeToExt('image/gif')).toBe('gif')
    expect(mimeToExt('image/webp')).toBe('webp')
    expect(mimeToExt('image/svg+xml')).toBe('svg')
    expect(mimeToExt('image/bmp')).toBe('bmp')
    expect(mimeToExt('image/avif')).toBe('avif')
  })

  it('未知 MIME → bin', () => {
    expect(mimeToExt('application/octet-stream')).toBe('bin')
    expect(mimeToExt('')).toBe('bin')
    expect(mimeToExt('text/plain')).toBe('bin')
  })
})

describe('extFromFileName', () => {
  it('简单文件名', () => {
    expect(extFromFileName('foo.png')).toBe('png')
  })

  it('多个点取最后一个', () => {
    expect(extFromFileName('foo.bar.png')).toBe('png')
  })

  it('无扩展名 → bin', () => {
    expect(extFromFileName('foo')).toBe('bin')
  })

  it('末尾只有点 → bin', () => {
    expect(extFromFileName('foo.')).toBe('bin')
  })

  it('大写扩展名转小写', () => {
    expect(extFromFileName('foo.PNG')).toBe('png')
    expect(extFromFileName('FOO.JpG')).toBe('jpg')
  })
})

describe('extToMime', () => {
  it('常见图片扩展名 → 正确 MIME', () => {
    expect(extToMime('png')).toBe('image/png')
    expect(extToMime('jpg')).toBe('image/jpeg')
    expect(extToMime('jpeg')).toBe('image/jpeg')
    expect(extToMime('gif')).toBe('image/gif')
    expect(extToMime('webp')).toBe('image/webp')
    expect(extToMime('svg')).toBe('image/svg+xml')
    expect(extToMime('bmp')).toBe('image/bmp')
    expect(extToMime('avif')).toBe('image/avif')
  })

  it('大写扩展名正常', () => {
    expect(extToMime('PNG')).toBe('image/png')
    expect(extToMime('JPG')).toBe('image/jpeg')
  })

  it('未知扩展名 → octet-stream 兜底', () => {
    expect(extToMime('xyz')).toBe('application/octet-stream')
    expect(extToMime('')).toBe('application/octet-stream')
    expect(extToMime('bin')).toBe('application/octet-stream')
  })
})

describe('dirnameSync', () => {
  it('正斜杠路径', () => {
    expect(dirnameSync('/a/b/c.md')).toBe('/a/b')
  })

  it('反斜杠路径(Windows)', () => {
    expect(dirnameSync('C:\\Users\\foo\\note.md')).toBe('C:\\Users\\foo')
  })

  it('混合斜杠', () => {
    expect(dirnameSync('C:/Users/foo/note.md')).toBe('C:/Users/foo')
  })

  it('无分隔符 → 空串', () => {
    expect(dirnameSync('note.md')).toBe('')
  })

  it('空串 → 空串', () => {
    expect(dirnameSync('')).toBe('')
  })
})

describe('resolveImageAssetAbsPath', () => {
  it('有 currentFilePath:相对路径 → 拼到 docDir', () => {
    expect(
      resolveImageAssetAbsPath('assets/image-123.png', 'C:/Users/foo/note.md'),
    ).toBe('C:/Users/foo/assets/image-123.png')
  })

  it('绝对路径(/)→ 原样', () => {
    expect(
      resolveImageAssetAbsPath('/tmp/image.png', 'C:/Users/foo/note.md'),
    ).toBe('/tmp/image.png')
  })

  it('Windows 绝对路径(C:)→ 原样', () => {
    expect(
      resolveImageAssetAbsPath('C:/some/place/image.png', 'D:/foo/note.md'),
    ).toBe('C:/some/place/image.png')
  })

  it('untitled 文档(null currentFilePath)→ src 原样', () => {
    expect(resolveImageAssetAbsPath('/abs/path/img.png', null)).toBe(
      '/abs/path/img.png',
    )
  })

  it('backslashes 也认(统一转 forward slashes)', () => {
    expect(
      resolveImageAssetAbsPath(
        'assets\\image.png',
        'C:\\Users\\foo\\note.md',
      ),
    ).toBe('C:/Users/foo/assets/image.png')
  })
})
