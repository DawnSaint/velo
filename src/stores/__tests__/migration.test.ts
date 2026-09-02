import { describe, it, expect, beforeEach, vi } from 'vitest'
import { exists, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import {
  migrateSettingsIfNeeded,
  migrateWorkspacesIfNeeded,
  loadSettings,
  loadWorkspaces,
  SETTINGS_VERSION,
  WORKSPACES_VERSION,
} from '../persistence'

// 测试环境的 isTauri() 在 setup.ts 里被 mock 为 true,
// tauriOnly() 返回 true,migration 函数会走到 plugin-fs mock。

describe('migrateSettingsIfNeeded', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('文件不存在 → no-op,不调 writeTextFile', async () => {
    vi.mocked(exists).mockResolvedValue(false)
    await migrateSettingsIfNeeded()
    expect(writeTextFile).not.toHaveBeenCalled()
  })

  it('已是当前版本且无废弃字段 → no-op', async () => {
    const data = { version: 1, editor: { fontSize: '16px', primaryColor: '#1F71D9', themeMode: 'dark' } }
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(data))
    await migrateSettingsIfNeeded()
    expect(writeTextFile).not.toHaveBeenCalled()
  })

  it('darkMode(boolean) → themeMode + 删除 darkMode', async () => {
    const data = { version: 1, editor: { darkMode: true } }
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(data))
    vi.mocked(writeTextFile).mockResolvedValue()

    await migrateSettingsIfNeeded()

    const [, body] = vi.mocked(writeTextFile).mock.calls.at(-1)!
    const saved = JSON.parse(String(body))
    expect(saved.editor.themeMode).toBe('dark')
    expect(saved.editor.darkMode).toBeUndefined()
  })

  it('darkMode=false → themeMode=light', async () => {
    const data = { version: 1, editor: { darkMode: false } }
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(data))
    vi.mocked(writeTextFile).mockResolvedValue()

    await migrateSettingsIfNeeded()

    const [, body] = vi.mocked(writeTextFile).mock.calls.at(-1)!
    const saved = JSON.parse(String(body))
    expect(saved.editor.themeMode).toBe('light')
  })

  it('themeMode 已存在时 darkMode 被忽略(不迁移)', async () => {
    const data = { version: 1, editor: { themeMode: 'system', darkMode: true } }
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(data))
    vi.mocked(writeTextFile).mockResolvedValue()

    await migrateSettingsIfNeeded()

    const [, body] = vi.mocked(writeTextFile).mock.calls.at(-1)!
    const saved = JSON.parse(String(body))
    expect(saved.editor.themeMode).toBe('system')
    // darkMode 仍然被清理
    expect(saved.editor.darkMode).toBeUndefined()
  })

  it('fontFamily 被删除', async () => {
    const data = { version: 1, editor: { fontFamily: 'sans-serif', fontSize: '16px' } }
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(data))
    vi.mocked(writeTextFile).mockResolvedValue()

    await migrateSettingsIfNeeded()

    const [, body] = vi.mocked(writeTextFile).mock.calls.at(-1)!
    const saved = JSON.parse(String(body))
    expect(saved.editor.fontFamily).toBeUndefined()
    expect(saved.editor.fontSize).toBe('16px')
  })

  it('字体值 "system" → 平台默认 key', async () => {
    const data = { version: 1, editor: { latinFont: 'system', cjkFont: 'system', monoFont: 'system' } }
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(data))
    vi.mocked(writeTextFile).mockResolvedValue()

    await migrateSettingsIfNeeded()

    const [, body] = vi.mocked(writeTextFile).mock.calls.at(-1)!
    const saved = JSON.parse(String(body))
    const isMac = /Mac/.test(navigator.userAgent)
    expect(saved.editor.latinFont).toBe(isMac ? 'charter' : 'cambria')
    expect(saved.editor.cjkFont).toBe(isMac ? 'pingfang' : 'yahei')
    expect(saved.editor.monoFont).toBe(isMac ? 'sfmono' : 'cascadiacode')
  })

  it('JSON 损坏 → 静默跳过,不抛', async () => {
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue('not valid json{{{')
    await migrateSettingsIfNeeded()
    expect(writeTextFile).not.toHaveBeenCalled()
  })

  it('version 不匹配 → no-op', async () => {
    const data = { version: 99, editor: { darkMode: true } }
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(data))
    await migrateSettingsIfNeeded()
    expect(writeTextFile).not.toHaveBeenCalled()
  })
})

describe('migrateWorkspacesIfNeeded', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('文件不存在 → no-op', async () => {
    vi.mocked(exists).mockResolvedValue(false)
    await migrateWorkspacesIfNeeded()
    expect(writeTextFile).not.toHaveBeenCalled()
  })

  it('已是当前版本 → no-op', async () => {
    const data = { version: WORKSPACES_VERSION, active: '/r', workspaces: { '/r': { expandedDirs: [] } } }
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(data))
    await migrateWorkspacesIfNeeded()
    expect(writeTextFile).not.toHaveBeenCalled()
  })

  it('v1 → v5: 补 recentFiles / openTabs / activeTab + 版本号', async () => {
    const data = {
      version: 1,
      active: '/r',
      workspaces: { '/r': { expandedDirs: ['/r/sub'], sidebarTab: 'files' } },
    }
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(data))
    vi.mocked(writeTextFile).mockResolvedValue()

    await migrateWorkspacesIfNeeded()

    const [, body] = vi.mocked(writeTextFile).mock.calls.at(-1)!
    const saved = JSON.parse(String(body))
    expect(saved.version).toBe(WORKSPACES_VERSION)
    const ws = saved.workspaces['/r']
    expect(ws.recentFiles).toEqual([])
    expect(ws.openTabs).toEqual([])
    expect(ws.activeTab).toBeNull()
    expect(ws.expandedDirs).toEqual(['/r/sub'])
    expect(ws.sidebarTab).toBe('files')
  })

  it('v4 → v5: sidebarWidth 从 active workspace 迁到 settings,从 workspace 删除', async () => {
    const wsData = {
      version: 4,
      active: '/r',
      workspaces: {
        '/r': { expandedDirs: [], sidebarTab: 'outline', sidebarWidth: 400 },
        '/other': { expandedDirs: [], sidebarTab: 'outline', sidebarWidth: 300 },
      },
    }
    const settingsData = { version: 1, editor: { fontSize: '16px' } }

    // exists 第一次用于 workspaces 文件,后续用于 settings 文件
    vi.mocked(exists).mockResolvedValue(true)
    // readTextFile 第一次读 workspaces,第二次读 settings
    vi.mocked(readTextFile)
      .mockResolvedValueOnce(JSON.stringify(wsData))
      .mockResolvedValueOnce(JSON.stringify(settingsData))
    vi.mocked(writeTextFile).mockResolvedValue()

    await migrateWorkspacesIfNeeded()

    // 应有两次 writeTextFile 调用:
    // 1. settings 文件(迁移 sidebarWidth)
    // 2. workspaces 文件(删除 sidebarWidth + 版本号)
    const calls = vi.mocked(writeTextFile).mock.calls
    expect(calls.length).toBe(2)

    // 第一次写 settings(写 sidebarWidth=400)
    const settingsBody = JSON.parse(String(calls[0][1]))
    expect(settingsBody.editor.sidebarWidth).toBe(400)

    // 第二次写 workspaces(删除 sidebarWidth + 版本号=5)
    const wsBody = JSON.parse(String(calls[1][1]))
    expect(wsBody.version).toBe(WORKSPACES_VERSION)
    expect(wsBody.workspaces['/r'].sidebarWidth).toBeUndefined()
    expect(wsBody.workspaces['/other'].sidebarWidth).toBeUndefined()
  })

  it('v4 → v5: settings 已有 sidebarWidth 时不覆盖(全局值优先)', async () => {
    const wsData = {
      version: 4,
      active: '/r',
      workspaces: { '/r': { expandedDirs: [], sidebarTab: 'outline', sidebarWidth: 400 } },
    }
    const settingsData = { version: 1, editor: { fontSize: '16px', sidebarWidth: 350 } }

    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile)
      .mockResolvedValueOnce(JSON.stringify(wsData))
      .mockResolvedValueOnce(JSON.stringify(settingsData))
    vi.mocked(writeTextFile).mockResolvedValue()

    await migrateWorkspacesIfNeeded()

    const calls = vi.mocked(writeTextFile).mock.calls
    // settings 文件不会被写(全局值已存在),只有 workspaces 文件被写
    expect(calls.length).toBe(1)
    const wsBody = JSON.parse(String(calls[0][1]))
    expect(wsBody.version).toBe(WORKSPACES_VERSION)
    expect(wsBody.workspaces['/r'].sidebarWidth).toBeUndefined()
  })

  it('v4 → v5: 无 active workspace 时 sidebarWidth 不迁移,仅删除字段', async () => {
    const wsData = {
      version: 4,
      active: null,
      workspaces: { '/r': { expandedDirs: [], sidebarTab: 'outline', sidebarWidth: 400 } },
    }

    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(wsData))
    vi.mocked(writeTextFile).mockResolvedValue()

    await migrateWorkspacesIfNeeded()

    const calls = vi.mocked(writeTextFile).mock.calls
    expect(calls.length).toBe(1)
    const wsBody = JSON.parse(String(calls[0][1]))
    expect(wsBody.version).toBe(WORKSPACES_VERSION)
    expect(wsBody.workspaces['/r'].sidebarWidth).toBeUndefined()
  })

  it('JSON 损坏 → 静默跳过', async () => {
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue('not json{{{')
    await migrateWorkspacesIfNeeded()
    expect(writeTextFile).not.toHaveBeenCalled()
  })

  it('version 不是数字 → no-op', async () => {
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify({ version: 'bad', workspaces: {} }))
    await migrateWorkspacesIfNeeded()
    expect(writeTextFile).not.toHaveBeenCalled()
  })
})

describe('load* 只认当前版本', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('loadSettings 版本不匹配 → null', async () => {
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify({ version: 99, editor: {} }))
    const result = await loadSettings()
    expect(result).toBeNull()
  })

  it('loadSettings 版本匹配 → 返回 parsed', async () => {
    const data = { version: SETTINGS_VERSION, editor: { fontSize: '18px' } }
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(data))
    const result = await loadSettings()
    expect(result).not.toBeNull()
    expect(result!.editor.fontSize).toBe('18px')
  })

  it('loadWorkspaces 版本不匹配 → null', async () => {
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify({ version: 1, workspaces: {} }))
    const result = await loadWorkspaces()
    expect(result).toBeNull()
  })

  it('loadWorkspaces 版本匹配 → 返回 parsed', async () => {
    const data = { version: WORKSPACES_VERSION, active: '/r', workspaces: { '/r': { expandedDirs: [] } } }
    vi.mocked(exists).mockResolvedValue(true)
    vi.mocked(readTextFile).mockResolvedValue(JSON.stringify(data))
    const result = await loadWorkspaces()
    expect(result).not.toBeNull()
    expect(result!.active).toBe('/r')
  })
})
