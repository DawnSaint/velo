// `:short` 输入态 emoji 自动补全下拉。
//
// 用户在 paragraph 中键入 `:` + 字母时，在光标下方浮出模糊匹配下拉，
// 列出 node-emoji 表中匹配的 shortcode + Unicode 字符。上下键导航 +
// Enter 提交（替换 `:query` 文本为 emoji 节点）+ Escape 关闭 + 点击选择。
//
// 与 codeBlockLangSuggest 同范式：
// - 状态检测从 EditorState 推导，纯视觉叠层，不改变文档结构
// - handleKeyDown 拦截 ArrowUp/Down/Enter/Escape，其他键放行
// - commit 时 delete `:query` 文本 + insert emoji node
//
// 与 emoji syntax（syntax/inline/emoji.ts）的关系：
// - syntax plugin 在用户输入完整 `:smile:`（含尾部 `:`）时触发转换
// - suggest plugin 在用户输入 `:smi`（无尾部 `:`）时弹下拉
// - 两者不冲突：suggest 的检测正则 `/(?<!\w):([\w+-]+)$/` 只匹配
//   「光标前文本末尾的不完整短码」，完整短码 `:smile:` 的末尾是 `:`
//   不匹配 `\w`，正则自然不命中
//
// 设计取舍：
// - 不在 code_block / code mark / 源码编辑 session 内激活
// - 下拉项最多 30 条，避免 DOM 节点过多影响性能
// - 使用 node-emoji 的 search() 做模糊匹配

import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { search as emojiSearch } from 'node-emoji'
import { markSourceEditKey } from './markSourceEdit'
import { htmlSourceEditKey } from './htmlSourceEdit'
import { emojiSourceEditKey } from './emojiSourceEdit'

const MAX_ITEMS = 30

// 匹配光标前文本末尾的不完整短码：`:` + 字母/数字/下划线/连字符/加号
// `(?<!\w)` 确保 `:` 前不是单词字符（避免 `12:30` 误触发）
const SUGGEST_PATTERN = /(?<!\w):([\w+-]+)$/

export interface EmojiSuggestState {
  active: boolean
  query: string
  /** `:` 在 doc 中的位置 */
  colonPos: number
  /** 光标位置 */
  cursorPos: number
  highlightIndex: number
  dismissed: boolean
}

const IDLE: EmojiSuggestState = {
  active: false,
  query: '',
  colonPos: -1,
  cursorPos: -1,
  highlightIndex: -1,
  dismissed: false,
}

export const emojiSuggestKey = new PluginKey<EmojiSuggestState>('emojiSuggest')

// ============================================================
//  过滤 + 渲染
// ============================================================

interface EmojiCandidate {
  name: string
  emoji: string
}

function getFiltered(query: string): EmojiCandidate[] {
  const q = query.toLowerCase().trim()
  if (!q) {
    // 无 query 时返回热门/常见 emoji（取 search('') 的前 MAX_ITEMS）
    return emojiSearch('').slice(0, MAX_ITEMS)
  }
  return emojiSearch(q).slice(0, MAX_ITEMS)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function highlightMatch(text: string, query: string): string {
  const q = query.toLowerCase().trim()
  if (!q) return escapeHtml(text)
  const idx = text.toLowerCase().indexOf(q)
  if (idx < 0) return escapeHtml(text)
  return (
    escapeHtml(text.slice(0, idx)) +
    `<b class="velo-emoji-match">${escapeHtml(text.slice(idx, idx + q.length))}</b>` +
    escapeHtml(text.slice(idx + q.length))
  )
}

// ============================================================
//  状态检测：从 EditorState 推导当前是否处于 `:query` 输入态
// ============================================================

function detectSuggest(state: EditorState): EmojiSuggestState {
  const { selection } = state
  if (!selection.empty) return IDLE

  const { $from } = selection

  // 只在 paragraph 内激活（与 codeBlockLangSuggest 同款限制）
  if ($from.parent.type.name !== 'paragraph') return IDLE
  // 光标必须在段落末尾
  if ($from.parentOffset !== $from.parent.content.size) return IDLE

  // code mark 内不激活
  const marks = $from.marks()
  if (marks.some((m) => m.type.name === 'code')) return IDLE

  // 源码编辑 session 活跃时不激活
  const markSession = markSourceEditKey.getState(state)
  if (markSession?.session) return IDLE
  const htmlSession = htmlSourceEditKey.getState(state) as { session?: unknown } | undefined
  if (htmlSession?.session) return IDLE
  const emojiSession = emojiSourceEditKey.getState(state) as { session?: unknown } | undefined
  if (emojiSession?.session) return IDLE

  // 取光标前的文本（从段落起点到光标）
  const paraStart = $from.start()
  const textBefore = state.doc.textBetween(paraStart, $from.pos, '\n', '\n')
  const match = SUGGEST_PATTERN.exec(textBefore)
  if (!match) return IDLE

  const query = match[1]
  // 计算 `:` 在 doc 中的位置
  const colonPos = paraStart + match.index + match[0].length - query.length - 1

  return {
    active: true,
    query,
    colonPos,
    cursorPos: $from.pos,
    highlightIndex: -1,
    dismissed: false,
  }
}

// ============================================================
//  提交：把 `:query` 文本替换为 emoji 节点
// ============================================================

function commitSuggestion(view: EditorView, s: EmojiSuggestState, shortcode: string): void {
  const emojiType = view.state.schema.nodes.emoji
  if (!emojiType) return
  const tr = view.state.tr
  // 删除 `:query` 文本（从 colonPos 到 cursorPos）
  tr.delete(s.colonPos, s.cursorPos)
  // 插入 emoji 节点
  tr.insert(s.colonPos, emojiType.create({ shortcode }))
  view.dispatch(tr)
}

// ============================================================
//  Plugin
// ============================================================

export const emojiSuggestPlugin = new Plugin<EmojiSuggestState>({
  key: emojiSuggestKey,
  state: {
    init: () => IDLE,
    apply(tr, prev, _oldState, newState) {
      // Handle highlight navigation / dismiss meta
      const meta = tr.getMeta(emojiSuggestKey) as
        | { highlightIndex?: number, dismissed?: boolean }
        | undefined
      if (meta) {
        if (meta.highlightIndex !== undefined) {
          return { ...prev, highlightIndex: meta.highlightIndex }
        }
        if (meta.dismissed) {
          return { ...IDLE, dismissed: true }
        }
      }

      // Clear dismissed on doc change (user typed something new)
      const dismissed = tr.docChanged ? false : prev.dismissed

      // Re-detect
      const detected = detectSuggest(newState)
      if (!detected.active || dismissed) {
        return { ...IDLE, dismissed }
      }

      // Preserve highlightIndex if query unchanged and was active
      if (detected.query === prev.query && prev.active) {
        return { ...detected, highlightIndex: prev.highlightIndex, dismissed }
      }
      return { ...detected, dismissed }
    },
  },
  props: {
    handleKeyDown(view, event) {
      const s = emojiSuggestKey.getState(view.state)
      if (!s || !s.active) return false

      const key = event.key

      // ArrowUp/Down: navigate highlight
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault()
        const filtered = getFiltered(s.query)
        if (filtered.length === 0) return true
        let idx = s.highlightIndex
        if (key === 'ArrowDown') {
          idx = idx < filtered.length - 1 ? idx + 1 : 0
        } else {
          idx = idx > 0 ? idx - 1 : filtered.length - 1
        }
        view.dispatch(view.state.tr.setMeta(emojiSuggestKey, { highlightIndex: idx }))
        return true
      }

      // Enter: if highlight selected, intercept and commit with that shortcode.
      // If no highlight, return false → let Enter keymap handle normally
      if (key === 'Enter') {
        if (s.highlightIndex >= 0) {
          event.preventDefault()
          const filtered = getFiltered(s.query)
          if (s.highlightIndex < filtered.length) {
            commitSuggestion(view, s, filtered[s.highlightIndex].name)
            return true
          }
        }
        return false
      }

      // Escape: dismiss dropdown (text stays, dropdown hidden until next doc change)
      if (key === 'Escape') {
        event.preventDefault()
        view.dispatch(view.state.tr.setMeta(emojiSuggestKey, { dismissed: true }))
        return true
      }

      // Tab: if highlight selected, commit (like Enter but also prevent Tab navigation)
      if (key === 'Tab') {
        if (s.highlightIndex >= 0) {
          event.preventDefault()
          const filtered = getFiltered(s.query)
          if (s.highlightIndex < filtered.length) {
            commitSuggestion(view, s, filtered[s.highlightIndex].name)
            return true
          }
        }
        return false
      }

      return false
    },
  },
  view: (view: EditorView) => {
    let dropdown: HTMLDivElement | null = null

    function updateDropdownPosition(): void {
      if (!dropdown) return
      const s = emojiSuggestKey.getState(view.state)
      if (!s || !s.active) return
      try {
        const coords = view.coordsAtPos(view.state.selection.head)
        dropdown.style.top = `${coords.bottom + 2}px`
        dropdown.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - 240))}px`
      } catch {
        dropdown.style.display = 'none'
      }
    }

    function renderDropdownItems(s: EmojiSuggestState): void {
      if (!dropdown) return
      const filtered = getFiltered(s.query)
      if (filtered.length === 0) {
        dropdown.style.display = 'none'
        return
      }
      dropdown.style.display = ''
      dropdown.innerHTML = ''
      for (let i = 0; i < filtered.length; i++) {
        const { name, emoji } = filtered[i]
        const item = document.createElement('div')
        item.className = 'velo-emoji-dropdown-item'
        if (i === s.highlightIndex) item.classList.add('highlighted')
        item.innerHTML =
          `<span class="velo-emoji-dropdown-char">${emoji}</span>` +
          `<span class="velo-emoji-dropdown-name">:${highlightMatch(name, s.query)}:</span>`
        // mousedown preventDefault 阻止编辑器失焦
        item.addEventListener('mousedown', (e) => { e.preventDefault() })
        item.addEventListener('click', () => {
          const currentS = emojiSuggestKey.getState(view.state)
          if (!currentS || !currentS.active) return
          commitSuggestion(view, currentS, name)
        })
        dropdown.appendChild(item)
      }
    }

    function showDropdown(s: EmojiSuggestState): void {
      if (!dropdown) {
        dropdown = document.createElement('div')
        dropdown.className = 'velo-emoji-dropdown'
        document.body.appendChild(dropdown)
        window.addEventListener('scroll', updateDropdownPosition, { capture: true, passive: true })
        window.addEventListener('resize', updateDropdownPosition)
      }
      renderDropdownItems(s)
      updateDropdownPosition()
    }

    function hideDropdown(): void {
      if (!dropdown) return
      dropdown.remove()
      dropdown = null
      window.removeEventListener('scroll', updateDropdownPosition, { capture: true } as EventListenerOptions)
      window.removeEventListener('resize', updateDropdownPosition)
    }

    return {
      update(v: EditorView, prevState: EditorState) {
        const s = emojiSuggestKey.getState(v.state)
        const prevS = emojiSuggestKey.getState(prevState)

        // Read-only: never show
        if (!v.editable) {
          if (dropdown) hideDropdown()
          return
        }

        if (!s || !s.active) {
          if (dropdown) hideDropdown()
          return
        }

        // Active → show/update
        if (!dropdown || !prevS || !prevS.active) {
          showDropdown(s)
        } else if (s.query !== prevS.query) {
          renderDropdownItems(s)
          updateDropdownPosition()
        } else if (s.highlightIndex !== prevS.highlightIndex) {
          const items = dropdown.querySelectorAll('.velo-emoji-dropdown-item')
          items.forEach((item, i) => {
            item.classList.toggle('highlighted', i === s.highlightIndex)
          })
          const el = items[s.highlightIndex] as HTMLElement | undefined
          if (el) el.scrollIntoView({ block: 'nearest' })
        } else {
          updateDropdownPosition()
        }
      },
      destroy() {
        hideDropdown()
      },
    }
  },
})
