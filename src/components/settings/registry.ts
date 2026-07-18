// 设置面板分组注册表（#settings-panel 重做）
//
// 目标(见 ROADMAP):做成可扩展的分组结构,新设置项只需注册一行。
//
// 用法:
//   registerSettingsGroup({
//     id: 'editor',
//     title: '编辑器',
//     icon: Type,
//     order: 10,
//     component: EditorGroup,
//   })
//
// SettingsPage 读取 getSettingsGroups() 渲染左导航 + 右内容;
// 新增分组 = 建一个 .vue 组件 + 在 registerGroups.ts 加一行 registerSettingsGroup。

import type { Component } from 'vue'

export interface SettingsGroup {
  /** 分组唯一 id,同时作为 SettingsPage 内 active group 的 key */
  id: string
  /** 左导航显示的标题 */
  title: string
  /** 左导航图标(lucide 组件) */
  icon: Component
  /** 渲染顺序,数值小的在上;内置分组按 10 / 20 / 30 / 40 留间距便于插入 */
  order: number
  /** 分组内容组件,无 props(self-contained,直接读 store) */
  component: Component
}

const groups: SettingsGroup[] = []

/** 注册一个设置分组。同 id 幂等,不重复压入。注册后按 order 升序排列。 */
export function registerSettingsGroup(group: SettingsGroup): void {
  if (groups.some(g => g.id === group.id)) return
  groups.push(group)
  groups.sort((a, b) => a.order - b.order)
}

/** 获取所有已注册分组(按 order 升序)。SettingsPage 渲染左导航用。 */
export function getSettingsGroups(): readonly SettingsGroup[] {
  return groups
}
