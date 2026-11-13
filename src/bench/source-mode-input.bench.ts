// 源码模式输入延迟基准 —— 守护「输入同步路径不跑全文档 shiki」的验收线。
//
// 用法：npm run bench（或 npx vitest bench src/bench/source-mode-input.bench.ts）
// 语料复用 scripts/gen-large-file-corpus.mjs 生成的 src/bench/corpus/*.md。
//
// 三组对照：
// - full-doc tokenize：优化前每键成本（整篇 markdown 跑 TextMate grammar）
// - viewport decorations：优化后重建成本（视口 ±40 行 + grammar context）
// - CM6 single-char dispatch：输入同步路径（装真实 ViewPlugin，只 map + 排 timer）
//
// 期望量级（本机 Node 22 实测）：full-doc 100KB ≈ 101ms / 1MB ≈ 697ms；
// viewport ≈ 5–9ms；single-char dispatch 应远低于 16.7ms 一帧预算。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'vitest'
import { EditorState, Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  getHighlighter,
  getTokensSync,
  DEFAULT_LIGHT_THEME,
  DEFAULT_DARK_THEME,
} from '../components/ProseMirrorEditor/nodes/CodeBlockLangs'
import {
  shikiExtensions,
  buildShikiDecorationsForRange,
  type ShikiThemeState,
} from '../components/ProseMirrorEditor/nodes/shikiCmPlugin'

const corpusDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'corpus')

function loadCorpus(name: string): string {
  const filePath = path.join(corpusDir, name)
  if (!fs.existsSync(filePath)) {
    throw new Error(`语料不存在: ${filePath}\n请先运行 npm run bench:corpus`)
  }
  return fs.readFileSync(filePath, 'utf8')
}

const theme: ShikiThemeState = {
  lightTheme: DEFAULT_LIGHT_THEME,
  darkTheme: DEFAULT_DARK_THEME,
}
// 复用生产单例；resolve 后 getHighlighterSync() 同步可读。
const hl = await getHighlighter(['markdown'], theme.lightTheme, theme.darkTheme)

const corpora = [
  ['100KB', loadCorpus('small.md')],
  ['500KB', loadCorpus('medium.md')],
  ['1MB', loadCorpus('large.md')],
] as const

const VIEWPORT_LINES = 60
const TIMING = { time: 120, warmupTime: 20 }

function viewportRange(doc: Text): { from: number, to: number } {
  const mid = Math.max(1, Math.floor(doc.lines / 2))
  const start = Math.max(1, mid - Math.floor(VIEWPORT_LINES / 2))
  const end = Math.min(doc.lines, start + VIEWPORT_LINES)
  return { from: doc.line(start).from, to: doc.line(end).to }
}

describe('source-mode input path', () => {
  for (const [label, text] of corpora) {
    const doc = Text.of(text.split('\n'))
    const range = viewportRange(doc)

    test(`${label} full-document shiki tokenize (before)`, async ({ bench }) => {
      await bench(`${label} full-doc tokenize`, TIMING, () => {
        getTokensSync(hl, text, 'markdown', theme.lightTheme, theme.darkTheme)
      }).run()
    })

    test(`${label} viewport decorations (after)`, async ({ bench }) => {
      await bench(`${label} viewport decorations`, TIMING, () => {
        buildShikiDecorationsForRange(doc, theme, range)
      }).run()
    })
  }

  test('100KB CM6 single-char dispatch (input sync path)', async ({ bench }) => {
    const parent = document.createElement('div')
    const state = EditorState.create({
      doc: corpora[0][1],
      extensions: shikiExtensions(theme),
    })
    const view = new EditorView({ state, parent })
    let pos = 0
    await bench('100KB single-char dispatch', TIMING, () => {
      view.dispatch({ changes: { from: pos, insert: 'x' } })
      pos = (pos + 1) % 64
    }).run()
    view.destroy()
  })
})
