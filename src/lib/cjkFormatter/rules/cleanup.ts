/**
 * Group 5 — 清理规则（连续标点限制、行尾空格）。
 */

/** 限制连续标点（！？。）数量。 */
export function limitConsecutivePunctuation(
  text: string,
  limit: number,
): string {
  if (limit <= 0) return text

  const marks = ['！', '？', '。']
  for (const mark of marks) {
    const escaped = mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(
      new RegExp(`${escaped}{${limit + 1},}`, 'g'),
      mark.repeat(limit),
    )
  }
  return text
}

/** 移除行尾空格。可选保留两空格硬换行。 */
export function removeTrailingSpaces(
  text: string,
  options: { preserveTwoSpaceHardBreaks?: boolean } = {},
): string {
  if (!options.preserveTwoSpaceHardBreaks) {
    return text.replace(/ +$/gm, '')
  }

  const lines = text.split('\n')
  const processed = lines.map((line) => {
    let lineEnding = ''
    let content = line

    if (content.endsWith('\r')) {
      lineEnding = '\r'
      content = content.slice(0, -1)
    }

    const trailingMatch = content.match(/ +$/)
    if (!trailingMatch) return content + lineEnding

    const trailingSpaces = trailingMatch[0]
    const before = content.slice(0, -trailingSpaces.length)

    if (trailingSpaces.length >= 2 && before.trim().length > 0) {
      return content + lineEnding
    }

    return before + lineEnding
  })

  return processed.join('\n')
}
