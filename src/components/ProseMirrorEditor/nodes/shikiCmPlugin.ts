// 源代码模式 shiki 高亮 —— CodeMirror 6 ViewPlugin。
//
// 与 WYSIWYG 的 CodeHighlightWidget.ts 对仗:那边把 shiki token 转成
// ProseMirror Decoration.inline,这边转成 CM6 Decoration.mark。两边共用
// 同一套 shiki 集成(`CodeBlockLangs.ts` 的 getHighlighterSync /
// getTokensSync / ensureTheme / ensureMarkdownGrammar),token hex 都写成
// 局部 CSS 变量 `--shiki-light` / `--shiki-dark`,SCSS 那边
// `color: var(--shiki-light)` 选色 —— dark/light 切换纯 CSS cascade 零重渲。
//
// **token.offset 即 code 片段内偏移**:shiki 的 ThemedToken.offset 是相对输入
// 字符串开头的全局偏移(`\n` 算 1 位),绝对 doc pos = slice.from + offset。
// `grammarContextCode` 只参与 grammar 推断,不改变输出行数与 offset 语义,
// 因此视口切片仍能直接换算绝对位置。
//
// **输入路径不跑 shiki**(per-keystroke 关键路径):旧实现每次 docChanged 都
// 对整篇文档跑一次 TextMate grammar + 从零重建 DecorationSet,实测 5KB 26ms /
// 100KB 101ms / 1MB 697ms,远超一帧预算。现在 docChanged 只做
// `decorations.map(u.changes)` 平移,真正的 tokenize 延迟到停止输入后
// (REBUILD_DELAY_MS)或滚动停下后(VIEWPORT_DELAY_MS),且只 tokenize
// visibleRanges 对应行 + 上下 buffer。
//
// **主题镜像 + ensureTheme 串行 + 不全黑**:主题切换 watch → ensureTheme 串行
// → resolve 后 dispatch setShikiTheme effect → ViewPlugin.update 同步 rebuild。
// build 只读 StateField 里的主题名镜像,不直接读 editorStore —— store mutate
// 不会触发 rebuild,只有 effect dispatch 后(= ensureTheme 已完成 = shiki 已
// 拿到真 hex)才 rebuild,不会出现中间全黑帧。

import { EditorView, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { StateEffect, StateField, type Extension, type Range, type Text } from '@codemirror/state'
import { measureSync } from '@/utils/perf'
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

/** 触发一次视口重建。effect-only transaction(docChanged=false),不进 undo、
 *  不触发 content 回写 —— 只让 CM6 重新读一次 decorations。 */
const rebuildShiki = StateEffect.define<null>()

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
//  视口切片
// ============================================================

/** 停止输入后重建高亮的延迟;滚动用更短的一档。 */
const REBUILD_DELAY_MS = 140
const VIEWPORT_DELAY_MS = 90
/** 视口上下各多高亮多少行 —— 滚动时不必每帧重建。 */
const BUFFER_LINES = 40
/** 单次 tokenize 输入上限,防极端 visibleRanges / 超长行把输入线程拖死。 */
const MAX_CODE_CHARS = 64_000
/** grammar 上下文回溯上限。 */
const CONTEXT_MAX_CHARS = 16_000
const CONTEXT_SCAN_LINES = 400

interface ViewSlice {
  /** 实际 tokenize 的 doc 区间起点(绝对 pos)。 */
  from: number
  /** 实际 tokenize 的 doc 区间终点(绝对 pos)。 */
  to: number
  /** 视口之前的文本,交给 shiki 作 grammarContextCode,不进输出。 */
  context: string
}

/**
 * 找视口起点之前最近的围栏行,把「该行 → 视口起点」作为 grammar 上下文。
 *
 * markdown 的跨行状态主要在 fenced code block:视口恰好落在 ``` 内部时,
 * 不传上下文 shiki 会把代码当正文解析(实测 `**bold**` 在 fence 内会被误判
 * 成强调)。传上最近一个围栏行后,shiki 自己重新推断出正确状态 —— 那行是
 * 开启还是闭合都由 grammar 判定,无需我们配对,也不需要扫全文档。
 */
function grammarContext(doc: Text, startLine: number, codeFrom: number): string {
  if (startLine <= 1) return ''
  let fenceLine = -1
  const minLine = Math.max(1, startLine - CONTEXT_SCAN_LINES)
  for (let n = startLine - 1; n >= minLine; n--) {
    if (/^\s*(`{3,}|~{3,})/.test(doc.line(n).text)) {
      fenceLine = n
      break
    }
  }
  if (fenceLine < 0) return ''
  let from = doc.line(fenceLine).from
  if (codeFrom - from > CONTEXT_MAX_CHARS) {
    from = doc.lineAt(codeFrom - CONTEXT_MAX_CHARS).from
  }
  return doc.sliceString(from, codeFrom)
}

/** 当前可见范围。jsdom / 无布局时 visibleRanges 为空,退化成整篇
 *  (再受 MAX_CODE_CHARS 限制),保证测试与冷启动仍有高亮。 */
function visibleRange(view: EditorView): { from: number, to: number } {
  const doc = view.state.doc
  const ranges = view.visibleRanges
  let from = doc.length
  let to = 0
  for (const r of ranges) {
    from = Math.min(from, r.from)
    to = Math.max(to, r.to)
  }
  if (!ranges.length || to <= from) return { from: 0, to: doc.length }
  return { from, to }
}

/** 可见范围 → 整行对齐 + 上下 buffer + 长度上限 + grammar 上下文。 */
function expandSlice(doc: Text, range: { from: number, to: number }): ViewSlice {
  const firstLine = doc.lineAt(Math.max(0, Math.min(range.from, doc.length))).number
  const lastLine = doc.lineAt(Math.max(0, Math.min(range.to, doc.length))).number
  const startLine = Math.max(1, firstLine - BUFFER_LINES)
  const endLine = Math.min(doc.lines, lastLine + BUFFER_LINES)
  const codeFrom = doc.line(startLine).from
  const codeTo = Math.min(doc.line(endLine).to, codeFrom + MAX_CODE_CHARS)
  return {
    from: codeFrom,
    to: codeTo,
    context: grammarContext(doc, startLine, codeFrom),
  }
}

/**
 * 构建指定范围内的 shiki decoration。抽成「只依赖 Text」的纯函数,
 * bench 不需要挂载 EditorView 就能量化生产路径。
 */
export function buildShikiDecorationsForRange(
  doc: Text,
  themeState: ShikiThemeState,
  range: { from: number, to: number },
): DecorationSet {
  const hl = getHighlighterSync()
  if (!hl) return Decoration.none
  // 「无主题」哨兵:light 或 dark 任一为空 → 跳过 shiki 渲染
  if (!themeState.lightTheme || !themeState.darkTheme) return Decoration.none

  const slice = expandSlice(doc, range)
  const code = doc.sliceString(slice.from, slice.to)
  const result = getTokensSync(
    hl, code, 'markdown', themeState.lightTheme, themeState.darkTheme, slice.context,
  )
  if (!result || result.tokens.length === 0) return Decoration.none

  const decos: Range<Decoration>[] = []
  for (const line of result.tokens) {
    for (const token of line) {
      const from = slice.from + token.offset
      const to = from + token.content.length
      if (from >= to || to > slice.to) continue
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

/** ViewPlugin 入口:按 view.visibleRanges 构建。`rangeOverride` 供测试 / bench
 *  指定视口,绕开 jsdom 无布局时 visibleRanges 为空的退化路径。 */
function buildShikiDecorations(
  view: EditorView,
  themeState: ShikiThemeState,
  rangeOverride?: { from: number, to: number },
): DecorationSet {
  return buildShikiDecorationsForRange(
    view.state.doc, themeState, rangeOverride ?? visibleRange(view),
  )
}

// ============================================================
//  ViewPlugin —— 输入只 map,重建走延迟 effect
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
    private view: EditorView
    private timer: ReturnType<typeof setTimeout> | null = null
    private destroyed = false

    constructor(view: EditorView) {
      this.view = view
      this.decorations = this.build(view)
    }

    update(u: ViewUpdate): void {
      this.view = u.view
      const themeChanged = u.transactions.some(t => t.effects.some(e => e.is(setShikiTheme)))
      const rebuildRequested = u.transactions.some(t => t.effects.some(e => e.is(rebuildShiki)))
      if (themeChanged || rebuildRequested) {
        this.cancel()
        this.decorations = this.build(u.view)
        return
      }
      if (u.docChanged) {
        // 输入同步路径:只平移旧装饰(O(视口)),绝不在这里跑 shiki。
        // 停止输入后由 timer dispatch rebuildShiki 重算着色。
        this.decorations = this.decorations.map(u.changes)
        this.schedule(REBUILD_DELAY_MS)
        return
      }
      if (u.viewportChanged) this.schedule(VIEWPORT_DELAY_MS)
    }

    private schedule(ms: number): void {
      if (this.destroyed) return
      this.cancel()
      this.timer = setTimeout(() => {
        this.timer = null
        if (this.destroyed) return
        this.view.dispatch({ effects: rebuildShiki.of(null) })
      }, ms)
    }

    private cancel(): void {
      if (this.timer !== null) {
        clearTimeout(this.timer)
        this.timer = null
      }
    }

    destroy(): void {
      this.destroyed = true
      this.cancel()
    }

    private build(view: EditorView): DecorationSet {
      return measureSync('shiki-build', () =>
        buildShikiDecorations(view, view.state.field(themeField)))
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
