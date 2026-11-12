// markdownIO 基准测试 — 守护 parse / serialize 性能基线
//
// 用法：npm run bench
//
// 语料由 scripts/gen-large-file-corpus.mjs 生成，放在 src/bench/corpus/。
// 首次运行前先 `npm run bench:corpus` 生成语料。
//
// 关注指标：
// - fromMarkdown（parse）：remark parse → runSync → mdastToPMDoc
// - toMarkdown（serialize）：PM doc → mdast → remark stringify
// - round-trip：parse → serialize（完整往返）
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
// Vitest 5 起 bench 不再是顶层导出，而是 test context 里的 fixture。
import { describe, test } from 'vitest'
import { fromMarkdown, toMarkdown } from '../components/ProseMirrorEditor/editor/markdownIO'
import { schema } from '../components/ProseMirrorEditor/editor/schema'

const __filename = fileURLToPath(import.meta.url)
const corpusDir = path.resolve(path.dirname(__filename), 'corpus')

// 加载语料（文件不存在时给提示）
function loadCorpus(name: string): string {
  const filePath = path.join(corpusDir, name)
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `语料文件不存在: ${filePath}\n请先运行 \`npm run bench:corpus\` 生成语料。`,
    )
  }
  return fs.readFileSync(filePath, 'utf8')
}

const small = loadCorpus('small.md') // ~100KB
const medium = loadCorpus('medium.md') // ~500KB
const large = loadCorpus('large.md') // ~1MB

// 预解析文档供 serialize bench 使用
const smallDoc = fromMarkdown(small, schema)
const mediumDoc = fromMarkdown(medium, schema)
// large 不预解析在模块顶层（可能太慢），在 describe 内按需解析

// ── parse（fromMarkdown）──────────────────────────────────
describe('fromMarkdown (parse)', () => {
  test('100KB document', async ({ bench }) => {
    await bench('100KB document', () => {
      fromMarkdown(small, schema)
    }).run()
  })

  test('500KB document', async ({ bench }) => {
    await bench('500KB document', () => {
      fromMarkdown(medium, schema)
    }).run()
  })

  test('1MB document', async ({ bench }) => {
    await bench('1MB document', () => {
      fromMarkdown(large, schema)
    }).run()
  })
})

// ── serialize（toMarkdown）────────────────────────────────
describe('toMarkdown (serialize)', () => {
  test('100KB document', async ({ bench }) => {
    await bench('100KB document', () => {
      toMarkdown(smallDoc)
    }).run()
  })

  test('500KB document', async ({ bench }) => {
    await bench('500KB document', () => {
      toMarkdown(mediumDoc)
    }).run()
  })

  test('1MB document', async ({ bench }) => {
    await bench('1MB document', () => {
      const largeDoc = fromMarkdown(large, schema)
      toMarkdown(largeDoc)
    }).run()
  })
})

// ── round-trip（parse → serialize）────────────────────────
describe('round-trip (parse → serialize)', () => {
  test('100KB document', async ({ bench }) => {
    await bench('100KB document', () => {
      const doc = fromMarkdown(small, schema)
      toMarkdown(doc)
    }).run()
  })

  test('500KB document', async ({ bench }) => {
    await bench('500KB document', () => {
      const doc = fromMarkdown(medium, schema)
      toMarkdown(doc)
    }).run()
  })
})
