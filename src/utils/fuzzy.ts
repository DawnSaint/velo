// 通用 fzf 风格 fuzzy 评分(v0.5.2,Ctrl+P 查找文件用):
//
// 与 `outlineFilter.ts:fuzzyMatchIndices` 的子序列匹配 + 大小写不敏感同构,
// 但多返回评分(便于 Ctrl+P 面板按相关性排序)。两套工具分文件落:
//   - outlineFilter:大纲过滤 / 高亮,只要 boolean / indices,**无**评分需求
//   - fuzzy        :Ctrl+P 评分,排序选 top 几项
// 后者扩成评分版后没去复用前者,是为了让两边各自演化(大纲后续可能加正则 /
// 词边界开关,Ctrl+P 后续可能调评分权重),职责单一更容易演进。
//
// 评分模型(简化版 fzf):
//   - 命中字符的"连续段"长度平方累加(连续命中权重最高,fzf 同款思路)
//   - 词首字符 bonus:命中位置 i 满足 i===0 / 前字符是 `/ \ _ - . ` 空格 → +6 分
//   - 起始位置惩罚:首字符命中越靠后,基础分按 i 线性扣(避免长字符串靠后命中
//     干扰短字符串靠前命中)
// 权重数字写在 SEGMENT_WEIGHT / WORD_BOUNDARY_BONUS / START_PENALTY,
// 之后调参改这三个常量就够,无需动算法骨架。

/** 一个命中"段"末尾长度平方贡献的乘数;乘 1 = 纯长度平方。 */
const SEGMENT_WEIGHT = 1

/** 词首字符 bonus:每个落在 word boundary 上的命中 +6 分。 */
const WORD_BOUNDARY_BONUS = 6

/** 起始位置惩罚:首字符命中位置 i 扣 i*0.5 分(防止靠后命中盖过靠前)。 */
const START_PENALTY = 0.5

/** 视为"词首边界"的前置字符。下划线 / 连字符 / 点号 / 路径分隔符 / 空格。 */
const WORD_BOUNDARY_CHARS = new Set(['/', '\\', '_', '-', '.', ' '])

export interface FuzzyHit {
  /** 越高越相关 */
  score: number
  /** query 各字符在 text 中命中下标(按 query 顺序,长度 === query.length). */
  indices: number[]
}

/**
 * 在 text 中按子序列匹配 query 并打分。
 *
 * 行为约定:
 *   - 空 query → `{ score: 0, indices: [] }`(调用方应排序时把空 query 走"按
 *     字典序排"的分支,而不是依赖 score 排序)
 *   - 未命中 → null
 *   - 命中   → score >= 0(理论上某些 START_PENALTY 偏大场景可负,实测正常 ≥0)
 *
 * 大小写不敏感:两侧 toLowerCase 后比对,indices 返回原 text 索引。
 */
export function fuzzyScore(text: string, query: string): FuzzyHit | null {
  if (!query) return { score: 0, indices: [] }
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  const indices: number[] = []
  let qi = 0
  let score = 0
  let segLen = 0
  let firstIdx = -1

  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      indices.push(i)
      if (firstIdx === -1) firstIdx = i
      // 连续段:与上一个命中相邻 → 累计长度
      if (indices.length >= 2 && indices[indices.length - 2] === i - 1) {
        segLen += 1
      }
      else {
        // 上一段结束 → 把 segLen^2 计入,开新段(长度从 1 起算)
        score += segLen * segLen * SEGMENT_WEIGHT
        segLen = 1
      }
      // 词首边界 bonus:位置 0 或前字符落在分隔符集合
      if (i === 0 || WORD_BOUNDARY_CHARS.has(text[i - 1])) {
        score += WORD_BOUNDARY_BONUS
      }
      qi += 1
    }
  }
  if (qi !== q.length) return null
  // 收尾最后一段
  score += segLen * segLen * SEGMENT_WEIGHT
  // 起始位置惩罚:首字符命中越靠后,分越低
  if (firstIdx > 0) score -= firstIdx * START_PENALTY
  return { score, indices }
}
