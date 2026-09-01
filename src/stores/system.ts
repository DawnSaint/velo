import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { PersistedSettings } from './persistence'

// 与 editor(编辑器偏好)/document(文档保存偏好)平级的第三类设置:
// 应用层面的系统行为(自动更新等)。SystemGroup 中走 Rust 端的设置
// (右键菜单/GPU 加速)不在此处 —— 它们存注册表/WebView args,不走 velo-settings.json。

export const useSystemStore = defineStore('system', () => {
  /** 自动更新开关(默认开启)。开启时启动后静默检查新版本并在后台下载,
   *  下载完成后提示用户去设置页安装;关闭时启动不再检查,手动检查不受影响。 */
  const autoUpdateEnabled = ref(true)

  /** 旧设置文件无 system 节时 s 为 undefined,保持默认值;非法值忽略。 */
  function hydrateSettings(s?: PersistedSettings['system']) {
    if (typeof s?.autoUpdateEnabled === 'boolean') autoUpdateEnabled.value = s.autoUpdateEnabled
  }

  function snapshotSettings(): PersistedSettings['system'] {
    return { autoUpdateEnabled: autoUpdateEnabled.value }
  }

  return {
    autoUpdateEnabled,
    hydrateSettings,
    snapshotSettings,
  }
})
