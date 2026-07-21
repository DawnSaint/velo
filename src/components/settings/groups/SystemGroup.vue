<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import SettingsItem from '../SettingsItem.vue'

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

onMounted(refreshShellState)
</script>

<template>
  <section class="space-y-4 pt-6">
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

    <!-- 文件夹右键菜单：三平台均支持，机制各异（Windows=注册表/macOS=Finder 服务/Linux=action 文件）。 -->
    <SettingsItem label='文件夹右键菜单增加"在 Velo 中打开"' :keywords="['folder', 'context', 'menu', '右键', '文件夹']" clickable>
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
