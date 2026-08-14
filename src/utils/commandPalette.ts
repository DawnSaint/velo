import { fuzzyScore } from '@/utils/fuzzy'

type CommandPaletteGroup = 'app' | 'workspace' | 'recent'
export type CommandPaletteIcon =
  | 'new-doc'
  | 'new-window'
  | 'open-file'
  | 'open-folder'
  | 'save'
  | 'save-as'
  | 'export'
  | 'find'
  | 'replace'
  | 'source'
  | 'file-actions'
  | 'settings'
  | 'quick-open'
  | 'workspace-search'
  | 'workspace-files'
  | 'outline'
  | 'workspace-close'
  | 'workspace-switch'
  | 'recent-file'
  | 'version-history'
  | 'fullscreen'
  | 'pin'
  | 'focus-mode'
  | 'typewriter-mode'
  | 'format-cjk'
  | 'read-mode'
  | 'theme'

export interface CommandPaletteItem {
  id: string
  title: string
  subtitle?: string
  shortcut?: string
  group: CommandPaletteGroup
  icon?: CommandPaletteIcon
  keywords?: string[]
  disabled?: boolean
  disabledReason?: string
  hidden?: boolean
  run: () => void | Promise<unknown>
}

export interface HighlightSegment {
  text: string
  match: boolean
}

export interface CommandPaletteRow {
  item: CommandPaletteItem
  titleSegments: HighlightSegment[]
}

export interface CommandPaletteSection {
  key: CommandPaletteGroup
  rows: CommandPaletteRow[]
}

const GROUP_ORDER: CommandPaletteGroup[] = ['app', 'workspace', 'recent']

export function buildCommandPaletteSegments(text: string, indices: number[] | undefined): HighlightSegment[] {
  if (!indices || indices.length === 0) return [{ text, match: false }]
  const set = new Set(indices)
  const out: HighlightSegment[] = []
  let buf = ''
  let bufMatch = false
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i)
    if (buf.length === 0) { buf = text[i]; bufMatch = m }
    else if (m === bufMatch) buf += text[i]
    else { out.push({ text: buf, match: bufMatch }); buf = text[i]; bufMatch = m }
  }
  if (buf) out.push({ text: buf, match: bufMatch })
  return out
}

interface ScoredItem {
  item: CommandPaletteItem
  score: number
  titleIndices?: number[]
  sourceIndex: number
}

function searchableFields(item: CommandPaletteItem): string[] {
  return [
    item.title,
    item.subtitle ?? '',
    item.shortcut ?? '',
    ...(item.keywords ?? []),
  ].filter(Boolean)
}

function scoreItem(item: CommandPaletteItem, query: string, sourceIndex: number): ScoredItem | null {
  let best: { score: number, titleIndices?: number[] } | null = null
  const titleHit = fuzzyScore(item.title, query)
  if (titleHit) best = { score: titleHit.score + 3, titleIndices: titleHit.indices }

  for (const field of searchableFields(item)) {
    if (field === item.title) continue
    const hit = fuzzyScore(field, query)
    if (!hit) continue
    if (!best || hit.score > best.score) best = { score: hit.score }
  }

  return best ? { item, score: best.score, titleIndices: best.titleIndices, sourceIndex } : null
}

export function buildCommandPaletteSections(items: readonly CommandPaletteItem[], query: string): CommandPaletteSection[] {
  const byGroup = new Map<CommandPaletteGroup, CommandPaletteRow[]>()

  if (!query) {
    items.forEach((item) => {
      if (item.group === 'recent' || item.hidden) return
      const rows = byGroup.get(item.group) ?? []
      rows.push({ item, titleSegments: buildCommandPaletteSegments(item.title, undefined) })
      byGroup.set(item.group, rows)
    })
  }
  else {
    const scored: ScoredItem[] = []
    items.forEach((item, index) => {
      if (item.group === 'recent' || item.hidden) return
      const hit = scoreItem(item, query, index)
      if (hit) scored.push(hit)
    })
    scored.sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex)
    for (const hit of scored) {
      const rows = byGroup.get(hit.item.group) ?? []
      rows.push({ item: hit.item, titleSegments: buildCommandPaletteSegments(hit.item.title, hit.titleIndices) })
      byGroup.set(hit.item.group, rows)
    }
  }

  return GROUP_ORDER.map(key => ({ key, rows: byGroup.get(key) ?? [] }))
    .filter(section => section.rows.length > 0)
}
