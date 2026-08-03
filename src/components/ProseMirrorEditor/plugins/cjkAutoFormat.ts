// 实时中文排版插件
//
// 输入层 ProseMirror 插件，键入字符时自动应用中文排版规则：
// 1. 全角标点：在中文后键入 , . ! ? : ; → 自动转为 ，。！？：；
// 2. 中英文间距：中文字符与英文/数字之间自动插入空格
// 3. 破折号：键入第二个 - 时，CJK 上下文下 -- → ——
//
// 智能引号转换已合并到 autoPairPlugin（避免插件顺序依赖），
// 本插件只处理全角标点、间距和破折号。

import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import type { EditorView as PMEditorView } from 'prosemirror-view'
import { useEditorStore } from '@/stores/editor'

// ============================================================
//  字符分类
// ============================================================

const CJK_RE = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/
const LATIN_RE = /[A-Za-z0-9]/

function isCJK(ch: string): boolean {
  return ch.length > 0 && CJK_RE.test(ch[0])
}

function isLatin(ch: string): boolean {
  return ch.length > 0 && LATIN_RE.test(ch[0])
}

// ============================================================
//  半角→全角标点映射
// ============================================================

const HALF_TO_FULL: Record<string, string> = {
  ',': '\uFF0C', // ，
  '.': '\u3002', // 。
  '!': '\uFF01', // ！
  '?': '\uFF1F', // ？
  ':': '\uFF1A', // ：
  ';': '\uFF1B', // ；
}

// ============================================================
//  上下文检测
// ============================================================

function isInCodeBlock(state: EditorState): boolean {
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'code_block') return true
  }
  return false
}

function isInInlineCode(state: EditorState): boolean {
  const { $from } = state.selection
  return $from.marks().some(m => m.type.name === 'code')
}

/** 获取光标前一个字符 */
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
//  插件状态
// ============================================================

interface CjkAutoFormatState {
  cjkEnglishSpacing: boolean
  fullwidthPunctuation: boolean
  dashConversion: boolean
}

export const cjkAutoFormatKey = new PluginKey<CjkAutoFormatState>('veloCjkAutoFormat')

/** 从 store 同步读初值；store 未就绪 / 单元测试场景 fallback。 */
function makeInitialState(): CjkAutoFormatState {
  try {
    const store = useEditorStore()
    const cfg = store.cjkFormatting
    return {
      cjkEnglishSpacing: cfg.cjkEnglishSpacing.auto,
      fullwidthPunctuation: cfg.fullwidthPunctuation.auto,
      dashConversion: cfg.dashConversion.auto,
    }
  } catch {
    return {
      cjkEnglishSpacing: true,
      fullwidthPunctuation: true,
      dashConversion: true,
    }
  }
}

// ============================================================
//  插件
// ============================================================

export const cjkAutoFormatPlugin = new Plugin<CjkAutoFormatState>({
  key: cjkAutoFormatKey,
  state: {
    init: makeInitialState,
    apply(tr, prev) {
      const meta = tr.getMeta(cjkAutoFormatKey) as Partial<CjkAutoFormatState> | undefined
      if (meta) return { ...prev, ...meta }
      return prev
    },
  },
  props: {
    handleTextInput(
      view: PMEditorView,
      from: number,
      to: number,
      text: string,
    ): boolean {
      if (view.composing) return false

      const config = cjkAutoFormatKey.getState(view.state)
      if (!config) return false

      // 代码块 / 行内代码内不干预
      if (isInCodeBlock(view.state) || isInInlineCode(view.state)) return false

      const firstChar = text[0]
      if (!firstChar) return false

      const before = getCharBefore(view.state, from)

      // 1. 全角标点：中文后键入半角标点 → 自动转全角
      if (config.fullwidthPunctuation && text.length === 1) {
        const fullwidth = HALF_TO_FULL[text]
        if (fullwidth && isCJK(before)) {
          view.dispatch(view.state.tr.insertText(fullwidth, from, to))
          return true
        }
      }

      // 2. 中英文间距：中英文交界处自动插入空格
      if (config.cjkEnglishSpacing) {
        // 拉丁/数字紧跟中文 → 插入空格
        if (isLatin(firstChar) && isCJK(before)) {
          view.dispatch(view.state.tr.insertText(' ' + text, from, to))
          return true
        }
        // 中文紧跟拉丁/数字 → 插入空格
        if (isCJK(firstChar) && isLatin(before)) {
          view.dispatch(view.state.tr.insertText(' ' + text, from, to))
          return true
        }
      }

      // 3. 破折号：键入 - 且前一个字符也是 - → CJK 上下文下转为 ——
      if (config.dashConversion && text.length === 1 && firstChar === '-' && before === '-') {
        // 检查 -- 前后是否有 CJK 字符（放宽：光标前两个字符中含 CJK 即可）
        const before2 = getCharBefore(view.state, from - 1)
        if (isCJK(before2) || isCJK(getCharBefore(view.state, from + 1))) {
          // 删除前一个 -，插入 ——（替换 from-1..to）
          view.dispatch(view.state.tr.insertText('\u2014\u2014', from - 1, to))
          return true
        }
      }

      return false
    },
  },
})
