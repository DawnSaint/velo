// 文件树纯函数工具的 vitest 用例(v0.5.1)。
//
// 测试范围:只测 treeUtils.ts 的纯函数(路径解析 / 名字过滤排序 / 命名校验 / 错误格式)。
// 不测 useTreeData / FileTree.vue 的 IO 与状态机 —— 那些走 FileTree.test.ts 的组件测。

import { describe, expect, it } from 'vitest'
import {
  basename,
  finalName,
  formatFsError,
  isAncestorOrSelf,
  isImageName,
  isVisible,
  parentDirOfPath,
  sortEntries,
  validateName,
} from '../Sidebar/treeUtils'
import type { DirEntry } from '@tauri-apps/plugin-fs'

function entry(name: string, isDir: boolean): DirEntry {
  return { name, isDirectory: isDir, isFile: !isDir, isSymlink: false } as DirEntry
}

describe('treeUtils', () => {
  describe('basename / parentDirOfPath', () => {
    it('双分隔符兼容 / 与 \\', () => {
      expect(basename('/a/b/c.md')).toBe('c.md')
      expect(basename('D:\\a\\b\\c.md')).toBe('c.md')
      expect(basename('plain.md')).toBe('plain.md')
      expect(parentDirOfPath('/a/b/c.md')).toBe('/a/b')
      expect(parentDirOfPath('D:\\a\\b\\c.md')).toBe('D:\\a\\b')
      expect(parentDirOfPath('plain.md')).toBe('plain.md')
    })
  })

  describe('isAncestorOrSelf', () => {
    it('等于自身 / 真后代 / 名字前缀不算', () => {
      expect(isAncestorOrSelf('/a', '/a')).toBe(true)
      expect(isAncestorOrSelf('/a', '/a/b')).toBe(true)
      expect(isAncestorOrSelf('/a', '/a/b/c')).toBe(true)
      expect(isAncestorOrSelf('/a', '/ab')).toBe(false)
      expect(isAncestorOrSelf('/a', '/ab/c')).toBe(false)
      expect(isAncestorOrSelf('D:\\a', 'D:\\a\\b')).toBe(true)
    })
  })

  describe('isImageName / isVisible', () => {
    it('图片扩展名识别', () => {
      expect(isImageName('a.png')).toBe(true)
      expect(isImageName('a.JPG')).toBe(true)
      expect(isImageName('a.txt')).toBe(false)
      expect(isImageName('noext')).toBe(false)
      expect(isImageName('.dotfile')).toBe(false) // 无 ext 部分
    })

    it('isVisible:.md / 图片 / 非隐藏目录通过;隐藏目录 / 其它文件过滤', () => {
      expect(isVisible(entry('a.md', false))).toBe(true)
      expect(isVisible(entry('a.png', false))).toBe(true)
      expect(isVisible(entry('subdir', true))).toBe(true)
      expect(isVisible(entry('.git', true))).toBe(false)
      expect(isVisible(entry('build.log', false))).toBe(false)
      expect(isVisible(entry('', false))).toBe(false)
    })
  })

  describe('sortEntries', () => {
    it('目录在前,中文按拼音排序', () => {
      const sorted = sortEntries([
        entry('b.md', false),
        entry('zdir', true),
        entry('a.md', false),
        entry('adir', true),
      ])
      expect(sorted.map(e => e.name)).toEqual(['adir', 'zdir', 'a.md', 'b.md'])
    })

    it('过滤掉不可见后排序', () => {
      const sorted = sortEntries([
        entry('a.md', false),
        entry('.git', true),
        entry('build.log', false),
      ])
      expect(sorted.map(e => e.name)).toEqual(['a.md'])
    })
  })

  describe('validateName', () => {
    it('空 / 点路径 / 禁用字符 / 同名冲突', () => {
      expect(validateName('', null, null)).toMatch(/不能为空/)
      expect(validateName('   ', null, null)).toMatch(/不能为空/)
      expect(validateName('.', null, null)).toMatch(/\. 或 \.\./)
      expect(validateName('..', null, null)).toMatch(/\. 或 \.\./)
      expect(validateName('a/b', null, null)).toMatch(/非法字符/)
      expect(validateName('a*b', null, null)).toMatch(/非法字符/)
      expect(validateName('a.md', new Set(['a.md', 'b.md']), null)).toMatch(/同名/)
      expect(validateName('a.md', new Set(['a.md', 'b.md']), 'a.md')).toBeNull() // ignoreName 跳过
      expect(validateName('c.md', new Set(['a.md', 'b.md']), null)).toBeNull()
    })

    it('siblingNames=null 时跳过同名检查(目录未加载)', () => {
      expect(validateName('a.md', null, null)).toBeNull()
    })
  })

  describe('finalName', () => {
    it('新建文件 / 重命名 md 文件:拼 .md', () => {
      expect(finalName('foo', { kind: 'newFile' })).toBe('foo.md')
      expect(finalName('foo', { kind: 'renameMdFile' })).toBe('foo.md')
    })
    it('新建目录 / 重命名其它:原值', () => {
      expect(finalName('foo', { kind: 'newDir' })).toBe('foo')
      expect(finalName('pic.png', { kind: 'renameOther' })).toBe('pic.png')
    })
  })

  describe('formatFsError', () => {
    it('Error / string / 对象都拼前缀', () => {
      expect(formatFsError(new Error('boom'), '失败')).toBe('失败:boom')
      expect(formatFsError('raw msg', '失败')).toBe('失败:raw msg')
      expect(formatFsError({ code: 42 }, '失败')).toBe('失败:{"code":42}')
    })
  })
})
