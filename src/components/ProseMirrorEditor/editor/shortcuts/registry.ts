// 快捷键注册表(declarative registry)
//
// 设计目标(可维护 / 可扩展):
// 1. 新加快捷键 = 写 1 个 command + 在 bindings.ts 加 1 行 registerShortcut,不碰 EditorInner
// 2. 所有键位在 registry.ts / bindings.ts 一处可见,统一审视
// 3. command 是工厂函数(schema 参数化),不绑死 schema —— 测试 / 多实例可替换
//
// 数据流:
//   bindings.ts → registerShortcut(spec) → 写进 _registry 数组
//   EditorInner.vue → import './editor/shortcuts'(触发 bindings 副作用注册)
//                  → buildShortcutKeymap()(读 _registry 输出 prosemirror-keymap Plugin)
//
// keymap 字符串约定沿用 prosemirror-keymap:'Mod-b' / 'Ctrl-1' / 'Shift-Tab' 等。
// Mac/Win 一律用 Mod-,跨平台。'Mod-Shift-h' 这类全用引号包。

import { keymap } from 'prosemirror-keymap'
import type { Command, EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

// Dispatch 类型 prosemirror-state 和 prosemirror-view 都导出,这里从 prosemirror-state 拿
type Dispatch = (tr: import('prosemirror-state').Transaction) => void

export type ShortcutCommand = (
  state: EditorState,
  dispatch?: Dispatch,
  view?: EditorView,
) => boolean

export interface ShortcutSpec {
  /** prosemirror-keymap 兼容的键字符串,如 'Mod-b' / 'Ctrl-1' / 'Shift-Tab' */
  key: string
  /** 命令实现。接收 state,可选 dispatch / view;返回是否消费此快捷键 */
  command: ShortcutCommand
  /** 给人看的简短描述(后续命令面板 / tooltip 用) */
  label: string
  /** 分组(text / block / table / system),仅作 UI 展示 */
  group: 'text' | 'block' | 'table' | 'system'
}

const _registry: ShortcutSpec[] = []

/** 注册或覆盖同名快捷键(HMR 友好;同一 key 多次 register 时后者覆盖) */
export function registerShortcut(spec: ShortcutSpec): void {
  const existing = _registry.findIndex(s => s.key === spec.key)
  if (existing >= 0) _registry[existing] = spec
  else _registry.push(spec)
}

export function getShortcuts(): readonly ShortcutSpec[] {
  return _registry
}

/**
 * 把 registry 转成 prosemirror-keymap Plugin。
 * 后注册的 keymap 优先级更高(数组里顺序)—— bindings.ts 应保持"具体 > 通用"
 * 顺序,但单 keymap 内只可能命中一个 command,所以顺序影响"先到先得"行为。
 */
export function buildShortcutKeymap() {
  const map: Record<string, ShortcutCommand> = {}
  for (const s of _registry) {
    map[s.key] = s.command
  }
  return keymap(map)
}

/** 测试用:清空 registry */
export function _resetShortcutRegistry(): void {
  _registry.length = 0
}

// re-export Command 类型方便外部 imports
export type { Command }