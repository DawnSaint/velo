/**
 * Font Stacks — 纯函数字体族栈定义与构建。
 *
 * 三类字体（latin / cjk / mono），每类有一个 key → CSS font-family stack 的映射表。
 * `buildFontStack(latinKey, cjkKey, monoKey)` 将 latin + cjk 拼接为 sans 栈，
 * 返回 { sans, mono } 供调用方注入 CSS 变量。
 *
 * 设计参考 vmark 的 fontStacks 模块，适配 velo 跨平台（Windows + macOS）场景：
 * - latin：跨平台衬线 + 无衬线
 * - cjk：兼顾 macOS（PingFang / Songti / Kaiti）和 Windows（微软雅黑 / 宋体 / 楷体）
 * - mono：跨平台等宽 + 各平台系统字体 + 流行编程字体
 *
 * `system` key 保留在映射表中做内部 fallback（buildFontStack 对未知 key 回退到 system），
 * 但 UI 下拉不再显示 system 选项，store 默认值改为各平台的具体字体 key。
 *
 * 关键技巧：`stripTrailingGenerics` 去掉 latin 栈尾部的 generic family（如 serif），
 * 让 CJK 字形能回退到 CJK 字体而非系统 serif/sans-serif。
 *
 * @coordinates-with stores/editor.ts — store 的 computed fontFamily/fontMono 调用 buildFontStack
 * @coordinates-with App.vue — watch store 字段变化后注入 --md-font-family / --font-mono
 * @coordinates-with lib/export/htmlRenderer.ts — 导出 HTML 写入相同的 CSS 变量
 */

// ---------------------------------------------------------------------------
// 字体栈映射表
// ---------------------------------------------------------------------------

/**
 * 每个字体条目的元信息。
 * - stack: CSS font-family 字符串
 * - platforms: 该字体原生可用的平台集合。'all' 表示跨平台可用（含开源字体）。
 *   设置面板按当前运行平台过滤,只显示可用选项。
 */
interface FontEntry {
  stack: string
  platforms: 'all' | readonly ('macos' | 'windows')[]
}

export const fontStacks = {
  latin: {
    system: { stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', platforms: 'all' },
    georgia: { stack: 'Georgia, "Times New Roman", serif', platforms: 'all' },
    palatino: { stack: '"Palatino Linotype", Palatino, Georgia, serif', platforms: 'all' },
    charter: { stack: 'Charter, Georgia, serif', platforms: ['macos'] },
    cambria: { stack: 'Cambria, Georgia, serif', platforms: ['windows'] },
    constantia: { stack: 'Constantia, Georgia, serif', platforms: ['windows'] },
  },
  cjk: {
    system: { stack: '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif', platforms: 'all' },
    pingfang: { stack: '"PingFang SC", "PingFang TC", sans-serif', platforms: ['macos'] },
    songti: { stack: '"Songti SC", "STSong", "SimSun", "NSimSun", serif', platforms: ['windows'] },
    kaiti: { stack: '"Kaiti SC", "STKaiti", "KaiTi", serif', platforms: ['windows'] },
    yahei: { stack: '"Microsoft YaHei", "PingFang SC", sans-serif', platforms: ['windows'] },
    sourcehans: { stack: '"Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif', platforms: 'all' },
  },
  mono: {
    system: { stack: 'ui-monospace, "SF Mono", "Cascadia Code", Consolas, Menlo, Monaco, monospace', platforms: 'all' },
    jetbrains: { stack: '"JetBrains Mono", ui-monospace, Consolas, Menlo, monospace', platforms: 'all' },
    consolas: { stack: 'Consolas, "Courier New", ui-monospace, monospace', platforms: ['windows'] },
    sfmono: { stack: '"SF Mono", ui-monospace, Menlo, monospace', platforms: ['macos'] },
    menlo: { stack: 'Menlo, ui-monospace, Monaco, monospace', platforms: ['macos'] },
    monaco: { stack: 'Monaco, ui-monospace, Menlo, monospace', platforms: ['macos'] },
    cascadiacode: { stack: '"Cascadia Code", "Cascadia Mono", ui-monospace, Consolas, monospace', platforms: ['windows'] },
    firacode: { stack: '"Fira Code", ui-monospace, Consolas, monospace', platforms: 'all' },
    hack: { stack: 'Hack, ui-monospace, Consolas, monospace', platforms: 'all' },
    ibmplexmono: { stack: '"IBM Plex Mono", ui-monospace, Consolas, monospace', platforms: 'all' },
    inconsolata: { stack: 'Inconsolata, ui-monospace, Consolas, monospace', platforms: 'all' },
    sourcecodepro: { stack: '"Source Code Pro", ui-monospace, Consolas, Menlo, monospace', platforms: 'all' },
    dejavu: { stack: '"DejaVu Sans Mono", ui-monospace, Consolas, Menlo, monospace', platforms: 'all' },
  },
} as const

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * CSS generic font families。当 font-family stack 以这些结尾时，
 * 浏览器在该处终止回退——不会继续尝试后面的列出的字体。
 */
const GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'system-ui',
  'cursive',
  'fantasy',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
])

/**
 * 去掉 font-family stack 尾部的 generic family（如 serif / sans-serif）。
 *
 * latin 栈拼接 cjk 栈时，latin 栈尾部的 generic 会阻断 CJK 字形回退——
 * 浏览器遇到 CJK 字符在 generic 处停止（generic 终止回退链），永远到不了 CJK 字体。
 * 去掉 latin 栈尾部的 generic 后，CJK 字符才能回退到用户选择的 CJK 字体栈。
 * CJK 栈保留自己的尾部 generic 作为最终兜底。始终保留至少一个 named family。
 */
function stripTrailingGenerics(stack: string): string {
  const parts = stack.split(',').map(p => p.trim())
  while (
    parts.length > 1 &&
    GENERIC_FONT_FAMILIES.has(parts[parts.length - 1].toLowerCase())
  ) {
    parts.pop()
  }
  return parts.join(', ')
}

// ---------------------------------------------------------------------------
// 构建函数
// ---------------------------------------------------------------------------

export interface FontStackResult {
  /** 正文字体族（latin + cjk 拼接），注入 --md-font-family */
  sans: string
  /** 等宽字体族，注入 --font-mono */
  mono: string
}

/**
 * 从三个字体 key 构建完整的 font-family stack。纯函数——无 DOM 访问。
 *
 * @param latinKey - latin 字体 key（fontStacks.latin 的键）
 * @param cjkKey - cjk 字体 key（fontStacks.cjk 的键）
 * @param monoKey - mono 字体 key（fontStacks.mono 的键）
 * @returns { sans, mono } 两个 CSS font-family 字符串
 */
export function buildFontStack(
  latinKey: string,
  cjkKey: string,
  monoKey: string,
): FontStackResult {
  const latinEntry =
    fontStacks.latin[latinKey as keyof typeof fontStacks.latin] ??
    fontStacks.latin.system
  const cjkEntry =
    fontStacks.cjk[cjkKey as keyof typeof fontStacks.cjk] ??
    fontStacks.cjk.system
  const monoEntry =
    fontStacks.mono[monoKey as keyof typeof fontStacks.mono] ??
    fontStacks.mono.system

  return {
    sans: `${stripTrailingGenerics(latinEntry.stack)}, ${cjkEntry.stack}`,
    mono: monoEntry.stack,
  }
}

/**
 * 单独解析等宽字体栈。供需要单独读取 mono 字体的场景使用
 *（如导出 HTML 只需 mono 栈时）。
 */
export function resolveMonoFontStack(monoKey: string): string {
  return (
    fontStacks.mono[monoKey as keyof typeof fontStacks.mono] ??
    fontStacks.mono.system
  ).stack
}
