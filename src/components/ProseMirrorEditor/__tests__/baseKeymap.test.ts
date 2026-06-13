// 回归测试:baseKeymap 必须在 EditorInner 的 plugins 列表里。
//
// 背景:
//   Phase 2 写新 EditorInner 时漏了 `keymap(baseKeymap)`,导致 Enter / Backspace /
//   Mod-d 等基础键全无响应(用户报"按回车不换行")。ProseMirror 不会自动
//   装 baseKeymap,需要 caller 显式 keymap(baseKeymap)。
//   这条测试把"基础键至少在某个 keymap 插件里被覆盖"做成了合约。
//
// 策略:用 EditorInner.vue 的源文件文本做断言。
//  - 必须 import 了 baseKeymap
//  - 必须在 plugins 数组里 keymap(baseKeymap) 了一次
//
// 这是个粗糙的合约(文本匹配),但能挡住"忘了装 baseKeymap"这种回归。
// 真正的 E2E(模拟键盘事件)留到 v0.5.x 端到端测试阶段。

import { describe, expect, it } from 'vitest'
// vite 解析 ?raw:把文件内容作为字符串 default 导出
import editorInnerSource from '../EditorInner.vue?raw'

describe('EditorInner.vue 装入 baseKeymap', () => {
  const source: string = editorInnerSource

  it('导入 baseKeymap', () => {
    expect(source).toMatch(/from\s+['"]prosemirror-commands['"]/)
    expect(source).toMatch(/import\s+\{[^}]*\bbaseKeymap\b[^}]*\}\s+from\s+['"]prosemirror-commands['"]/)
  })

  it('在 plugins 数组里 keymap(baseKeymap)', () => {
    // 容忍任意 whitespace / 换行
    expect(source).toMatch(/keymap\(\s*baseKeymap\s*\)/)
  })
})
