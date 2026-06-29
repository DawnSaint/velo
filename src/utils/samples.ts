// 示例文档的唯一数据源 —— WelcomeDialog / FileActionsPanel / CommandPalette
// 共用同一份 entries,避免 key / label / fileName 在三处散落字面量。
//
// 读盘走 `stores/persistence.ts:readSampleContent(key)` —— release 模式
// `resolveResource(entry.fileName)` 读 bundle.resources,dev 模式 fallback
// Vite ?raw。不抽盘、不写用户目录,sample 内容物理上不可被用户修改。

export interface SampleEntry {
  /** 命令面板 / 文件操作面板 / 欢迎对话框统一使用的稳定 id */
  key: 'syntax'
  /** 显示给用户的中文标签 */
  label: string
  /** 命令面板副标题 / 欢迎对话框描述 */
  description: string
  /** bundle.resources 中的文件名 */
  fileName: string
}

export const SAMPLE_ENTRIES: readonly SampleEntry[] = [
  {
    key: 'syntax',
    label: 'Markdown 语法指南',
    description: 'Markdown 基础与进阶语法 + 20 种 shiki 高亮',
    fileName: 'sample.md',
  },
] as const

export function findSample(key: string): SampleEntry | undefined {
  return SAMPLE_ENTRIES.find(e => e.key === key)
}
