export interface CursorPosition {
  line: number
  column: number
}

export const DEFAULT_CURSOR_POSITION: CursorPosition = { line: 1, column: 1 }

export function cursorFromTextBefore(textBeforeCursor: string): CursorPosition {
  if (!textBeforeCursor) return DEFAULT_CURSOR_POSITION
  const normalized = textBeforeCursor.replace(/\r\n?/g, '\n')
  const lastLineStart = normalized.lastIndexOf('\n') + 1
  return {
    line: normalized.split('\n').length,
    column: Array.from(normalized.slice(lastLineStart)).length + 1,
  }
}
