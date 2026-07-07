// ``` 语言建议下拉:用户在 paragraph 中键入 ``` + 语言前缀时,在光标下方
// 浮出模糊匹配下拉(复用 LANG_OPTIONS + langIconSvg + .velo-lang-dropdown 样式)。
// 上下键导航 + Enter 提交(选中条目;无选中时回退到 codeBlockEnterCommand) +
// Escape 关闭 + 点击选择。提交时复用 convertParagraphToCodeBlock 转换段落。
//
// 与 codeBlockEnterCommand 的关系:
// - 无高亮条目时 Enter 不拦截 → keymap Enter 链的 codeBlockEnterCommand 正常
//   触发(用 paragraph 原始文本提取 lang),行为一致。
// - 有高亮条目时 Enter 拦截 → 用选中语言提交,比 codeBlockEnterCommand 的
//   "原始文本提取"更精确(用户可能只输入了 `p` 但选中了 `python`)。
//
// 设计取舍(方案 2 vs 方案 1):
// - 方案 1(输入 ``` 即转 code_block + 聚焦语言输入框)有结构性竞态:
//   PM decoration rebuild 跨帧异步,用户连续输入 ```python 时 `python` 落入
//   code_block 内容区(widget DOM 尚未创建,focus 无法同步设置)。
// - 方案 2(原地下拉):用户始终在 paragraph 内输入,下拉是纯视觉叠层,
//   不改变文档结构,无竞态。提交时一次性转 code_block。

import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { LANG_OPTIONS } from '../nodes/CodeBlockLangs'
import { langIconSvg } from '../nodes/langIcons'
import { mermaidDecoKey } from '../nodes/MermaidDecoration'
import { convertParagraphToCodeBlock } from '../syntax/block/codeBlock'

const SUGGEST_PATTERN = /^```[ \t]*([^\s`]*)[ \t]*$/

export interface SuggestState {
  active: boolean
  query: string
  blockStart: number
  blockEnd: number
  highlightIndex: number
  dismissed: boolean
}

const IDLE: SuggestState = {
  active: false,
  query: '',
  blockStart: -1,
  blockEnd: -1,
  highlightIndex: -1,
  dismissed: false,
}

export const codeBlockLangSuggestKey = new PluginKey<SuggestState>('codeBlockLangSuggest')

// ============================================================
//  过滤 + 渲染(与 CodeHighlightWidget 的 dropdown 逻辑同构)
// ============================================================

function getFiltered(query: string): string[] {
  const q = query.toLowerCase().trim()
  if (!q) return [...LANG_OPTIONS]
  return LANG_OPTIONS.filter((l) => {
    if (l === '') return q === 'plain' || q === 'text' || q === 'plaintext'
    return l.toLowerCase().includes(q)
  })
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
    `<b class="velo-lang-match">${escapeHtml(text.slice(idx, idx + q.length))}</b>` +
    escapeHtml(text.slice(idx + q.length))
  )
}

// ============================================================
//  状态检测:从 EditorState 推导当前是否处于 ``` 语言输入态
// ============================================================

function detectSuggest(state: EditorState): SuggestState {
  const { selection } = state
  if (!selection.empty) return IDLE

  const { $from } = selection
  if ($from.parent.type.name !== 'paragraph') return IDLE
  if ($from.parentOffset !== $from.parent.content.size) return IDLE

  const blockStart = $from.start()
  const blockEnd = $from.end()
  const text = state.doc.textBetween(blockStart, blockEnd, '\n', '\n')
  const match = SUGGEST_PATTERN.exec(text)
  if (!match) return IDLE

  return {
    active: true,
    query: match[1] || '',
    blockStart,
    blockEnd,
    highlightIndex: -1,
    dismissed: false,
  }
}

// ============================================================
//  提交:把 paragraph 转成 code_block
// ============================================================

function commitSuggestion(view: EditorView, s: SuggestState, lang: string): void {
  const tr = view.state.tr
  const normalizedLang = lang.toLowerCase()
  convertParagraphToCodeBlock(tr, view.state.schema, s.blockStart, s.blockEnd, normalizedLang)
  if (normalizedLang === 'mermaid') {
    tr.setMeta(mermaidDecoKey, { toggleEditAt: s.blockStart })
  }
  view.dispatch(tr)
}

// ============================================================
//  Plugin
// ============================================================

export const codeBlockLangSuggestPlugin = new Plugin<SuggestState>({
  key: codeBlockLangSuggestKey,
  state: {
    init: () => IDLE,
    apply(tr, prev, _oldState, newState) {
      // Handle highlight navigation / dismiss meta
      const meta = tr.getMeta(codeBlockLangSuggestKey) as
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
      const s = codeBlockLangSuggestKey.getState(view.state)
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
        view.dispatch(view.state.tr.setMeta(codeBlockLangSuggestKey, { highlightIndex: idx }))
        return true
      }

      // Enter: if highlight selected, intercept and commit with that lang.
      // If no highlight, return false → codeBlockEnterCommand handles it
      // (converts with raw paragraph text, same end result).
      if (key === 'Enter') {
        if (s.highlightIndex >= 0) {
          event.preventDefault()
          const filtered = getFiltered(s.query)
          if (s.highlightIndex < filtered.length) {
            commitSuggestion(view, s, filtered[s.highlightIndex])
            return true
          }
        }
        return false
      }

      // Escape: dismiss dropdown (text stays, dropdown hidden until next doc change)
      if (key === 'Escape') {
        event.preventDefault()
        view.dispatch(view.state.tr.setMeta(codeBlockLangSuggestKey, { dismissed: true }))
        return true
      }

      return false
    },
  },
  view: (view: EditorView) => {
    let dropdown: HTMLDivElement | null = null

    function updateDropdownPosition(): void {
      if (!dropdown) return
      const s = codeBlockLangSuggestKey.getState(view.state)
      if (!s || !s.active) return
      try {
        const coords = view.coordsAtPos(view.state.selection.head)
        dropdown.style.top = `${coords.bottom + 2}px`
        dropdown.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - 200))}px`
      } catch {
        // pos not in DOM (selection changed), hide
        dropdown.style.display = 'none'
      }
    }

    function renderDropdownItems(s: SuggestState): void {
      if (!dropdown) return
      const filtered = getFiltered(s.query)
      if (filtered.length === 0) {
        dropdown.style.display = 'none'
        return
      }
      dropdown.style.display = ''
      dropdown.innerHTML = ''
      for (let i = 0; i < filtered.length; i++) {
        const l = filtered[i]
        const item = document.createElement('div')
        item.className = 'velo-lang-dropdown-item'
        if (i === s.highlightIndex) item.classList.add('highlighted')
        const displayText = l || 'plain text'
        item.innerHTML = `<span class="velo-lang-icon">${langIconSvg(l, 16)}</span><span>${highlightMatch(displayText, s.query)}</span>`
        // mousedown preventDefault 阻止编辑器失焦
        item.addEventListener('mousedown', (e) => { e.preventDefault() })
        item.addEventListener('click', () => {
          const currentS = codeBlockLangSuggestKey.getState(view.state)
          if (!currentS || !currentS.active) return
          commitSuggestion(view, currentS, l)
        })
        dropdown.appendChild(item)
      }
    }

    function showDropdown(s: SuggestState): void {
      if (!dropdown) {
        dropdown = document.createElement('div')
        dropdown.className = 'velo-lang-dropdown'
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
        const s = codeBlockLangSuggestKey.getState(v.state)
        const prevS = codeBlockLangSuggestKey.getState(prevState)

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
          // Transition: inactive → active
          showDropdown(s)
        } else if (s.query !== prevS.query) {
          // Query changed → re-render items
          renderDropdownItems(s)
          updateDropdownPosition()
        } else if (s.highlightIndex !== prevS.highlightIndex) {
          // Only highlight changed → update item classes
          const items = dropdown.querySelectorAll('.velo-lang-dropdown-item')
          items.forEach((item, i) => {
            item.classList.toggle('highlighted', i === s.highlightIndex)
          })
          const el = items[s.highlightIndex] as HTMLElement | undefined
          if (el) el.scrollIntoView({ block: 'nearest' })
        } else {
          // Same state, just reposition
          updateDropdownPosition()
        }
      },
      destroy() {
        hideDropdown()
      },
    }
  },
})
