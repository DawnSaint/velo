// 语法实时转换框架 —— 单一 appendTransaction 入口,把所有"输入 → 语法节点"
// 的转换收口。
//
// 与原 InputRule / linkAutoFormatPlugin 各自一份扫描循环 + 黑名单的形态相比,
// 这里只在每次 docChanged 后跑一次,**只扫被波及的 textblock**(dirty range
// 局部扫描),而不是整篇 doc。
//
// 行为契约:
// - 每个 dirty textblock 先尝试 block syntaxes(段首匹配);命中其一 → 跳过 inline
// - 没有 block 命中 → 跑全部 inline syntaxes,正则带 `g`,逐 match 反向调 apply
// - inline 只扫 isText && !marks.has(code) 的字符;atom 节点(image / footnote_ref /
//   math_inline / html_inline)天然跳过
// - 黑名单容器(code_block / html_block / mermaid / math_block)整段 return false
//   不下钻,字面量 `### ` 不会被当 heading
// - 与 linkClickPlugin.session 重叠的范围跳过,不跟用户的源码编辑抢
//
// 性能:appendTransaction 返回的 tr 不会再触发自己(ProseMirror 文档保证),
// 死循环只在单次 apply 内 —— pattern 必须不会匹配 apply 输出的内容(例如
// inline emphasis 替换为带 mark 的 text 后,正则在 atom / mark 之外仍能跑,
// 这点由 schema 决定:被替换的 text 保留为 atom 节点的话不会再被扫到)。

import { Plugin } from 'prosemirror-state'
import type { Transaction, EditorState } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import {
  getBlockSyntaxes,
  getInlineSyntaxes,
  type BlockSyntax,
  type InlineSyntax,
} from '../editor/syntaxRegistry'
import { linkClickPluginKey } from './linkClick'

// 容器型黑名单:整个节点跳过(包括子节点)
const CONTAINER_BLACKLIST = new Set([
  'code_block',
  'html_block',
  // mermaid v0.4.6+ 走 code_block { language: 'mermaid' },自动被 code_block 分支拦截
  'math_block',
  // math_inline / html_inline / footnote_reference / image 都是 atom,
  // 没有 text 子节点,inline detector 自然跳过,不需要单独列
])

interface DirtyRange {
  from: number
  to: number
}

/**
 * 从一组 transaction 抽出所有"被改动过"的 doc 范围(已 map 到最终 doc)。
 *
 * tr.mapping.maps 里每个 StepMap 都能反向问"这段在改完后落在哪",我们对每个
 * StepMap 调 forEach 拿原始范围,再用后续 mapping 把它推到最终 doc 上。
 */
function collectDirtyRanges(transactions: readonly Transaction[]): DirtyRange[] {
  const ranges: DirtyRange[] = []
  for (const tr of transactions) {
    if (!tr.docChanged) continue
    tr.mapping.maps.forEach((stepMap, i) => {
      stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        // 用从 i+1 起的 mapping 把 newStart/newEnd 推到 transactions 链最终位置
        let from = newStart
        let to = newEnd
        for (let j = i + 1; j < tr.mapping.maps.length; j++) {
          from = tr.mapping.maps[j].map(from, -1)
          to = tr.mapping.maps[j].map(to, 1)
        }
        ranges.push({ from, to })
      })
    })
  }
  return ranges
}

interface DirtyTextblock {
  /** textblock 节点本身。 */
  node: PMNode
  /** 段落内容起点(open tag 之后)。 */
  start: number
  /** 段落内容终点(close tag 之前)。 */
  end: number
}

/**
 * 把 dirty range 扩展到包含它们的 textblock,去重 + 跳过黑名单容器。
 *
 * 一段 dirty 可能跨多个 textblock(粘贴整段 markdown);这里对范围内每个
 * textblock 各产出一条 DirtyTextblock。
 */
function rangesToTextblocks(ranges: DirtyRange[], state: EditorState): DirtyTextblock[] {
  if (ranges.length === 0) return []
  const seen = new Set<number>() // textblock start 去重
  const out: DirtyTextblock[] = []
  const docSize = state.doc.content.size

  // 在祖先链上检测黑名单容器:dirty range 哪怕落在 code_block 内部,也不该转
  function isInsideBlacklist(pos: number): boolean {
    if (pos < 0 || pos > docSize) return true
    const $pos = state.doc.resolve(Math.min(pos, docSize))
    for (let d = $pos.depth; d > 0; d--) {
      if (CONTAINER_BLACKLIST.has($pos.node(d).type.name)) return true
    }
    return false
  }

  for (const { from, to } of ranges) {
    const clampedFrom = Math.max(0, Math.min(from, docSize))
    const clampedTo = Math.max(clampedFrom, Math.min(to, docSize))
    state.doc.nodesBetween(clampedFrom, clampedTo, (node, pos) => {
      if (CONTAINER_BLACKLIST.has(node.type.name)) return false
      if (!node.isTextblock) return true
      // 跳过黑名单 textblock(目前 schema 里没有 textblock 在黑名单,留个兜底)
      if (CONTAINER_BLACKLIST.has(node.type.name)) return false
      const blockStart = pos + 1 // open tag 之后
      if (seen.has(blockStart)) return false
      // 黑名单祖先(table_cell 内的 paragraph 仍允许;只挡 code/html/math/mermaid)
      if (isInsideBlacklist(blockStart)) return false
      seen.add(blockStart)
      out.push({ node, start: blockStart, end: blockStart + node.content.size })
      return false // textblock 内不再下钻
    })
  }
  return out
}

/**
 * 当前 link 编辑态 session 的范围 —— 与之相交的 textblock 不被框架抢着转,
 * 用户改源码时框架退避。
 */
function getLinkEditRange(state: EditorState): { from: number, to: number } | null {
  const session = linkClickPluginKey.getState(state)?.session ?? null
  if (!session) return null
  return { from: session.editFrom, to: session.editTo }
}

function rangesIntersect(a: { from: number, to: number }, b: { from: number, to: number }): boolean {
  return a.from < b.to && b.from < a.to
}

// ============================================================
//  Block detector
// ============================================================

/**
 * 在段首尝试所有 block syntaxes,命中第一个就退出。
 * 注意:tr 在前面的 inline / block 转换中可能已经累加了 step,所以 blockStart
 * 必须从 newState.doc(tr.doc 之前)对应的位置经过 tr.mapping 推到当前 tr.doc。
 */
function tryBlockSyntaxes(
  tr: Transaction,
  block: DirtyTextblock,
  syntaxes: readonly BlockSyntax[],
): boolean {
  const mappedStart = tr.mapping.map(block.start)
  const mappedEnd = tr.mapping.map(block.end)
  if (mappedStart >= mappedEnd) return false
  // 取段落 textContent(纯文本视图,跳过 atom 节点)用于段首正则匹配
  const text = tr.doc.textBetween(mappedStart, mappedEnd, '\n', '\n')
  for (const syntax of syntaxes) {
    syntax.pattern.lastIndex = 0
    const match = syntax.pattern.exec(text)
    if (!match || match.index !== 0) continue
    const before = tr.steps.length
    const ok = syntax.apply(tr, {
      schema: tr.doc.type.schema,
      blockStart: mappedStart,
      blockEnd: mappedEnd,
      match,
    })
    if (ok && tr.steps.length > before) return true
  }
  return false
}

// ============================================================
//  Inline detector
// ============================================================

/**
 * 对 textblock 内的连续 text 段(忽略 atom)分别跑所有 inline syntaxes 的 g 正则。
 *
 * 实现注意:
 * - tr 在前面已经累加 step,要先 tr.mapping.map block 边界
 * - **必须迭代到 doc 不再变化为止**:一次 apply 后 doc.textBetween 变了,
 *   仍可能有未抓的 match(粘贴整段含两个独立 [text](url),先转第一个;
 *   不过因为正则带 g、循环里手动 advance,单次扫描就能覆盖,这里**不**做
 *   外层 while 循环——避免不收敛的死循环)
 */
function tryInlineSyntaxes(
  tr: Transaction,
  block: DirtyTextblock,
  syntaxes: readonly InlineSyntax[],
  linkEditRange: { from: number, to: number } | null,
): boolean {
  let touched = false
  const schema = tr.doc.type.schema
  const codeMarkType = schema.marks.code

  for (const syntax of syntaxes) {
    if (!syntax.pattern.global) continue // 防御:inline 必须带 g

    const mappedStart = tr.mapping.map(block.start)
    const mappedEnd = tr.mapping.map(block.end)
    if (mappedStart >= mappedEnd) continue
    const blockText = tr.doc.textBetween(mappedStart, mappedEnd, ' ', ' ')
    // ↑ 用   占位 atom / hard break,保证 textContent 与字符位置 1:1 对应
    //   这样 match.index + mappedStart 就是 doc 上的 from 位置

    syntax.pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = syntax.pattern.exec(blockText)) !== null) {
      const matchFrom = mappedStart + match.index
      const matchTo = matchFrom + match[0].length
      // 防御:正则零宽匹配会陷入死循环,强制 lastIndex++
      if (match[0].length === 0) {
        syntax.pattern.lastIndex++
        continue
      }

      // 黑名单字符过滤:范围内含 atom( )或 code mark 文本 → 跳过
      let skip = false
      if (blockText.slice(match.index, match.index + match[0].length).includes(' ')) {
        skip = true
      }
      if (!skip && codeMarkType) {
        // 检查 from..to 范围内是否有 text 节点带 code mark
        tr.doc.nodesBetween(matchFrom, matchTo, (n) => {
          if (skip) return false
          if (n.isText && n.marks.some(m => m.type === codeMarkType)) skip = true
          return !skip
        })
      }
      if (skip) continue

      // 与 link 编辑态 session 重叠 → 跳过
      if (linkEditRange && rangesIntersect({ from: matchFrom, to: matchTo }, linkEditRange)) {
        continue
      }

      const before = tr.steps.length
      const ok = syntax.apply(tr, {
        schema,
        from: tr.mapping.map(matchFrom),
        to: tr.mapping.map(matchTo),
        match,
      })
      if (ok && tr.steps.length > before) {
        touched = true
        // 一次 apply 后 doc 变了,tr.mapping / blockText 都需要重算,
        // 当前段落剩余内容下一轮 inline syntax 再扫
        break
      }
    }
  }
  return touched
}

// ============================================================
//  主 Plugin
// ============================================================

export const syntaxAutoFormatPlugin = new Plugin({
  appendTransaction(transactions, _oldState, newState) {
    if (!transactions.some(t => t.docChanged)) return null

    const dirtyRanges = collectDirtyRanges(transactions)
    if (dirtyRanges.length === 0) return null

    // 用户自己 dispatch 的 tr 上若挂了 setMeta(syntaxAutoFormatPlugin, false),
    // 整体跳过 —— 给 markdownIO 初始装载 / 远端同步等场景留逃生口
    for (const tr of transactions) {
      if (tr.getMeta(syntaxAutoFormatPlugin) === false) return null
    }

    const blocks = rangesToTextblocks(dirtyRanges, newState)
    if (blocks.length === 0) return null

    const blockSyntaxes = getBlockSyntaxes()
    const inlineSyntaxes = getInlineSyntaxes()
    if (blockSyntaxes.length === 0 && inlineSyntaxes.length === 0) return null

    const linkEditRange = getLinkEditRange(newState)
    let tr = newState.tr
    let touched = false

    for (const block of blocks) {
      // block 命中后通常段落类型整个换,inline 不再尝试当前 block
      if (tryBlockSyntaxes(tr, block, blockSyntaxes)) {
        touched = true
        continue
      }
      if (tryInlineSyntaxes(tr, block, inlineSyntaxes, linkEditRange)) {
        touched = true
      }
    }

    if (!touched) return null
    // 标记自己产生的 tr,虽然 ProseMirror 不会回灌到 appendTransaction,
    // 但其他 plugin 想区分时可以读这个 meta
    tr.setMeta(syntaxAutoFormatPlugin, true)
    return tr
  },
})

// 暴露 helper:外部 dispatch 想"这一笔不要走自动格式化"时挂 meta
export const SYNTAX_AUTO_FORMAT_SKIP_META = syntaxAutoFormatPlugin
