<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import SettingsItem from '../SettingsItem.vue'
import { useUpdater } from '@/composables/useUpdater'

// 平台识别：沿用 App.vue 的 UA 嗅探惯例（tauri 守门桌面端，UA 判定系统）。
// 注：navigator.platform 已弃用，navigator.userAgent 仍可靠检测 Win/Mac/Linux。
const tauri = isTauri()
const platform = computed<'windows' | 'macos' | 'linux' | 'none'>(() => {
  if (!tauri) return 'none'
  const ua = navigator.userAgent
  if (/Win/.test(ua)) return 'windows'
  if (/Mac/.test(ua)) return 'macos'
  if (/Linux/.test(ua)) return 'linux'
  return 'none'
})

// Windows 右键菜单启用状态：启动时从 Rust 读偏好，用户切换时写回。
const folderMenuOn = ref(true)
const mdMenuOn = ref(true)

async function refreshShellState() {
  if (platform.value === 'none') return
  try {
    const state = await invoke<{ folder_menu: boolean, md_menu: boolean }>('shell_integration_state')
    folderMenuOn.value = state.folder_menu
    mdMenuOn.value = state.md_menu
  } catch (e) {
    console.warn('[settings] 读取 shell 状态失败', e)
  }
}

async function toggleFolderMenu() {
  try {
    await invoke('set_shell_integration', { kind: 'folder', enabled: folderMenuOn.value })
  } catch (e) {
    console.warn('[settings] 切换文件夹菜单失败', e)
  }
}

async function toggleMdMenu() {
  try {
    await invoke('set_shell_integration', { kind: 'md', enabled: mdMenuOn.value })
  } catch (e) {
    console.warn('[settings] 切换 .md 菜单失败', e)
  }
}

async function openDefaultApps() {
  if (platform.value !== 'windows') return
  try {
    await invoke('open_default_apps_settings')
  } catch (e) {
    console.warn('[settings] 打开默认应用设置失败', e)
  }
}

// ========== 自动更新 ==========
const {
  status: updateStatus,
  updateInfo,
  downloadProgress,
  downloadSpeed,
  errorMsg,
  checkForUpdate,
  downloadAndInstall,
} = useUpdater()

async function onCheckUpdate() {
  await checkForUpdate(false)
}

async function onDownloadAndInstall() {
  await downloadAndInstall()
}

onMounted(refreshShellState)
</script>

<template>
  <section class="space-y-4 pt-6">
    <!-- 自动更新：所有桌面端均支持，Tauri Updater plugin + GitHub Release latest.json -->
    <SettingsItem v-if="tauri" label="检查更新" :keywords="['update', 'updater', 'version', '更新', '版本', '检查']" variant="toplabel">
      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="velo-text-btn"
            :disabled="updateStatus === 'checking' || updateStatus === 'downloading' || updateStatus === 'installing'"
            @click="onCheckUpdate"
          >
            {{ updateStatus === 'checking' ? '检查中…' : '检查更新' }}
          </button>
          <span v-if="updateStatus === 'up-to-date'" class="text-sm text-gray-500 dark:text-gray-400">
            已是最新版本
          </span>
          <span v-if="updateStatus === 'error'" class="text-sm text-amber-500 dark:text-amber-400">
            {{ errorMsg.includes('request') || errorMsg.includes('network') || errorMsg.includes('timeout') || errorMsg.includes('connect') ? '网络连接失败' : '检查失败' }}
          </span>
        </div>

        <!-- 发现新版本：版本号 + 更新说明 + 下载安装按钮 -->
        <div
          v-if="updateInfo && (updateStatus === 'available' || updateStatus === 'downloading' || updateStatus === 'installing')"
          class="rounded-lg border border-[var(--md-primary-color)]/30 bg-[var(--md-primary-color)]/5 p-3"
        >
          <div class="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-200">
            发现新版本 v{{ updateInfo.version }}
          </div>
          <p v-if="updateInfo.body" class="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-400">
            {{ updateInfo.body }}
          </p>
          <div class="mt-3 flex items-center gap-3">
            <button
              type="button"
              class="velo-text-btn"
              :disabled="updateStatus === 'downloading' || updateStatus === 'installing'"
              @click="onDownloadAndInstall"
            >
              {{ updateStatus === 'downloading' ? `下载中 ${downloadProgress}%` : updateStatus === 'installing' ? '安装中…' : '下载并安装' }}
            </button>
            <span v-if="updateStatus === 'downloading'" class="text-xs text-gray-400 dark:text-gray-500">
              {{ downloadSpeed || '下载中…' }}
            </span>
          </div>

          <!-- 下载进度条 -->
          <div
            v-if="updateStatus === 'downloading'"
            class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
          >
            <div
              class="h-full rounded-full bg-[var(--md-primary-color)] transition-all duration-150"
              :style="{ width: `${downloadProgress}%` }"
            />
          </div>
        </div>
      </div>
    </SettingsItem>

    <!-- 默认程序：仅 Windows 有意义（反劫持保护下只能引导到系统设置），其它平台隐藏。 -->
    <SettingsItem v-if="platform === 'windows'" label="Markdown 默认程序" :keywords="['default', 'app', '默认', '程序']">
      <button
        type="button"
        class="velo-text-btn"
        @click="openDefaultApps"
      >
        设为默认…
      </button>
    </SettingsItem>

    <!-- 文件夹右键菜单：Windows 和 Linux 支持，机制各异（Windows=注册表/Linux=action 文件）。macOS Finder 服务已移除，待购入 Mac 设备后重新实现。 -->
    <SettingsItem v-if="platform !== 'macos'" label='文件夹右键菜单增加"在 Velo 中打开"' :keywords="['folder', 'context', 'menu', '右键', '文件夹']" clickable>
      <input
        v-model="folderMenuOn"
        type="checkbox"
        role="switch"
        class="velo-switch"
        @change="toggleFolderMenu"
      >
    </SettingsItem>

    <!-- .md 文件右键菜单：仅 Windows 完整支持（SystemFileAssociations 动词），其它平台留后续迭代。 -->
    <SettingsItem v-if="platform === 'windows'" :label='`Markdown 文件右键菜单增加"在 Velo 中编辑`' :keywords="['md', 'context', 'menu', '右键']" clickable>
      <input
        v-model="mdMenuOn"
        type="checkbox"
        role="switch"
        class="velo-switch"
        @change="toggleMdMenu"
      >
    </SettingsItem>
  </section>
</template>
