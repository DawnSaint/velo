// 快捷键模块入口 —— EditorInner.vue 一行 `import './editor/shortcuts'` 触发全部注册。
//
// import './bindings' 触发 bindings.ts 顶层 registerShortcut 调用,registry 数组
// 准备好。export buildShortcutKeymap() 给 EditorInner 装配进 allPlugins。

import './bindings'

export {
  registerShortcut,
  getShortcuts,
  buildShortcutKeymap,
  _resetShortcutRegistry,
  type ShortcutCommand,
  type ShortcutSpec,
} from './registry'