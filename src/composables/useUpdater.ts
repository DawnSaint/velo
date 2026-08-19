// 应用自动更新(v0.8.x #updater)
//
// 封装 Tauri Updater plugin 的 check / download / install / relaunch 全流程,
// 提供 reactive 状态供设置页 UI 消费。
//
// 设计取舍:
// - **静默检查 + 主动提示**:启动后自动检查一次,有更新走 Toast 提示用户去设置页
//   手动下载安装(不自动下载,避免打断用户编辑)。
// - **下载进度**:downloadAndInstall 的 onEvent 回调更新 progress 状态,UI 渲染进度条。
// - **relaunch**:安装完成后调 process.relaunch 退出并重启;Windows NSIS 安装器
//   在 install() 返回前完成文件替换,relaunch 直接启动新版本。
// - **错误处理**:网络失败 / 签名验证失败等非致命错误只 toast,不阻塞应用。
//   静默检查(silent)时网络错误完全不弹 toast —— 中国大陆直连 GitHub 不稳定,
//   启动时弹一个红色错误 toast 会打扰用户;手动检查时弹 toast 给用户反馈。
// - **超时**:check 请求 15s 超时,避免直连 GitHub 网络差时用户等一个无限超时。
// - **前端 fetch check**:check 阶段用前端 fetch 请求 latest.json,跳过 Rust 端
//   reqwest(代理不兼容)和版本对比(dev 版本相同时返回 null)。
//   dev 环境 fetch 走 Vite proxy(/github-api),避免 WebView2 跨域/CSP/混合内容拦截;
//   生产环境 fetch 走真实 GitHub API。downloadAndInstall 仍走 checkUpdate。
// - **release notes 来源**:更新卡片展示用户手写的 docs/RELEASE_NOTES.md(中文、
//   面向用户),而非 release-please 自动生成的 CHANGELOG.md(英文 commit 流水账)。
//   fetch GitHub raw 拿到 RELEASE_NOTES.md 全文后正则提取目标版本段落;
//   raw fetch 失败时降级回 release.body(GitHub Release 页面 changelog)。

import { ref, readonly } from 'vue'
import { check as checkUpdate, type DownloadEvent } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isTauri } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { useNotifyStore } from '@/stores/notify'

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'up-to-date' | 'error'

const status = ref<UpdateStatus>('idle')
const updateInfo = ref<{ version: string; body?: string; date?: string } | null>(null)
const downloadProgress = ref(0)
const downloadSpeed = ref('') // 人类可读的下载速度，如 "1.2 MB/s"
const errorMsg = ref('')
// 全局只检查一次:App.vue 启动时调 checkForUpdate(true),设置页手动检查调 checkForUpdate(false)。
// 已检查过且无更新时不重复弹 Toast。
let autoChecked = false

/** 网络类错误特征匹配 —— updater 插件的错误消息包含 "error sending request" 或 "network" */
function isNetworkError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  return msg.includes('error sending request') || msg.includes('network') || msg.includes('timeout') || msg.includes('connect')
}

/** GitHub API releases/latest,不重定向,返回 tag_name/body/published_at */
const RELEASES_API = 'https://api.github.com/repos/DawnSaint/velo/releases/latest'

/** dev 环境用 Vite proxy 避免 WebView2 跨域/CSP/混合内容拦截 */
const RELEASES_API_DEV = '/github-api/repos/DawnSaint/velo/releases/latest'

/** 仓库 master 分支 docs/RELEASE_NOTES.md 原始内容 */
const RELEASE_NOTES_URL = 'https://raw.githubusercontent.com/DawnSaint/velo/master/docs/RELEASE_NOTES.md'

/** dev 环境用 Vite proxy(raw.githubusercontent.com 也受 CSP 跨域拦截) */
const RELEASE_NOTES_URL_DEV = '/github-raw/DawnSaint/velo/master/docs/RELEASE_NOTES.md'

interface GithubRelease {
  tag_name: string
  body?: string
  published_at?: string
}

/** 前端 fetch GitHub API 获取最新 release,跳过 Rust 端版本对比 */
async function fetchLatestRelease(timeoutMs: number): Promise<GithubRelease | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const url = import.meta.env.DEV ? RELEASES_API_DEV : RELEASES_API
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return null
    return await res.json() as GithubRelease
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从 RELEASE_NOTES.md 全文中提取目标版本对应的段落。
 *
 * 文件结构:每个版本以 `## [X.Y.Z]` 开头,直到下一个 `## [` 或文件结束。
 * 提取出的段落保留 markdown 原文(### Added / - 等),由 UI 端渲染。
 * 找不到对应版本时返回 null,调用方降级到 release.body。
 */
function extractReleaseNotesSection(markdown: string, version: string): string | null {
  // 匹配 `## [X.Y.Z]` 形式的版本标题(方括号内为版本号)
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const startRe = new RegExp(`^## \\[${escaped}\\][^\\n]*$`, 'm')
  const startMatch = markdown.match(startRe)
  if (!startMatch) return null

  const startIdx = startMatch.index! + startMatch[0].length
  // 从版本标题之后查找下一个 `## [` 开头的行(下一个版本)
  const rest = markdown.slice(startIdx)
  const nextMatch = rest.match(/^## \[\d/m)
  const endIdx = nextMatch ? nextMatch.index! : rest.length
  return rest.slice(0, endIdx).trim() || null
}

/**
 * fetch docs/RELEASE_NOTES.md 并提取目标版本段落。
 * 失败(网络 / 解析不到对应版本)时返回 null,调用方降级到 release.body。
 */
async function fetchReleaseNotes(version: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const url = import.meta.env.DEV ? RELEASE_NOTES_URL_DEV : RELEASE_NOTES_URL
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    const text = await res.text()
    return extractReleaseNotesSection(text, version)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function useUpdater() {
  const notify = useNotifyStore()

  async function checkForUpdate(silent = false): Promise<void> {
    if (!isTauri()) return
    if (status.value === 'checking' || status.value === 'downloading' || status.value === 'installing') return

    status.value = 'checking'
    errorMsg.value = ''

    try {
      // 前端 fetch GitHub API,跳过 Rust 端 reqwest(代理不兼容)和版本对比(dev 版本相同返回 null)
      const release = await fetchLatestRelease(15_000)
      if (!release) {
        updateInfo.value = null
        if (!silent) {
          notify.info('当前已是最新版本')
          status.value = 'idle'
        } else {
          status.value = 'up-to-date'
        }
        return
      }

      // GitHub API 返回的 tag_name 格式为 "vX.Y.Z",去掉前缀 "v"
      const version = release.tag_name.replace(/^v/, '')
      // 本地版本号与远程相同时不提示更新。
      // fetchLatestRelease 拿的是 releases/latest 端点,永远返回最新 release,
      // 必须自己对比版本号,否则本地与远程同版也会提示更新。
      const localVersion = await getVersion()
      if (localVersion === version) {
        updateInfo.value = null
        if (!silent) {
          notify.info('当前已是最新版本')
          status.value = 'idle'
        } else {
          status.value = 'up-to-date'
        }
        return
      }
      // 优先从 docs/RELEASE_NOTES.md 提取用户手写的版本日志;
      // fetch 失败或找不到对应版本时降级回 release.body(GitHub Release 页面 changelog)。
      const notes = await fetchReleaseNotes(version, 15_000)
      status.value = 'available'
      updateInfo.value = {
        version,
        body: notes ?? release.body,
        date: release.published_at,
      }
      if (silent) {
        notify.info(`发现新版本 v${version},请在「设置 > 系统」中查看详情`, 8000)
      }
    } catch (e) {
      errorMsg.value = String(e)
      // 静默检查时网络错误不弹 toast(中国大陆直连 GitHub 不稳定,启动弹红 toast 打扰用户);
      // 非网络错误(如签名配置错)仍弹 toast,因为这是开发者需要知道的问题。
      if (!silent) {
        if (isNetworkError(e)) {
          notify.warning('网络连接失败,请检查网络后重试')
        } else {
          notify.error(`检查更新失败: ${e}`)
        }
        status.value = 'idle'
      } else {
        status.value = 'error'
      }
    }
  }

  // 缓存 Update 对象：download() 后持有，install() 时复用
  let pendingUpdate: Awaited<ReturnType<typeof checkUpdate>> = null

  async function startDownload(): Promise<void> {
    if (!isTauri()) return
    if (status.value !== 'available') return

    status.value = 'downloading'
    downloadProgress.value = 0
    errorMsg.value = ''

    try {
      // 走 Rust 端 checkUpdate 拿 Update 对象(签名验证)
      const update = await checkUpdate({ timeout: 15_000 })
      if (!update) {
        status.value = 'up-to-date'
        notify.info('当前已是最新版本')
        return
      }

      pendingUpdate = update

      let totalBytes = 0
      let downloadedBytes = 0
      let lastSpeedUpdate = Date.now()
      let lastDownloadedBytes = 0

      await update.download((event: DownloadEvent) => {
        switch (event.event) {
          case 'Started':
            totalBytes = event.data.contentLength ?? 0
            break
          case 'Progress': {
            downloadedBytes += event.data.chunkLength
            if (totalBytes > 0) {
              downloadProgress.value = Math.round((downloadedBytes / totalBytes) * 100)
            }
            // 每 500ms 更新一次下载速度显示
            const now = Date.now()
            if (now - lastSpeedUpdate >= 500) {
              const elapsed = (now - lastSpeedUpdate) / 1000
              const bytesPerSec = (downloadedBytes - lastDownloadedBytes) / elapsed
              downloadSpeed.value = formatSpeed(bytesPerSec)
              lastSpeedUpdate = now
              lastDownloadedBytes = downloadedBytes
            }
            break
          }
          case 'Finished':
            downloadProgress.value = 100
            downloadSpeed.value = ''
            break
        }
      })

      // 下载完成，进入 'downloaded' 状态，等用户选择立即安装或稍后
      status.value = 'downloaded'
    } catch (e) {
      // 下载失败后重置为 'available'：卡片保持展示、按钮恢复可点击，方便用户重试
      status.value = 'available'
      downloadProgress.value = 0
      downloadSpeed.value = ''
      errorMsg.value = String(e)
      if (isNetworkError(e)) {
        notify.warning('下载失败,请检查网络后重试')
      } else {
        notify.error(`下载失败: ${e}`)
      }
    }
  }

  async function installNow(): Promise<void> {
    if (!isTauri()) return
    if (status.value !== 'downloaded' || !pendingUpdate) return

    status.value = 'installing'
    try {
      // Windows NSIS: install() 启动安装器完成文件替换;
      // macOS: 需要用户手动拖到 Applications(下载的是 .tar.gz,install 只解压)。
      // 统一调 relaunch,Windows 直接重启;macOS 若未完成安装会退出但不重启(已知限制)。
      await pendingUpdate.install()
      await relaunch()
    } catch (e) {
      status.value = 'error'
      errorMsg.value = String(e)
      notify.error(`安装失败: ${e}`)
    }
  }

  /** 稍后更新：关闭下载完成卡片，保留已下载文件到 temp 目录，下次启动或下次检查时自动清理 */
  function dismissUpdate() {
    if (pendingUpdate) {
      pendingUpdate.close().catch(() => {})
      pendingUpdate = null
    }
    status.value = 'idle'
    downloadProgress.value = 0
    downloadSpeed.value = ''
  }

  function formatSpeed(bytesPerSec: number): string {
    if (bytesPerSec <= 0) return ''
    if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
    return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
  }

  /** 启动时自动检查(仅一次)。App.vue onMounted 调用。 */
  async function autoCheck(): Promise<void> {
    if (autoChecked) return
    autoChecked = true
    await checkForUpdate(true)
  }

  return {
    status: readonly(status),
    updateInfo: readonly(updateInfo),
    downloadProgress: readonly(downloadProgress),
    downloadSpeed: readonly(downloadSpeed),
    errorMsg: readonly(errorMsg),
    checkForUpdate,
    startDownload,
    installNow,
    dismissUpdate,
    autoCheck,
  }
}
