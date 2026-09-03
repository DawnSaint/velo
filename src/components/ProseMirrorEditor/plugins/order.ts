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
  // foldDecoration 必须排在所有"读取 ancestor-folded 集合"的装饰 plugin 之前
  // (codeHighlight / codeLineNumber / mermaidDecoration / tocDecoration):
  // 这些 plugin 的 apply 阶段会读 FoldDecoration 维护的 module-level
  // set,若 foldDecoPlugin.apply 晚于它们运行,会读到 stale 旧 pos 集合而误
  // 渲染 code block / mermaid / toc 的 header —— 祖先折叠时整段应隐,
  // header 不能孤悬在外。recomputeFoldedCodeBlockPos 在 foldDecoPlugin.apply
  // 内同步刷新集合,故 foldDecoration 前置即可保证消费者读到最新集合。
  'foldDecoration',
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
