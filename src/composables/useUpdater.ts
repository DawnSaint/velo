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

import { ref, readonly } from 'vue'
import { check as checkUpdate, type DownloadEvent } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isTauri } from '@tauri-apps/api/core'
import { useNotifyStore } from '@/stores/notify'

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'up-to-date' | 'error'

const status = ref<UpdateStatus>('idle')
const updateInfo = ref<{ version: string; body?: string; date?: string } | null>(null)
const downloadProgress = ref(0)
const errorMsg = ref('')
// 全局只检查一次:App.vue 启动时调 checkForUpdate(true),设置页手动检查调 checkForUpdate(false)。
// 已检查过且无更新时不重复弹 Toast。
let autoChecked = false

/** 网络类错误特征匹配 —— updater 插件的错误消息包含 "error sending request" 或 "network" */
function isNetworkError(e: unknown): boolean {
  const msg = String(e).toLowerCase()
  return msg.includes('error sending request') || msg.includes('network') || msg.includes('timeout') || msg.includes('connect')
}

export function useUpdater() {
  const notify = useNotifyStore()

  async function checkForUpdate(silent = false): Promise<void> {
    if (!isTauri()) return
    if (status.value === 'checking' || status.value === 'downloading' || status.value === 'installing') return

    status.value = 'checking'
    errorMsg.value = ''

    try {
      // 15s 超时:直连 GitHub 不稳定时快速失败,不让用户干等
      const update = await checkUpdate({ timeout: 15_000 })
      if (!update) {
        status.value = 'up-to-date'
        updateInfo.value = null
        if (!silent) {
          notify.info('当前已是最新版本')
        }
        return
      }

      status.value = 'available'
      updateInfo.value = {
        version: update.version,
        body: update.body,
        date: update.date,
      }
      if (silent) {
        notify.info(`发现新版本 v${update.version},请在「设置 > 系统」中查看详情`, 8000)
      }
    } catch (e) {
      status.value = 'error'
      errorMsg.value = String(e)
      // 静默检查时网络错误不弹 toast(中国大陆直连 GitHub 不稳定,启动弹红 toast 打扰用户);
      // 非网络错误(如签名配置错)仍弹 toast,因为这是开发者需要知道的问题。
      if (!silent) {
        if (isNetworkError(e)) {
          notify.warning('网络连接失败,请检查网络后重试')
        } else {
          notify.error(`检查更新失败: ${e}`)
        }
      }
    }
  }

  async function downloadAndInstall(): Promise<void> {
    if (!isTauri()) return
    if (status.value !== 'available') return

    status.value = 'downloading'
    downloadProgress.value = 0
    errorMsg.value = ''

    try {
      const update = await checkUpdate({ timeout: 15_000 })
      if (!update) {
        status.value = 'up-to-date'
        return
      }

      let totalBytes = 0
      let downloadedBytes = 0

      await update.downloadAndInstall((event: DownloadEvent) => {
        switch (event.event) {
          case 'Started':
            totalBytes = event.data.contentLength ?? 0
            break
          case 'Progress':
            downloadedBytes += event.data.chunkLength
            if (totalBytes > 0) {
              downloadProgress.value = Math.round((downloadedBytes / totalBytes) * 100)
            }
            break
          case 'Finished':
            downloadProgress.value = 100
            break
        }
      })

      status.value = 'installing'
      // Windows NSIS: install() 已在 downloadAndInstall 内完成;
      // macOS: 需要用户手动拖到 Applications(下载的是 .tar.gz,install 只解压)。
      // 统一调 relaunch,Windows 直接重启;macOS 若未完成安装会退出但不重启(已知限制)。
      await relaunch()
    } catch (e) {
      status.value = 'error'
      errorMsg.value = String(e)
      if (isNetworkError(e)) {
        notify.warning('下载失败,请检查网络后重试')
      } else {
        notify.error(`下载安装失败: ${e}`)
      }
    }
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
    errorMsg: readonly(errorMsg),
    checkForUpdate,
    downloadAndInstall,
    autoCheck,
  }
}
