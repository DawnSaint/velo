import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { exists } from '@tauri-apps/plugin-fs'
import { isMissingPath, probeExistingPath, useStaleEntry } from '../useStaleEntry'
import { useConfirmStore } from '@/stores/confirm'

describe('useStaleEntry · 失效判定', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('exists 明确返回 false 才判失效', async () => {
    vi.mocked(exists).mockResolvedValue(false)
    expect(await isMissingPath('/gone.md')).toBe(true)
  })

  it('exists 返回 true → 记录有效', async () => {
    vi.mocked(exists).mockResolvedValue(true)
    expect(await isMissingPath('/ok.md')).toBe(false)
  })

  it('exists 抛错(权限 / 网络盘抖动)按有效处理,绝不误删记录', async () => {
    vi.mocked(exists).mockRejectedValue(new Error('EACCES'))
    expect(await isMissingPath('/flaky.md')).toBe(false)
  })
})

describe('useStaleEntry · 启动 last-file 探测', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('第一条即有效 → 不产生清理项,也不多探测', async () => {
    vi.mocked(exists).mockResolvedValue(true)
    expect(await probeExistingPath(['/a.md', '/b.md'])).toEqual({ found: '/a.md', missing: [] })
    expect(exists).toHaveBeenCalledTimes(1)
  })

  it('跳过失效项,收集待清理路径,返回第一条有效文件', async () => {
    vi.mocked(exists).mockImplementation(async p => String(p) !== '/gone.md')
    expect(await probeExistingPath(['/gone.md', '/b.md'])).toEqual({
      found: '/b.md',
      missing: ['/gone.md'],
    })
  })

  it('探测窗口内全失效 → found=null,失效项合并返回供一次性批量清理', async () => {
    vi.mocked(exists).mockResolvedValue(false)
    expect(await probeExistingPath(['/a.md', '/b.md', '/c.md'], 2)).toEqual({
      found: null,
      missing: ['/a.md', '/b.md'],
    })
    expect(exists).toHaveBeenCalledTimes(2) // 不扫第 3 条,避免开机 IO 风暴
  })

  it('空列表 → 不产生任何 IO', async () => {
    expect(await probeExistingPath([])).toEqual({ found: null, missing: [] })
    expect(exists).not.toHaveBeenCalled()
  })
})

describe('useStaleEntry · 统一确认弹窗', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
  })

  it('confirmRemove 用统一文案结构,确认后结算 true', async () => {
    const stale = useStaleEntry()
    const confirm = useConfirmStore()

    const result = stale.confirmRemove('文件已失效', '该文件已不存在，可能已被移动或删除。', '/gone.md')

    expect(confirm.current).toMatchObject({
      title: '文件已失效',
      message: '该文件已不存在，可能已被移动或删除。',
      detail: '/gone.md',
      confirmText: '从列表移除',
      cancelText: '取消',
      kind: 'warning',
    })
    confirm.confirm()
    await expect(result).resolves.toBe(true)
  })

  it('取消 → 结算 false(调用方据此保留记录)', async () => {
    const stale = useStaleEntry()
    const confirm = useConfirmStore()

    const result = stale.confirmRemove('文件已失效', '该文件已不存在。', '/gone.md')

    confirm.cancel()
    await expect(result).resolves.toBe(false)
    expect(confirm.current).toBeNull()
  })
})
