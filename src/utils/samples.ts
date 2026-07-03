// 示例文档的唯一数据源 —— WelcomeDialog / FileActionsPanel / CommandPalette
// 共用同一个 SAMPLE 对象,避免 key / label / fileName 在三处散落字面量。
//
// 读盘走 `stores/persistence.ts:readSampleContent(key)` —— Vite 动态 import
// 拆 chunk,只在使用时才下载。不抽盘、不写用户目录,sample 内容物理上不可被用户修改。

export interface SampleEntry {
  /** 命令面板 / 文件操作面板 / 欢迎对话框统一使用的稳定 id */
  key: 'syntax'
  /** 显示给用户的中文标签 */
  label: string
  /** 命令面板副标题 / 欢迎对话框描述 */
  description: string
  /** Vite 动态 import 的文件名(key into SAMPLE_LOADERS) */
  fileName: string
}

export const SAMPLE: SampleEntry = {
  key: 'syntax',
  label: 'Markdown 语法指南',
  description: 'Markdown 基础与进阶语法 + 20 种 shiki 高亮',
  fileName: 'sample.md',
} as const

/** 兼容 persistence.ts 的查找入口(单例直接返回)。 */
export function findSample(key: string): SampleEntry | undefined {
  return SAMPLE.key === key ? SAMPLE : undefined
}
