/**
 * Canonical plugin loading order — the single source of truth.
 *
 * `resolvePlugins` sorts registered entries by their index in this list.
 * Adding / removing / renaming a plugin in `EditorInner.vue` **requires**
 * updating this array; the resolver will throw on set mismatch.
 *
 * The order encodes implicit ProseMirror plugin `apply` ordering:
 * plugins earlier in the array have their `apply` called first, so later
 * plugins can read the former's state via `pluginKey.getState(state)`.
 */
export const CANONICAL_PLUGIN_ORDER: readonly string[] = [
  // ── Suggest ─────────────────────────────────────────────────────────
  'codeBlockLangSuggest', // handleKeyDown must precede Enter keymap chain
  'emojiSuggest', // handleKeyDown must precede keymap

  // ── Keymap ──────────────────────────────────────────────────────────
  'keymap.backspaceDeleteSelectAll',
  'keymap.undoRedo',
  'keymap.enter',
  'keymap.base',
  'tabIndent',
  'dollarEnterToMathBlock',
  'imageKeymap',

  // ── Cursor & History ────────────────────────────────────────────────
  'dropCursor',
  'gapCursor',
  'history',

  // ── Table ───────────────────────────────────────────────────────────
  'tableColumnResizing', // must precede tableEditing (resize handles first)
  'tableCellInputGuard', // must precede tableEditing (paste interception)
  'tableEditing',
  'tableResizeCursor',
  'tableInsertHandle',
  'tableContextMenu',

  // ── Paste & Upload ──────────────────────────────────────────────────
  'imageUpload',
  'markdownPaste',

  // ── Link & Image Edit ───────────────────────────────────────────────
  'linkClick',
  'linkEditEscape',
  'imageEdit',
  'imageEditEscape',

  // ── Source Edit (must precede syntaxAutoFormat) ─────────────────────
  'markSourceEdit',
  'markSourceEditEscape',
  'htmlSourceEdit',
  'htmlSourceEditEscape',
  'emojiSourceEdit',
  'emojiSourceEditEscape',

  // ── Syntax & Input ──────────────────────────────────────────────────
  'syntaxAutoFormat',

  // ── Viewport (must precede decoration plugins) ──────────────────────
  'viewport',

  // ── Code Decorations (read viewport state) ──────────────────────────
  'codeHighlight',
  'codeWrap',
  'codeLineNumber',

  // ── NodeView ────────────────────────────────────────────────────────
  'imageInlineView',
  'hrNodeView',
  'emojiNodeView',
  'frontmatterNodeView',
  'htmlNodeView',

  // ── Math & Mermaid ──────────────────────────────────────────────────
  'mathEdit',
  'mermaidDecoration',

  // ── Misc Decorations ────────────────────────────────────────────────
  'taskList',
  'footnoteEdit',
  'tocDecoration',
  'foldDecoration',
  'findHighlight',

  // ── Mode ────────────────────────────────────────────────────────────
  'customCaret', // view-only plugin, no state; order irrelevant for apply
  'focusMode',
  'typewriterMode',

  // ── CJK (letterSpacing → autoFormat → autoPair) ─────────────────────
  'cjkLetterSpacing',
  'cjkAutoFormat',
  'autoPair',

  // ── Tail (after all base plugins) ───────────────────────────────────
  'inputRules',
  'shortcutKeymap',
]
