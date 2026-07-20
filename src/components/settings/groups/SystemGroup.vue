<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import SettingsItem from '../SettingsItem.vue'

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
  <section class="space-y-4 pt-6">
    <!-- 默认程序:引导到 Windows 设置页面,由用户手动完成(反劫持保护下唯一可靠路径)。 -->
    <SettingsItem label="Markdown 默认程序" :keywords="['default', 'app', '默认', '程序']">
      <button
        type="button"
        class="velo-text-btn"
        @click="openDefaultApps"
      >
        设为默认…
      </button>
    </SettingsItem>

      <!-- 文件夹右键菜单 -->
    <SettingsItem :label='`文件夹右键菜单增加"在 Velo 中打开"`' :keywords="['folder', 'context', 'menu', '右键', '文件夹']" clickable>
      <input
        v-model="folderMenuOn"
        type="checkbox"
        role="switch"
        class="velo-switch"
        @change="toggleFolderMenu"
      >
    </SettingsItem>

    <!-- .md 右键菜单 -->
    <SettingsItem :label='`Markdown 文件右键菜单增加"在 Velo 中编辑"`' :keywords="['md', 'context', 'menu', '右键']" clickable>
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
