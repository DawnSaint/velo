// 源代码模式 shiki 高亮 —— CodeMirror 6 ViewPlugin。
//
// 与 WYSIWYG 的 CodeHighlightWidget.ts 对仗:那边把 shiki token 转成
// ProseMirror Decoration.inline,这边转成 CM6 Decoration.mark。两边共用
// 同一套 shiki 集成(`CodeBlockLangs.ts` 的 getHighlighterSync /
// getTokensSync / ensureTheme / ensureMarkdownGrammar),token hex 都写成
// 局部 CSS 变量 `--shiki-light` / `--shiki-dark`,SCSS 那边
// `color: var(--shiki-light)` 选色 —— dark/light 切换纯 CSS cascade 零重渲。
//
// **token.offset 即 CM6 doc pos**:shiki 的 ThemedToken.offset 是相对输入
// 字符串开头的全局偏移;CM6 单文档的 pos 也等于字符串偏移(`\n` 算 1 位),
// 两者同构,直接 range(token.offset, token.offset + content.length)。同
// CodeHighlightWidget.ts:507 用的性质。
//
// **主题镜像 + ensureTheme 串行 + 不全黑**:跟旧 SourceModeEditor.vue 的
// 修复链路等价(原 bug:store mutate → computed 立即重渲 → ensureTheme 未
// resolve → shiki 拿未注册主题 → token.variants.light.color 静默 undefined
// → fallback 字面量 'var(--shiki-light)' → cascade 到 :root 默认 #24292e
// → 整片全黑)。这里改成:主题切换 watch → ensureTheme 串行 → resolve 后
// dispatch setShikiTheme effect → ViewPlugin.update 拿到新主题名再 build。
// build 只读 StateField 里的主题名镜像,**不**直接读 editorStore —— store
// mutate 不会触发 rebuild,只有 effect dispatch 后(= ensureTheme 已完成 =
// shiki 已拿到真 hex)才 rebuild,不会出现中间全黑帧。dispatch target 从
// Vue ref 改 CM6 state effect,同步语义一致。

import { EditorView, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'
import type { Extension, Range } from '@codemirror/state'
import {
  getHighlighterSync,
  getTokensSync,
} from './CodeBlockLangs'

// ============================================================
//  主题名镜像 —— StateField 持当前 [light, dark] 主题名
// ============================================================

export interface ShikiThemeState {
  lightTheme: string
  darkTheme: string
}

/** 主题切换 effect:dispatch 后 ViewPlugin.update 读到新主题名再 rebuild。
 *  必须在 ensureTheme resolve 后才 dispatch,否则 shiki 拿未注册主题 →
 *  token color undefined → 全黑(见文件头注释)。 */
export const setShikiTheme = StateEffect.define<ShikiThemeState>()

/** 持当前主题名镜像的 StateField 工厂。初值由 SourceModeEditor 注入
 *  (初值取自 store,等价于 App.vue codeBlockReady 已 ensure 过的 bootstrap
 *  主题)。返回的 field 实例同时喂给 createShikiHighlighter(闭包读取)与
 *  EditorState extensions —— 必须是同一个实例。 */
function shikiThemeField(initial: ShikiThemeState): StateField<ShikiThemeState> {
  return StateField.define<ShikiThemeState>({
    create: () => initial,
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(setShikiTheme)) return e.value
      }
      return value
    },
  })
}

// ============================================================
//  ViewPlugin —— doc change / 主题 effect → rebuild decorations
// ============================================================

/**
 * 创建 shiki 高亮 ViewPlugin extension。
 *
 * @param themeField  shikiThemeField() 创建的 StateField 实例,ViewPlugin
 *                    通过 view.state.field(themeField) 读当前主题名镜像。
 *                    必须与注入 EditorState 的是同一个实例。
 */
function createShikiHighlighter(
  themeField: StateField<ShikiThemeState>,
): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }

    update(u: ViewUpdate): void {
      // doc 变化(用户输入 / 外部 modelValue 同步)或收到主题 effect → rebuild。
      // 视口变化不 rebuild(shiki 一次性 tokenize 全文,与视口无关)。
      if (!u.docChanged && !u.transactions.some(t => t.effects.some(e => e.is(setShikiTheme)))) {
        return
      }
      this.decorations = this.build(u.view)
    }

    build(view: EditorView): DecorationSet {
      const hl = getHighlighterSync()
      // highlighter 未 ready(App.vue codeBlockReady 守门前 / 测试未预装)→
      // 降级空,等 ready 后由 SourceModeEditor dispatch 一次 setShikiTheme
      // effect 触发 rebuild。
      if (!hl) return Decoration.none

      const themeState = view.state.field(themeField)
      // 「无主题」哨兵:light 或 dark 任一为空 → 跳过 shiki 渲染
      if (!themeState.lightTheme || !themeState.darkTheme) return Decoration.none

      const code = view.state.doc.toString()
      const result = getTokensSync(hl, code, 'markdown', themeState.lightTheme, themeState.darkTheme)
      if (!result || result.tokens.length === 0) return Decoration.none

      const decos: Range<Decoration>[] = []
      for (const line of result.tokens) {
        for (const token of line) {
          const from = token.offset
          const to = token.offset + token.content.length
          if (from >= to) continue
          const light = token.variants?.light?.color
          const dark = token.variants?.dark?.color
          if (!light && !dark) continue
          const parts: string[] = []
          if (light) parts.push(`--shiki-light:${light}`)
          if (dark) parts.push(`--shiki-dark:${dark}`)
          decos.push(Decoration.mark({ attributes: { style: parts.join(';') } }).range(from, to))
        }
      }
      return Decoration.set(decos, true)
    }
  }, {
    decorations: (v) => v.decorations,
  })
}

/** 便捷:把 field + plugin 打包成一组 extensions(初值 + 高亮 plugin)。
 *  SourceModeEditor 用这个一次拿到两个 extension。 */
export function shikiExtensions(initial: ShikiThemeState): Extension[] {
  const field = shikiThemeField(initial)
  return [field, createShikiHighlighter(field)]
}
