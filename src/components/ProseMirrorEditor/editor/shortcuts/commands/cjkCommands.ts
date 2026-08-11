// CJK 智能排版格式化命令(Phase 3)
//
// 通过 markdown 往返(序列化 → 格式化 → 解析)实现文档级 / 块级 / 选区级
// CJK 排版：中英文间距、全角标点、直角引号等。保 undo / 保 inline marks。
//
// 手动触发（命令 / 快捷键），非每次键入自动执行。
// 移植自 vmark 的 wysiwygAdapterCjk.ts，适配 velo 的 markdownIO + store 架构。

import type { Schema } from 'prosemirror-model'
import type { ShortcutCommand } from '../registry'
import { toMarkdown, fromMarkdown } from '../../markdownIO'
import { formatMarkdown, createDefaultFormatting } from '@/lib/cjkFormatter'
import type { CJKFormattingSettings } from '@/lib/cjkFormatter'
import { useEditorStore } from '@/stores/editor'

/** 获取 CJK 格式化配置。store 未就绪时 fallback 默认配置。 */
function getCjkConfig(): CJKFormattingSettings {
  try {
    return useEditorStore().cjkFormatting
  } catch {
    // pinia 未就绪 / 单元测试场景，fallback 默认值
    return createDefaultFormatting()
  }
}

/**
 * 格式化 CJK 排版（全文）。
 * 序列化整个文档 → formatMarkdown → 解析回 → 替换文档内容。
 */
export function cmdFormatCJKDocument(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    if (!dispatch) return true

    const config = getCjkConfig()
    const markdown = toMarkdown(state.doc)
    const formatted = formatMarkdown(markdown, config)

    // 格式化后内容不变则不 dispatch
    if (formatted === markdown) return true

    const newDoc = fromMarkdown(formatted, schema)
    const tr = state.tr
      .replaceWith(0, state.doc.content.size, newDoc.content)
      .setMeta('addToHistory', true)
    dispatch(tr)
    return true
  }
}


