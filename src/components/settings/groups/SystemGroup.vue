<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import SettingsItem from '../SettingsItem.vue'
import { useUpdater } from '@/composables/useUpdater'
import { useNotifyStore } from '@/stores/notify'

// 当前版本：从 Tauri app.getInfo() 读取 package.json 中的 version 字段。
const appVersion = ref('')

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

// GPU 硬件加速（仅 Windows WebView2 有效）：启动时从 Rust 读偏好，用户切换时写回。
// additional_browser_args 在 WebView 创建时固定，切换后需重启生效。
const gpuAccelOn = ref(true)
const notify = useNotifyStore()

async function refreshGpuAccelState() {
  if (platform.value !== 'windows') return
  try {
    gpuAccelOn.value = await invoke<boolean>('gpu_accel_state')
  } catch (e) {
    console.warn('[settings] 读取 GPU 加速状态失败', e)
  }
}

async function toggleGpuAccel() {
  try {
    await invoke('set_gpu_accel', { enabled: gpuAccelOn.value })
    notify.info('GPU 加速设置已更改，重启应用后生效')
  } catch (e) {
    console.warn('[settings] 切换 GPU 加速失败', e)
  }
}

// ========== 自动更新 ==========
const {
  status: updateStatus,
  updateInfo,
  downloadProgress,
  downloadSpeed,
  checkForUpdate,
  startDownload,
  installNow,
  dismissUpdate,
} = useUpdater()

async function onCheckUpdate() {
  await checkForUpdate(false)
}

async function onStartDownload() {
  await startDownload()
}

async function onInstallNow() {
  await installNow()
}

onMounted(async () => {
  if (tauri) {
    try {
      appVersion.value = await getVersion()
    } catch (e) {
      console.warn('[settings] 读取版本号失败', e)
    }
  }
  await refreshShellState()
  await refreshGpuAccelState()
})
</script>

<template>
  <section class="space-y-4 pt-6">
    <!-- 版本信息：label 右侧为检查更新按钮，hint 显示当前版本号 -->
    <SettingsItem v-if="tauri" label="版本信息" :hint="appVersion ? `v${appVersion}` : undefined" :keywords="['version', '版本', 'update', '更新', '检查', 'current']">
      <button
        type="button"
        class="velo-text-btn"
        :disabled="updateStatus === 'checking' || updateStatus === 'downloading' || updateStatus === 'installing'"
        @click="onCheckUpdate"
      >
        {{ updateStatus === 'checking' ? '检查中…' : '检查更新' }}
      </button>
    </SettingsItem>
    <!-- 发现新版本：版本号 + 更新说明 + 下载安装按钮（up-to-date / error 只走 toast，不占 UI） -->
    <!--
      更新卡片：available(蓝色) / downloading(蓝色+进度条) / downloaded(绿色,选择安装) / installing(蓝色,安装中)
      downloaded 状态用绿色区分,提示用户已下载完成、可立即安装
    -->
    <div
      v-if="tauri && updateInfo && ['available', 'downloading', 'downloaded', 'installing'].includes(updateStatus)"
      :class="updateStatus === 'downloaded'
        ? 'rounded-lg border border-green-500/30 bg-green-500/5 p-3'
        : 'rounded-lg border border-[var(--md-primary-color)]/30 bg-[var(--md-primary-color)]/5 p-3'"
    >
      <div class="flex items-center gap-2 text-[0.8125rem] font-medium text-gray-600 dark:text-gray-300">
        {{ updateStatus === 'downloaded' ? `新版本 v${updateInfo.version} 已下载完成` : `发现新版本 v${updateInfo.version}` }}
      </div>
      <p v-if="updateInfo.body" class="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-400">
        {{ updateInfo.body }}
      </p>
      <div class="mt-3 flex items-center gap-3">
        <!-- available: 下载并安装 -->
        <button
          v-if="updateStatus === 'available'"
          type="button"
          class="velo-text-btn"
          @click="onStartDownload"
        >
          下载并安装
        </button>
        <!-- downloaded: 立即安装 + 稍后 -->
        <template v-else-if="updateStatus === 'downloaded'">
          <button
            type="button"
            class="velo-text-btn"
            @click="onInstallNow"
          >
            立即安装
          </button>
          <button
            type="button"
            class="velo-text-btn opacity-60"
            @click="dismissUpdate"
          >
            稍后
          </button>
        </template>
        <!-- installing: 安装中 -->
        <button
          v-else-if="updateStatus === 'installing'"
          type="button"
          class="velo-text-btn"
          disabled
        >
          安装中…
        </button>
      </div>
      <!-- downloading: 纯文本进度 + 速度 + 进度条，不用按钮 -->
      <div v-if="updateStatus === 'downloading'" class="mt-3">
        <div class="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
          <span>下载中 {{ downloadProgress }}%</span>
          <span v-if="downloadSpeed">{{ downloadSpeed }}</span>
        </div>
        <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
          <div
            class="h-full rounded-full bg-[var(--md-primary-color)] transition-all duration-150"
            :style="{ width: `${downloadProgress}%` }"
          />
        </div>
      </div>
    </div>

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
    <SettingsItem v-if="platform !== 'macos'" label='文件夹右键菜单增加"在 Velo 中打开"' :keywords="['folder', 'context', 'menu', '右键', '文件夹']">
      <input
        v-model="folderMenuOn"
        type="checkbox"
        role="switch"
        class="velo-switch"
        @change="toggleFolderMenu"
      >
    </SettingsItem>

    <!-- .md 文件右键菜单：仅 Windows 完整支持（SystemFileAssociations 动词），其它平台留后续迭代。 -->
    <SettingsItem v-if="platform === 'windows'" :label='`Markdown 文件右键菜单增加"在 Velo 中编辑`' :keywords="['md', 'context', 'menu', '右键']">
      <input
        v-model="mdMenuOn"
        type="checkbox"
        role="switch"
        class="velo-switch"
        @change="toggleMdMenu"
      >
    </SettingsItem>

    <!-- GPU 硬件加速（仅 Windows WebView2）：默认开启，关闭后重启生效。 -->
    <SettingsItem v-if="platform === 'windows'" label="使用图形加速功能" :keywords="['gpu', 'hardware', 'acceleration', 'graphics', '图形', '加速', '硬件']">
      <input
        v-model="gpuAccelOn"
        type="checkbox"
        role="switch"
        class="velo-switch"
        @change="toggleGpuAccel"
      >
    </SettingsItem>
  </section>
</template>
