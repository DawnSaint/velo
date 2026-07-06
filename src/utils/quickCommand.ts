// 统一命令面板(v0.6.2)的前缀分发:输入框首字符决定模式。
//
// 一个输入框,五种模式(对齐 VSCode 多模式 quick box):
//   ''  → file          工作区 .md 模糊查找(原 Ctrl+P)
//   '>' → command       App shell 命令聚合(原 Ctrl+Shift+P)
//   '@' → symbol        当前文档标题(跳转到标题)
//   ':' → line          跳源码行号(源码模式精确,WYSIWYG 提示切源码)
//
// 前缀字符保留在输入框 raw query 里(与旧 CommandPalettePanel 的 '>' 行为一致),
// 这里把它剥成 { mode, text, prefix };text 再喂给各模式自己的过滤函数。
// 前缀后跟一个可选空格也剥掉('>@save' 与 '> save' 等价),沿用旧
// normalizeCommandPaletteQuery 的语义并泛化到所有前缀。

export type QuickCommandMode = 'file' | 'command' | 'symbol' | 'line'

export interface ParsedQuickCommand {
  mode: QuickCommandMode
  /** 前缀 + 一个可选空格剥掉后的有效搜索文本 */
  text: string
  /** 前缀字符;file 模式为 '' */
  prefix: string
}

/** 前缀 → 模式映射;增量加模式只在此扩展 + 联合类型加分支。 */
const PREFIX_MODES: Record<string, QuickCommandMode> = {
  '>': 'command',
  '@': 'symbol',
  ':': 'line',
}

/**
 * 由 raw query 首字符判定模式,剥掉前缀 + 一个可选空格返回有效文本。
 *
 * 未识别前缀(含空 query)一律 file 模式 —— 文件查找是默认形态。
 */
export function parseQuickCommand(raw: string): ParsedQuickCommand {
  const first = raw[0] ?? ''
  const mode = PREFIX_MODES[first]
  if (mode) {
    const text = raw.slice(1).replace(/^\s/, '')
    return { mode, text, prefix: first }
  }
  return { mode: 'file', text: raw, prefix: '' }
}
