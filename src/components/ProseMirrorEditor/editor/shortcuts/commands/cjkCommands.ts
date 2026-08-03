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
import { formatMarkdown, formatSelection, createDefaultFormatting } from '@/lib/cjkFormatter'
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
 * 格式化 CJK 排版（智能入口）。
 * - 有选区：格式化选区文本
 * - 无选区：格式化当前块
 *
 * NOTE: 当前未挂入命令面板 / 快捷键，仅 cmdFormatCJKDocument 已接入。
 *       选区 / 块级格式化留待后续版本启用。
 */
export function cmdFormatCJK(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const { selection } = state
    if (!selection.empty) {
      return cmdFormatCJKSelection(schema)(state, dispatch)
    }
    return cmdFormatCJKBlock(schema)(state, dispatch)
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

/**
 * 格式化 CJK 排版（当前块）。
 * 取光标所在顶层块，序列化 → formatMarkdown → 解析回 → 替换该块。
 */
export function cmdFormatCJKBlock(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const { $from } = state.selection
    if ($from.depth < 1) return false

    if (!dispatch) return true

    const config = getCjkConfig()
    const blockNode = $from.node(1)
    const blockStart = $from.before(1)
    const blockEnd = $from.after(1)

    // 包装到临时 doc 中进行序列化
    const tempDoc = schema.nodes.doc.create(null, blockNode)
    const blockMarkdown = toMarkdown(tempDoc)

    const formatted = formatMarkdown(blockMarkdown, config)
    if (formatted === blockMarkdown) return true

    const newDoc = fromMarkdown(formatted, schema)
    const tr = state.tr
      .replaceWith(blockStart, blockEnd, newDoc.content)
      .setMeta('addToHistory', true)
    dispatch(tr)
    return true
  }
}

/**
 * 格式化 CJK 排版（选区）。
 * 有选区时格式化选中的纯文本（不做 markdown 结构保护，适合段落内文本）。
 * 选区跨多块时回退到全文格式化。
 */
export function cmdFormatCJKSelection(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const { selection } = state
    if (selection.empty) return false

    // 选区跨越多个顶层块时走全文格式化（保 markdown 结构）
    const $from = state.doc.resolve(selection.from)
    const $to = state.doc.resolve(selection.to)
    if ($from.depth < 1 || $to.depth < 1) {
      return cmdFormatCJKDocument(schema)(state, dispatch)
    }
    const fromBlock = $from.before(1)
    const toBlock = $to.before(1)
    if (fromBlock !== toBlock) {
      return cmdFormatCJKDocument(schema)(state, dispatch)
    }

    if (!dispatch) return true

    const config = getCjkConfig()
    // 取选区纯文本，用 formatSelection 格式化
    const selectedText = state.doc.textBetween(selection.from, selection.to, '\n')
    const formatted = formatSelection(selectedText, config)

    if (formatted === selectedText) return true

    const tr = state.tr
      .replaceSelectionWith(schema.text(formatted), true)
      .setMeta('addToHistory', true)
    dispatch(tr)
    return true
  }
}
