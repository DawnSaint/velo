<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'

// Windows 检测:isTauri 守门桌面端,userAgent 判定 Windows(navigator.platform 已弃用)。
// 三个控件都只在 Windows 桌面端显示;其它平台整个分组不注册(registerGroups.ts 守门)。
const isWindows = isTauri() && /Win/.test(navigator.userAgent)

// Windows 右键菜单启用状态:启动时从 Rust 读偏好,用户切换时写回。
const folderMenuOn = ref(true)
const mdMenuOn = ref(true)

async function refreshShellState() {
  if (!isWindows) return
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
  if (!isWindows) return
  try {
    await invoke('open_default_apps_settings')
  } catch (e) {
    console.warn('[settings] 打开默认应用设置失败', e)
  }
}

onMounted(refreshShellState)
</script>

<template>
  <section class="space-y-4">
    <h2 class="text-sm font-semibold text-gray-700 dark:text-gray-200">系统</h2>

    <!-- Windows 集成分组:包含"设为 Markdown 默认程序"入口 + 文件夹/ .md 右键菜单开关,
         给安装时没勾选的用户一个开启途径。 -->
    <div class="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-700">
      <span class="block text-xs font-medium uppercase tracking-wider text-gray-400">Windows 集成</span>

      <!-- 默认程序:引导到 Windows 设置页面,由用户手动完成(反劫持保护下唯一可靠路径)。 -->
      <div class="velo-setting-row h-8">
        <span class="velo-setting-label">Markdown 默认程序</span>
        <button
          type="button"
          class="velo-text-btn"
          @click="openDefaultApps"
        >
          设为默认…
        </button>
      </div>

      <!-- 文件夹右键菜单 -->
      <label class="velo-setting-row h-8 cursor-pointer">
        <span class="velo-setting-label">文件夹右键"在 Velo 中打开"</span>
        <input
          v-model="folderMenuOn"
          type="checkbox"
          role="switch"
          class="velo-switch"
          @change="toggleFolderMenu"
        >
      </label>

      <!-- .md 右键菜单 -->
      <label class="velo-setting-row h-8 cursor-pointer">
        <span class="velo-setting-label">.md 文件右键"在 Velo 中编辑"</span>
        <input
          v-model="mdMenuOn"
          type="checkbox"
          role="switch"
          class="velo-switch"
          @change="toggleMdMenu"
        >
      </label>
    </div>
  </section>
</template>
