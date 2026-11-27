import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isTauri } from '@tauri-apps/api/core'
import { useUpdater } from '../useUpdater'
import { useNotifyStore } from '@/stores/notify'

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(async () => {}),
}))

function makeFakeUpdate(overrides: Partial<{
  version: string
  currentVersion: string
  body: string
  date: string
  download: (onEvent?: (e: DownloadEvent) => void) => Promise<void>
  install: () => Promise<void>
  close: () => Promise<void>
}> = {}): Update {
  return {
    available: true,
    currentVersion: overrides.currentVersion ?? '0.7.16',
    version: overrides.version ?? '0.8.0',
    body: overrides.body ?? '',
    date: overrides.date ?? '2026-11-27T00:00:00Z',
    rawJson: {},
    rid: 1,
    download: overrides.download ?? vi.fn(async (onEvent?: (e: DownloadEvent) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 100 } })
      onEvent?.({ event: 'Finished' })
    }),
    install: overrides.install ?? vi.fn(async () => {}),
    downloadAndInstall: vi.fn(async () => {}),
    close: overrides.close ?? vi.fn(async () => {}),
  } as unknown as Update
}

describe('useUpdater', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(isTauri).mockReturnValue(true)
    vi.stubGlobal('fetch', fetchMock)
    // 模拟真实 WebView CORS 行为：github.com Release 资产端点无 Access-Control-Allow-Origin，
    // 前端 fetch 请求 latest.json 会直接抛 TypeError: Failed to fetch
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('latest.json')) {
        throw new TypeError('Failed to fetch')
      }
      return new Response('Not Found', { status: 404 })
    })
    useUpdater().dismissUpdate()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('已是最新版本时走 Rust checkUpdate 判定，不触发前端 latest.json CORS 报错', async () => {
    vi.mocked(check).mockResolvedValue(null)
    const updater = useUpdater()
    const notify = useNotifyStore()

    await updater.checkForUpdate(false)

    expect(updater.status.value).toBe('idle')
    expect(updater.updateInfo.value).toBeNull()
    expect(notify.toasts).toHaveLength(1)
    expect(notify.toasts[0]).toMatchObject({
      type: 'info',
      message: '当前已是最新版本',
    })
  })

  it('发现新版本时提取 RELEASE_NOTES.md 对应版本段落，raw 失败时降级 jsDelivr 镜像', async () => {
    const fakeUpdate = makeFakeUpdate({ version: '0.8.0' })
    vi.mocked(check).mockResolvedValue(fakeUpdate)
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('latest.json')) {
        throw new TypeError('Failed to fetch')
      }
      // raw 模拟间歇断连，验证降级到 jsDelivr tag 镜像
      if (url.includes('raw.githubusercontent.com') || url.startsWith('/github-raw')) {
        throw new TypeError('Failed to fetch')
      }
      if (url.includes('jsdelivr') && url.includes('@v0.8.0')) {
        return new Response(
          '# Release Notes\n\n## [0.8.0] — 2026-11-27\n\n### 修复\n\n- 修复检查更新失败\n\n## [0.7.16] — 2026-11-25\n\n- 旧版本\n',
          { status: 200 },
        )
      }
      return new Response('Not Found', { status: 404 })
    })

    const updater = useUpdater()
    await updater.checkForUpdate(false)

    expect(updater.status.value).toBe('available')
    expect(updater.updateInfo.value).toEqual({
      version: '0.8.0',
      body: '### 修复\n\n- 修复检查更新失败',
      date: '2026-11-27T00:00:00Z',
    })

    // startDownload 直接复用已检查出的 Update，无需重复请求 latest.json
    const ok = await updater.startDownload(false)
    expect(ok).toBe(true)
    expect(updater.status.value).toBe('downloaded')
    expect(check).toHaveBeenCalledTimes(1)

    // 另一处调用方（如设置页 SystemGroup）可直接使用已下载句柄完成安装重启
    const settingsUpdater = useUpdater()
    await settingsUpdater.installNow()
    expect(fakeUpdate.install).toHaveBeenCalledTimes(1)
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it('RELEASE_NOTES.md 均不可达时按需降级到 GitHub Release body', async () => {
    const fakeUpdate = makeFakeUpdate({ version: '0.8.0', body: '' })
    vi.mocked(check).mockResolvedValue(fakeUpdate)
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v0.8.0',
            body: 'Fallback changelog body',
            published_at: '2026-11-27T01:00:00Z',
          }),
          { status: 200 },
        )
      }
      throw new TypeError('Failed to fetch')
    })

    const updater = useUpdater()
    await updater.checkForUpdate(false)

    expect(updater.status.value).toBe('available')
    expect(updater.updateInfo.value?.body).toBe('Fallback changelog body')
  })

  it('手动检查遇到网络类错误（含 Failed to fetch / AbortError）弹网络警告而非内部错误', async () => {
    vi.mocked(check).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const updater = useUpdater()
    const notify = useNotifyStore()

    await updater.checkForUpdate(false)

    expect(updater.status.value).toBe('idle')
    expect(notify.toasts).toHaveLength(1)
    expect(notify.toasts[0]).toMatchObject({
      type: 'warning',
      message: '网络连接失败,请检查网络后重试',
    })
  })

  it('静默检查遇到网络错误不弹任何 Toast', async () => {
    vi.mocked(check).mockRejectedValueOnce(new Error('error sending request for url'))
    const updater = useUpdater()
    const notify = useNotifyStore()

    await updater.checkForUpdate(true)

    expect(updater.status.value).toBe('error')
    expect(notify.toasts).toHaveLength(0)
  })
})
