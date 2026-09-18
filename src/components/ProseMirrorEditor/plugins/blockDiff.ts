// Block Tree Diff —— WYSIWYG diff 的结构化比对层(#diff-block-tree)
//
// 取代旧的"拍平纯文本行级 diff":在新旧 doc 的顶层 block 序列上跑 Myers,
// 比对 key = 节点类型 + attrs + 文本 + inline marks 签名 + 非文本 leaf 节点。
// 这样旧实现的盲区都会反映为 block key 差异:
// - 格式变更(加粗 / 链接 / 颜色):文本相同但 marks 签名不同 → pair(同文异 key)
// - 节点类型变更(段落 → 标题):类型不同 → pair(同文异 key)
// - 非文本节点(图片 / hr / 公式)增删:leaf 节点进 key → insert/delete
// - 段落拆分(1 旧 block → N 新 block):delete+insert 配对,首对 pair + 多余 insert
//
// 输出 op 序列供 diffDecoration 消费:
// - equal:未变 block,不渲染
// - insert:整 block 新增 → Decoration.node 绿底
// - delete:整 block 删除 → 占位 widget(blockSummary)
// - pair:删除+插入配对(=「修改」)→ 文本不同走块内字符级 diff;文本相同
//   但 key 不同 = 格式 / 类型变更 → 整 block 变更标记

import type { Node as PMNode } from 'prosemirror-model'
import { myersDiff } from '@/utils/lineDiff'

// ========== 类型定义 ==========

/** 顶层 block 信息(新 / 旧 doc 通用) */
export interface BlockEntry {
  node: PMNode
  /** block 在 doc 中的起始 pos */
  pos: number
  /** nodeSize */
  size: number
  /** 结构签名(类型 + attrs + 文本 + marks + 非文本 leaf) */
  key: string
  /** 块内文本段(doc 绝对 pos),用于字符级 diff 的 offset→pos 映射 */
  segments: Array<{ pos: number; text: string }>
  /** 块内全部文本(segments 顺序拼接) */
  text: string
}

export type BlockDiffOp =
  | { kind: 'equal'; oldIndex: number; newIndex: number }
  | { kind: 'insert'; newIndex: number }
  | { kind: 'delete'; oldIndex: number }
  | { kind: 'pair'; oldIndex: number; newIndex: number }
  | { kind: 'split'; oldIndex: number; newIndices: number[] }
  | { kind: 'merge'; oldIndices: number[]; newIndex: number }

// ========== block 收集与签名 ==========

/**
 * 收集 doc 顶层 block,附带结构签名与块内文本位置表。
 * pos 从 0 起累加 nodeSize;descendants 的 localPos 换算绝对 pos = pos + 1 + localPos
 * (与旧 extractText 同一约定)。
 */
export function collectBlocks(doc: PMNode): BlockEntry[] {
  const blocks: BlockEntry[] = []
  let pos = 0
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i)
    const segments: Array<{ pos: number; text: string }> = []
    let text = ''
    node.descendants((child, localPos) => {
      if (child.isText && child.text) {
        segments.push({ pos: pos + 1 + localPos, text: child.text })
        text += child.text
      }
      return true
    })
    blocks.push({ node, pos, size: node.nodeSize, key: blockKey(node), segments, text })
    pos += node.nodeSize
  }
  return blocks
}

/**
 * block 结构签名:节点类型 + attrs + 每个文本节点的(文本 + marks 签名)
 * + 每个非文本 leaf 节点的(类型 + attrs)。
 * 任何结构 / 格式 / 内容差异都会改变 key,从而在 block 序列 diff 中体现。
 */
function blockKey(node: PMNode): string {
  const parts: string[] = [node.type.name, JSON.stringify(node.attrs)]
  node.descendants((child) => {
    if (child.isText) {
      parts.push(child.text ?? '')
      // marks 签名:类型 + attrs(如 link 的 href),排序保证与顺序无关
      parts.push(markSig(child))
    }
    else if (child.isLeaf) {
      // 非文本 leaf:image / hr / math_inline / emoji / hard_break 等
      parts.push(`<${child.type.name}:${JSON.stringify(child.attrs)}>`)
    }
    return true
  })
  return parts.join('')
}

/** 无可见内容的 block(空段落):无文本且无非文本 leaf */
function isEmptyBlock(node: PMNode): boolean {
  if (node.textContent !== '') return false
  let hasLeaf = false
  node.descendants((child) => {
    if (child.isLeaf && !child.isText) hasLeaf = true
    return !hasLeaf
  })
  return !hasLeaf
}

/** 拆分 / 合并判定用的文本归一化:去掉全部空白(段落边界会吃掉原空格 / 换行) */
function normText(s: string): string {
  return s.replace(/\s+/g, '')
}

// ========== 主函数 ==========

/**
 * 对两个 PM doc 做顶层 Block 级 diff。
 * 连续 delete + 紧随 insert 配对为 pair(「修改」语义,同 lineDiff 的配对规则);
 * 空块配对退化:旧块为空 → 纯 insert(避免空段落 vs 新文本段显示为"修改"),
 * 新块为空 → 纯 delete。
 */
export function diffBlocks(
  oldDoc: PMNode,
  newDoc: PMNode,
): { ops: BlockDiffOp[]; oldBlocks: BlockEntry[]; newBlocks: BlockEntry[] } {
  const oldBlocks = collectBlocks(oldDoc)
  const newBlocks = collectBlocks(newDoc)
  const editOps = myersDiff(oldBlocks.map(b => b.key), newBlocks.map(b => b.key))

  const ops: BlockDiffOp[] = []
  let oi = 0
  let ni = 0
  let k = 0

  while (k < editOps.length) {
    const op = editOps[k]
    if (op === 'equal') {
      ops.push({ kind: 'equal', oldIndex: oi++, newIndex: ni++ })
      k++
    }
    else if (op === 'delete') {
      const dels: number[] = []
      while (k < editOps.length && editOps[k] === 'delete') { dels.push(oi++); k++ }
      const inss: number[] = []
      while (k < editOps.length && editOps[k] === 'insert') { inss.push(ni++); k++ }

      // 拆分 / 合并识别(#diff-semantic-render):
      // 去空白后文本相同 → 纯结构变化,不误报为删行+加行。
      // (分段处原文的空格/换行被段落边界替代,所以用去空白比较)
      if (
        dels.length === 1 && inss.length > 1
        && normText(oldBlocks[dels[0]].text) === normText(inss.map(i => newBlocks[i].text).join(''))
      ) {
        ops.push({ kind: 'split', oldIndex: dels[0], newIndices: inss })
      }
      else if (
        inss.length === 1 && dels.length > 1
        && normText(newBlocks[inss[0]].text) === normText(dels.map(i => oldBlocks[i].text).join(''))
      ) {
        ops.push({ kind: 'merge', oldIndices: dels, newIndex: inss[0] })
      }
      else {
        const pairCount = Math.min(dels.length, inss.length)
        for (let i = 0; i < pairCount; i++) {
          // 空块配对退化:空段落与有内容块配对时不显示为「修改」
          if (isEmptyBlock(oldBlocks[dels[i]].node)) {
            ops.push({ kind: 'insert', newIndex: inss[i] })
          }
          else if (isEmptyBlock(newBlocks[inss[i]].node)) {
            ops.push({ kind: 'delete', oldIndex: dels[i] })
          }
          else {
            ops.push({ kind: 'pair', oldIndex: dels[i], newIndex: inss[i] })
          }
        }
        for (let i = pairCount; i < dels.length; i++) ops.push({ kind: 'delete', oldIndex: dels[i] })
        for (let i = pairCount; i < inss.length; i++) ops.push({ kind: 'insert', newIndex: inss[i] })
      }
    }
    else {
      ops.push({ kind: 'insert', newIndex: ni++ })
      k++
    }
  }

  return { ops, oldBlocks, newBlocks }
}

// ========== 语义化渲染辅助(#diff-semantic-render)==========

/**
 * 节点类型的中文标签,用于「节点类型变更」tooltip(如「段落 → 标题 2」)。
 * 标签包含关键 attrs(heading level / code_block language),
 * 这样同类型不同 attrs 的变更(标题 1 → 标题 2)也能区分。
 */
export function nodeTypeLabel(node: PMNode): string {
  switch (node.type.name) {
    case 'paragraph': return '段落'
    case 'heading': return `标题 ${node.attrs.level ?? ''}`.trim()
    case 'blockquote': return '引用'
    case 'alert': return '提示块'
    case 'toc': return '目录'
    case 'bullet_list': return '无序列表'
    case 'ordered_list': return '有序列表'
    case 'list_item': return '列表项'
    case 'code_block': {
      const lang = node.attrs.language as string
      return lang ? `代码块(${lang})` : '代码块'
    }
    case 'hr': return '分割线'
    case 'image': return '图片'
    case 'math_block': return '公式块'
    case 'frontmatter': return 'Frontmatter'
    case 'html_block': return 'HTML 块'
    case 'footnote_definition': return '脚注'
    case 'table': return '表格'
    default: return node.type.name
  }
}

/** 文本节点的 marks 签名(类型 + attrs,排序保证与顺序无关) */
function markSig(node: PMNode): string {
  return node.marks.map(m => m.type.name + JSON.stringify(m.attrs)).sort().join('&')
}

/**
 * 比对两个「文本相同」block 的逐字符 marks 签名,返回新 block 文本坐标下
 * marks 发生变化的区间([from, to),offset 相对 block.text)。
 * 仅格式变更(加粗 / 链接 / 颜色)的可视化用:文本相同所以两边签名数组等长,
 * 直接按字符对齐比较,连续差异合并为一个区间。
 * 调用方负责保证 oldNode.textContent === newNode.textContent。
 */
export function diffInlineMarkRanges(
  oldNode: PMNode,
  newNode: PMNode,
): Array<{ from: number; to: number }> {
  const charSigs = (node: PMNode): string[] => {
    const sigs: string[] = []
    node.descendants((child) => {
      if (child.isText && child.text) {
        const sig = markSig(child)
        for (let i = 0; i < child.text.length; i++) sigs.push(sig)
      }
      return true
    })
    return sigs
  }
  const oldSigs = charSigs(oldNode)
  const newSigs = charSigs(newNode)
  if (oldSigs.length !== newSigs.length) return []

  const ranges: Array<{ from: number; to: number }> = []
  let start = -1
  for (let i = 0; i <= newSigs.length; i++) {
    const differ = i < newSigs.length && oldSigs[i] !== newSigs[i]
    if (differ && start < 0) start = i
    else if (!differ && start >= 0) {
      ranges.push({ from: start, to: i })
      start = -1
    }
  }
  return ranges
}
