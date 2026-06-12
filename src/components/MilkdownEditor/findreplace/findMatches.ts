// ProseMirror 文档内文本搜索的纯函数。
//
// 不依赖 Editor / Milkdown / Vue,只接 ProseMirror Node + query + options,
// 输出 Match[] (doc 坐标系下的 from/to)。可独立测试,也可在组件外用。
//
// 跨文本节点:每个 text node 各自 exec regex,匹配位置按 node pos 平移回 doc 坐标。
// 零宽匹配(整个 regex 是 anchor)会推进 lastIndex,避免死循环。

import type { Node } from '@milkdown/prose/model'

export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export interface Match {
  /** match 起点 (doc position) */
  from: number
  /** match 终点 (doc position, exclusive) */
  to: number
}

/** 转义正则元字符。普通(非 regex)模式下包裹用户输入。 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 构造搜索用的全局正则。
 *  - 空 query → null (没东西可搜)
 *  - 编译失败 (invalid regex) → null
 *  - wholeWord:在 pattern 外层加 \b 边界
 *  - caseSensitive 控制 i flag
 */
export function buildPattern(query: string, options: FindOptions): RegExp | null {
  if (!query) return null
  try {
    const body = options.regex ? query : escapeRegex(query)
    // wholeWord 模式:外层 \b 边界。
    // 内部 pattern 已经是 (?:...) 形式(用户自己写的)或纯字符(非 regex 模式);
    // 直接在外面再裹 (?:...) 会破坏 regex 模式下的优先级,所以 regex 模式
    // 假定用户已经写好 group,这里只补边界。
    const pat = options.wholeWord ? `\\b(?:${body})\\b` : body
    return new RegExp(pat, options.caseSensitive ? 'g' : 'gi')
  }
  catch {
    return null
  }
}

/**
 * 在 ProseMirror doc 中找出所有 match 的位置。
 * 返回的 from/to 是 doc 坐标 —— 可直接喂给 TextSelection.create / tr.replaceWith。
 */
export function findMatchesInDoc(doc: Node, query: string, options: FindOptions): Match[] {
  const pat = buildPattern(query, options)
  if (!pat) return []
  const result: Match[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const text = node.text
    pat.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pat.exec(text)) !== null) {
      if (m[0].length === 0) {
        // 零宽匹配 → 必须手动推进,否则 lastIndex 不动 → 死循环
        pat.lastIndex++
        continue
      }
      result.push({
        from: pos + m.index,
        to: pos + m.index + m[0].length,
      })
    }
  })
  return result
}

/**
 * 在单段 text 上做"匹配 → 替换"。支持 regex 模式下的 $1, $2 反向引用
 * (用 String.prototype.replace,只有全局 regex 才会做全部替换)。
 * 仅用于 "replace all" 时的 per-text-node 重写,单条替换走 tr.replaceWith + 同样的 buildPattern。
 */
export function replaceInText(
  text: string,
  query: string,
  options: FindOptions,
  replacement: string,
): string {
  const pat = buildPattern(query, options)
  if (!pat) return text
  return text.replace(pat, replacement)
}