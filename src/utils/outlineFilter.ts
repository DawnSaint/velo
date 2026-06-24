// ========== 大纲搜索过滤(v0.5.2) ==========
//
// 设计取舍:
//   - 不引第三方 fuzzy 库 —— 大纲体量小(<2000 标题已是极限文档),
//     自己写的子序列匹配足够;ROADMAP §v0.5.2 §查找文件 走的是同款
//     fzf 风格子序列 + 评分,后续 Ctrl+P 可复用 `fuzzyMatch` 评分。
//   - 拆 `fuzzyMatch` / `fuzzyMatchIndices` / `filterHeadings` 三层:
//     fuzzyMatch 判 boolean,fuzzyMatchIndices 同时给命中字符在
//     text 中的索引(用于条目内联高亮),filterHeadings 在树上跑一遍
//     DFS 收集命中 key + 各 key 的命中索引,返回给调用方。
//   - 不在 filter 里读折叠态 —— 本函数不知道也不该知道哪些 heading
//     被折叠,职责单一。EditorOutline 拿到 matchIndices 自行渲染。

import type { HeadingItem } from './outline'

/**
 * 子序列模糊匹配:`query` 的字符必须按顺序出现在 `text` 中,大小写不敏感。
 *
 * 模仿 fzf 的子序列匹配语义,但只返回 boolean —— 大纲体量小,
 * 用不上评分;若 v0.5.2 §查找文件 需要评分,可以拓展成返回 { hit, score }。
 *
 * 已知折中:不做大小写折叠以外的规范化(不去重音 / 不展开连字 / 不处理
 * 零宽字符)。Markdown 标题里这些场景出现频率极低,留后续若用户报
 * "搜 é 找不到 e" 再补。
 *
 * 空 query 在调用方应短路掉本函数,这里仍返回 true 是为了"空视为匹配全部"
 * 的便利默认。
 */
export function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  let qi = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++
  }
  return qi === q.length
}

/**
 * 同 fuzzyMatch,顺便返回 `query` 各字符在 `text` 中命中的位置索引。
 *
 * 返回值:
 *   - 空 query → `[]`(空数组,代表"全部命中",与 fuzzyMatch 行为对齐)
 *   - 不命中   → `null`(调用方需区分"没匹配上"与"空查询")
 *   - 命中     → `[i0, i1, ...]`,对应 text 中按顺序被吃掉的字符下标
 *
 * 索引数组按 query 顺序排列,长度 === query.length;**不**包含 text 中
 * 其他被吃掉的字符(子序列只挑 query 用到的那些,跳过的字符不算高亮)。
 *
 * EditorOutline 拿这个数组在 displayText 上切段,把命中的字符包成
 * 主题色 span,未命中的保持原文本 —— 即"仅展示命中条目"配合"条目内
 * 联高亮"的视觉方案。
 */
export function fuzzyMatchIndices(text: string, query: string): number[] | null {
  if (!query) return []
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  const indices: number[] = []
  let qi = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      indices.push(i)
      qi++
    }
  }
  return qi === q.length ? indices : null
}

export interface FilterResult {
  /** 命中 query 的 heading key 集合 */
  matchKeys: Set<string>
  /** 每个命中 key → displayText 内被命中的字符索引,供调用方做内联高亮 */
  matchIndices: Map<string, number[]>
}

/**
 * 在标题树上跑 fuzzy 过滤,返回命中集合 + 每个命中 key 的字符索引。
 *
 * 算法:DFS;节点自身命中 → 加入 matchKeys 与 matchIndices,**不**继续
 * 维护祖先链(用户 v0.5.2 迭代决定不展示祖先链,filter 模式下视图
 * 退化为"扁平命中列表",祖先信息无意义)。子节点继续 walk —— filter
 * 模式下需要递归走完子树才能捕获深层命中(祖先不展示但子可能命中)。
 *
 * 调用方拿到两组集合后,自行决定如何渲染。本函数不读折叠态。
 *
 * 空 query 返回空集合 —— 调用方应已短路,但这里再次防御。
 */
export function filterHeadings(tree: HeadingItem[], query: string): FilterResult {
  const matchKeys = new Set<string>()
  const matchIndices = new Map<string, number[]>()
  const trimmed = query.trim()

  if (!trimmed) return { matchKeys, matchIndices }

  function walk(items: HeadingItem[]) {
    for (const item of items) {
      const indices = fuzzyMatchIndices(item.displayText, trimmed)
      if (indices) {
        matchKeys.add(item.key)
        matchIndices.set(item.key, indices)
      }
      walk(item.children)
    }
  }
  walk(tree)
  return { matchKeys, matchIndices }
}