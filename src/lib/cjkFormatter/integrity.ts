/**
 * 格式化后完整性校验
 *
 * 在格式化前后计数结构化 markdown 模式（[^, <!--, ```, ~~~, $$, [[, `），
 * 若任一计数变化则说明格式化破坏了结构，调用方应回滚到原文。
 * 这是防御性安全网——段式架构应已防止所有破坏，此检查捕获解析器自身的 bug。
 */

export interface IntegrityResult {
  ok: boolean
  details: Record<string, { before: number; after: number }>
}

const STRUCTURAL_PATTERNS = [
  '[^',
  '<!--',
  '```',
  '~~~',
  '$$',
  '[[',
  '`',
] as const

function countOccurrences(text: string, pattern: string): number {
  let count = 0
  let pos = 0
  while (pos < text.length) {
    const idx = text.indexOf(pattern, pos)
    if (idx === -1) break
    count++
    pos = idx + pattern.length
  }
  return count
}

/** 验证格式化未丢失或新增结构化模式。 */
export function verifyIntegrity(before: string, after: string): IntegrityResult {
  const details: Record<string, { before: number; after: number }> = {}
  let ok = true

  for (const pattern of STRUCTURAL_PATTERNS) {
    const beforeCount = countOccurrences(before, pattern)
    const afterCount = countOccurrences(after, pattern)

    if (beforeCount !== afterCount) {
      ok = false
      details[pattern] = { before: beforeCount, after: afterCount }
    }
  }

  return { ok, details }
}
