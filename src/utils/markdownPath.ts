export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdown'] as const

export const MARKDOWN_DIALOG_FILTERS = [
  { name: 'Markdown', extensions: [...MARKDOWN_EXTENSIONS] },
]

export const MARKDOWN_EXT_RE = /\.(md|markdown|mdown)$/i

export function isMarkdownPath(pathOrName: string): boolean {
  return MARKDOWN_EXT_RE.test(pathOrName)
}
