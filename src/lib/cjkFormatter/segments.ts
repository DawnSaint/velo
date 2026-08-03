/**
 * 可格式化段提取与重建
 *
 * 将 markdown 文本按保护区拆分为「可格式化段」和「保护区」，
 * 格式化后按原始位置重新拼接。保护区内容原样保留。
 *
 * 不变量：protectedRegions 必须已排序且无重叠（findProtectedRegions 保证）。
 */

import type { ProtectedRegion } from './markdownParser'

export interface TextSegment {
  start: number
  end: number
  text: string
}

/** 提取可格式化段（保护区之间的文本）。 */
export function extractFormattableSegments(
  text: string,
  protectedRegions: ProtectedRegion[],
): TextSegment[] {
  const segments: TextSegment[] = []
  let currentPos = 0

  for (const region of protectedRegions) {
    if (region.start > currentPos) {
      segments.push({
        start: currentPos,
        end: region.start,
        text: text.slice(currentPos, region.start),
      })
    }
    currentPos = region.end
  }

  if (currentPos < text.length) {
    segments.push({
      start: currentPos,
      end: text.length,
      text: text.slice(currentPos),
    })
  }

  return segments
}

/** 格式化后重建完整文本：保护区原样 + 格式化段按位置排序拼接。 */
export function reconstructText(
  originalText: string,
  formattedSegments: TextSegment[],
  protectedRegions: ProtectedRegion[],
): string {
  const parts: { start: number; text: string }[] = []

  for (const region of protectedRegions) {
    parts.push({
      start: region.start,
      text: originalText.slice(region.start, region.end),
    })
  }

  for (const segment of formattedSegments) {
    parts.push({
      start: segment.start,
      text: segment.text,
    })
  }

  parts.sort((a, b) => a.start - b.start)
  return parts.map((p) => p.text).join('')
}
