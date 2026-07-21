// 内置设置分组注册（#settings-panel 重做）
//
// App.vue setup 阶段调一次 registerBuiltinSettingsGroups() 把内置 4 组挂进 registry。
// 新增分组 = 建一个 groups/XxxGroup.vue + 在此加一行 registerSettingsGroup。
// registerSettingsGroup 幂等,重复调用安全(HMR / 多次初始化不会重复压入)。

import { isTauri } from '@tauri-apps/api/core'
import { Type, Palette, FileText, MonitorCog } from '@lucide/vue'
import { registerSettingsGroup } from './registry'
import EditorGroup from './groups/EditorGroup.vue'
import AppearanceGroup from './groups/AppearanceGroup.vue'
import DocumentGroup from './groups/DocumentGroup.vue'
import SystemGroup from './groups/SystemGroup.vue'

let registered = false

export function registerBuiltinSettingsGroups(): void {
  if (registered) return
  registered = true

  registerSettingsGroup({
    id: 'editor',
    title: '编辑器',
    icon: Type,
    order: 10,
    component: EditorGroup,
  })
  registerSettingsGroup({
    id: 'appearance',
    title: '外观',
    icon: Palette,
    order: 20,
    component: AppearanceGroup,
  })
  registerSettingsGroup({
    id: 'document',
    title: '文档',
    icon: FileText,
    order: 30,
    component: DocumentGroup,
  })

  // 系统分组在任意桌面端注册（含文件夹右键菜单集成）。
  // Windows:注册表 verb;macOS:Finder 服务(action 文件);Linux:action 文件。
  // 各平台渲染由 SystemGroup.vue 内部按 UA 分支控制。
  if (isTauri()) {
    registerSettingsGroup({
      id: 'system',
      title: '系统',
      icon: MonitorCog,
      order: 40,
      component: SystemGroup,
    })
  }
}
