// CJK 括号自动配对插件(Phase 2)
//
// 输入层 ProseMirror 插件,键入开括号时自动插入闭括号。
// 支持 ASCII 括号 `()` `[]` `{}` + CJK 括号 `（）` `【】` `「」` `『』` `《》` `〈〉`。
//
// 功能:
// - handleTextInput: 开括号 -> 插入开+闭,光标居中;有选区时包裹选区
// - 闭括号跳越: 键入已有闭括号 -> 光标跳过(不重复插入)
// - 成对删除: Backspace 在配对中间 -> 同时删除两侧
// - Tab/Shift+Tab 跳越: Tab 跳过闭括号,Shift+Tab 跳回开括号(代码块/行内代码内不触发)
// - IME 守卫: 组合输入期间全量拦截,防止干扰 CJK 输入法
//
// 移植自 vmark 项目 src/plugins/autoPair/(5 文件合并为 1 文件),
// 去掉了 backtick 代码标记切换(velo 由 syntaxAutoFormat 接管)和弯引号配对(简化为单开关)。

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import type { EditorView as PMEditorView } from 'prosemirror-view'
import { useEditorStore } from '@/stores/editor'

// ============================================================
//  Pair definitions
// ============================================================

/** ASCII bracket and quote pairs */
const ASCII_PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
  '`': '`',
}

/** CJK bracket pairs */
const CJK_BRACKET_PAIRS: Record<string, string> = {
  '（': '）',
  '【': '】',
  '「': '」',
  '『': '』',
  '《': '》',
  '〈': '〉',
}

/** All pairs combined (always include CJK) */
const ALL_PAIRS: Record<string, string> = {
  ...ASCII_PAIRS,
  ...CJK_BRACKET_PAIRS,
}

/** All closing characters (for skip-over detection) */
const CLOSING_CHARS = new Set(Object.values(ALL_PAIRS))

/** Characters that should use smart quote detection (don't pair after word char) */
const SMART_QUOTE_CHARS = new Set(["'"])

/** 开引号上下文：前方是空白、行首或开括号 */
const OPENING_CONTEXT = new Set([
  '', ' ', '\t', '\n',
  '(', '\uFF08', // （
  '[', '\u3010', // 【
  '{',
  '\u300C', // 「
  '\u300E', // 『
  '\u300A', // 《
  '\u3008', // 〈
])

function isOpenContext(before: string): boolean {
  return OPENING_CONTEXT.has(before)
}

/** Get the closing character for an opening character */
function getClosingChar(openChar: string): string | null {
  return ALL_PAIRS[openChar] ?? null
}

/** Check if a character is a closing bracket/quote */
function isClosingChar(char: string): boolean {
  return CLOSING_CHARS.has(char)
}

/** Find the opening character for a closing character */
function getOpeningChar(closeChar: string): string | null {
  for (const [open, close] of Object.entries(ALL_PAIRS)) {
    if (close === closeChar) return open
  }
  return null
}

/** Check if a closing char is a known pair */
function isAllowedClosingChar(char: string): boolean {
  return getOpeningChar(char) !== null
}

/** Check if an opening char is a known pair */
function isAllowedOpeningChar(char: string): boolean {
  return getClosingChar(char) !== null
}

// ============================================================
//  Context detection utils
// ============================================================

/** Check if the cursor is inside a code block */
function isInCodeBlock(state: EditorState): boolean {
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'code_block') return true
  }
  return false
}

/** Check if the cursor is inside inline code mark */
function isInInlineCode(state: EditorState): boolean {
  const { $from } = state.selection
  return $from.marks().some(m => m.type.name === 'code')
}

/** Check if the character before the cursor is a word character */
function isAfterWordChar(state: EditorState, pos: number): boolean {
  if (pos <= 0) return false
  const $pos = state.doc.resolve(pos)
  const textBefore = $pos.parent.textBetween(
    Math.max(0, $pos.parentOffset - 1),
    $pos.parentOffset,
    '',
  )
  if (!textBefore) return false
  return /[\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(textBefore)
}

/** Check if auto-pairing should occur */
function shouldAutoPair(state: EditorState, pos: number, char: string): boolean {
  if (isInCodeBlock(state)) return false
  if (isInInlineCode(state)) return false
  // Smart quote: don't pair after word character (it's an apostrophe)
  if (SMART_QUOTE_CHARS.has(char) && isAfterWordChar(state, pos)) return false
  // Don't auto-pair if preceded by backslash (escaped)
  if (pos > 0) {
    const $pos = state.doc.resolve(pos)
    const textBefore = $pos.parent.textBetween(
      Math.max(0, $pos.parentOffset - 1),
      $pos.parentOffset,
      '',
    )
    if (textBefore === '\\') return false
  }
  return true
}

/** Get the character at a specific position */
function getCharAt(state: EditorState, pos: number): string {
  if (pos < 0 || pos >= state.doc.content.size) return ''
  try {
    const $pos = state.doc.resolve(pos)
    return $pos.parent.textBetween(
      $pos.parentOffset,
      Math.min($pos.parentOffset + 1, $pos.parent.content.size),
      '',
    )
  } catch { return '' }
}

/** Get the character before the cursor position */
function getCharBefore(state: EditorState, pos: number): string {
  if (pos <= 0) return ''
  try {
    const $pos = state.doc.resolve(pos)
    return $pos.parent.textBetween(
      Math.max(0, $pos.parentOffset - 1),
      $pos.parentOffset,
      '',
    )
  } catch { return '' }
}

// ============================================================
//  Core handlers
// ============================================================

interface AutoPairConfig {
  enabled: boolean
  smartQuoteConversion: boolean
  cjkCornerQuotes: boolean
}

/** Handle text input — smart quote conversion + auto-pair opening characters */
function handleTextInput(
  view: PMEditorView,
  from: number,
  to: number,
  text: string,
  config: AutoPairConfig,
): boolean {
  if (text.length !== 1) return false

  const { state } = view

  // 智能引号转换（优先于自动配对，独立于 autoPairEnabled 开关）
  if (config.smartQuoteConversion && !isInCodeBlock(state) && !isInInlineCode(state)) {
    if (text === '"') {
      const before = getCharBefore(state, from)
      const open = isOpenContext(before)
      const quote = config.cjkCornerQuotes
        ? (open ? '\u300C' : '\u300D')  // 「 」
        : (open ? '\u201C' : '\u201D')  // “ ”
      view.dispatch(state.tr.insertText(quote, from, to))
      return true
    }
    if (text === "'" && !isAfterWordChar(state, from)) {
      const before = getCharBefore(state, from)
      const open = isOpenContext(before)
      view.dispatch(state.tr.insertText(
        open ? '\u2018' : '\u2019', from, to,
      ))
      return true
    }
  }

  // 自动配对（仅在 autoPairEnabled 开启时）
  if (!config.enabled) return false

  const closing = getClosingChar(text)
  if (!closing) return false

  if (!shouldAutoPair(state, from, text)) return false

  // Check if next char is already the closing char (avoid double-pairing)
  const nextChar = getCharAt(state, to)
  if (from === to && nextChar === closing) return false

  const { dispatch } = view

  if (from !== to) {
    // Wrap selection with the pair
    const $from = state.doc.resolve(from)
    const $to = state.doc.resolve(to)
    if (!$from.parent.isTextblock || !$to.parent.isTextblock) return false

    const tr = state.tr
    tr.insertText(closing, to, to)
    tr.insertText(text, from, from)
    tr.setSelection(TextSelection.create(tr.doc, to + 1))
    dispatch(tr)
  } else {
    // Insert pair with cursor between
    const tr = state.tr.insertText(text + closing, from)
    tr.setSelection(TextSelection.create(tr.doc, from + 1))
    dispatch(tr)
  }

  return true
}

/** Handle closing bracket input — skip over if already present */
function handleClosingBracket(
  view: PMEditorView,
  char: string,
  config: AutoPairConfig,
): boolean {
  if (!config.enabled) return false
  if (!isAllowedClosingChar(char)) return false

  const { state } = view
  const { from, to } = state.selection

  if (from !== to) return false

  const nextChar = getCharAt(state, from)
  if (nextChar !== char) return false

  const tr = state.tr.setSelection(TextSelection.create(state.doc, from + 1))
  view.dispatch(tr.setMeta('addToHistory', false))
  return true
}

/** Handle backspace — delete pair if cursor is between matching brackets */
function handleBackspacePair(view: PMEditorView, config: AutoPairConfig): boolean {
  if (!config.enabled) return false

  const { state } = view
  const { from, to } = state.selection

  if (from !== to || from < 1) return false

  const prevChar = getCharBefore(state, from)
  const nextChar = getCharAt(state, from)

  const expectedClosing = getClosingChar(prevChar)
  if (expectedClosing && expectedClosing === nextChar) {
    view.dispatch(state.tr.delete(from - 1, from + 1))
    return true
  }

  return false
}

/** Directional bracket jump — shared logic for Tab (forward) and Shift+Tab (backward) */
function handleDirectionalJump(
  view: PMEditorView,
  config: AutoPairConfig,
  getChar: (state: EditorState, pos: number) => string,
  isAllowed: (char: string) => boolean,
  offset: 1 | -1,
): boolean {
  if (!config.enabled) return false

  const { state } = view
  const { from, to } = state.selection

  if (from !== to) return false
  if (isInCodeBlock(state) || isInInlineCode(state)) return false

  const char = getChar(state, from)
  if (!char || !isAllowed(char)) return false

  const tr = state.tr.setSelection(TextSelection.create(state.doc, from + offset))
  view.dispatch(tr.setMeta('addToHistory', false))
  return true
}

/** Handle Tab key — jump over closing bracket */
function handleTabJump(view: PMEditorView, config: AutoPairConfig): boolean {
  return handleDirectionalJump(view, config, getCharAt, isAllowedClosingChar, 1)
}

/** Handle Shift+Tab key — jump before opening bracket */
function handleShiftTabJump(view: PMEditorView, config: AutoPairConfig): boolean {
  return handleDirectionalJump(view, config, getCharBefore, isAllowedOpeningChar, -1)
}

// ============================================================
//  Plugin state
// ============================================================

interface AutoPairState {
  enabled: boolean
  smartQuoteConversion: boolean
  cjkCornerQuotes: boolean
}

export const autoPairKey = new PluginKey<AutoPairState>('veloAutoPair')

/** 从 store 同步读初值;store 未就绪 / 单元测试场景 fallback。 */
function makeInitialState(): AutoPairState {
  let enabled = true
  let smartQuoteConversion = true
  let cjkCornerQuotes = false
  try {
    const store = useEditorStore()
    if (typeof store.autoPairEnabled === 'boolean') enabled = store.autoPairEnabled
    const cfg = store.cjkFormatting
    smartQuoteConversion = cfg.smartQuoteConversion.auto
    cjkCornerQuotes = cfg.cjkCornerQuotes
  } catch { /* pinia not ready / test fallback */ }
  return { enabled, smartQuoteConversion, cjkCornerQuotes }
}

export const autoPairPlugin = new Plugin<AutoPairState>({
  key: autoPairKey,
  state: {
    init: makeInitialState,
    apply(tr, prev) {
      const meta = tr.getMeta(autoPairKey) as Partial<AutoPairState> | undefined
      if (meta) {
        return {
          enabled: meta.enabled ?? prev.enabled,
          smartQuoteConversion: meta.smartQuoteConversion ?? prev.smartQuoteConversion,
          cjkCornerQuotes: meta.cjkCornerQuotes ?? prev.cjkCornerQuotes,
        }
      }
      return prev
    },
  },
  props: {
    handleTextInput(view, from, to, text) {
      if (view.composing) return false
      const s = autoPairKey.getState(view.state)
      if (!s) return false
      return handleTextInput(view, from, to, text, s)
    },
    handleDOMEvents: {
      keydown(view, event) {
        const e = event as KeyboardEvent
        if (e.isComposing) return false
        if (e.ctrlKey || e.altKey || e.metaKey) return false

        const s = autoPairKey.getState(view.state)
        if (!s) return false

        if (e.key === 'Tab' && !e.shiftKey) {
          if (handleTabJump(view, s)) {
            e.preventDefault()
            return true
          }
          return false
        }

        if (e.key === 'Tab' && e.shiftKey) {
          if (handleShiftTabJump(view, s)) {
            e.preventDefault()
            return true
          }
          return false
        }

        if (e.key === 'Backspace') {
          if (handleBackspacePair(view, s)) {
            e.preventDefault()
            return true
          }
          return false
        }

        if (e.key.length === 1 && isClosingChar(e.key)) {
          if (handleClosingBracket(view, e.key, s)) {
            e.preventDefault()
            return true
          }
        }

        return false
      },
    },
  },
})
