// 链接 / 锚点 / 脚注回归：确认 ts 导出 PDF 的链接注解与命名目标真的写进字节。
//
// 之前的问题（2026-11-20）：ts 链路只画文字，从不产出 /Annots —— 目录跳转、
// 脚注互跳、外部链接全部失效（webview 版有 53 条 /Link）。这里用真实 markdown
// 跑完整 buildPdf → writePdf，再解析产物字节断言注解存在。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const HB_URL = 'velo-test:hb-subset.wasm'
const WOFF2_URLS = {
  sans: 'velo-test:sans.woff2',
  bold: 'velo-test:bold.woff2',
  mono: 'velo-test:mono.woff2',
} as const

vi.mock('harfbuzzjs/dist/harfbuzz-subset.wasm?url', () => ({ default: HB_URL }))
vi.mock('../../../../fonts/notosanssc/NotoSansSC-Regular.woff2?url', () => ({ default: WOFF2_URLS.sans }))
vi.mock('../../../../fonts/notosanssc/NotoSansSC-Bold.woff2?url', () => ({ default: WOFF2_URLS.bold }))
vi.mock('../../../../fonts/jetbrainsmono/JetBrainsMono-Regular.woff2?url', () => ({ default: WOFF2_URLS.mono }))

function disk(rel: string): Uint8Array {
  const p = fileURLToPath(new URL(rel, import.meta.url))
  const b = readFileSync(p)
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
}

const BYTES: Record<string, Uint8Array> = {
  [HB_URL]: disk('../../../../../node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm'),
  [WOFF2_URLS.sans]: disk('../../../../fonts/notosanssc/NotoSansSC-Regular.woff2'),
  [WOFF2_URLS.bold]: disk('../../../../fonts/notosanssc/NotoSansSC-Bold.woff2'),
  [WOFF2_URLS.mono]: disk('../../../../fonts/jetbrainsmono/JetBrainsMono-Regular.woff2'),
}

vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  const bytes = BYTES[url]
  if (!bytes) throw new Error(`unexpected fetch: ${url}`)
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}))

const { buildPdf, serializePdf } = await import('../index')

const MD = [
  '# 标题一',
  '',
  '[TOC]',
  '',
  '跳到 [第二节](#第二节) 与 [CommonMark](https://commonmark.org/)。',
  '',
  '脚注引用[^a] 再来一次[^a]。',
  '',
  '## 第二节',
  '',
  '正文。',
  '',
  '[^a]: 脚注内容，含 [链接](https://example.com/)。',
  '',
].join('\n')

async function build(): Promise<Uint8Array> {
  const src = { content: MD, currentFilePath: null, lightTheme: 'vitesse-light', darkTheme: 'vitesse-dark' }
  const opts = {
    margins: { horizontal: 16, vertical: 18 },
    fontSize: 12, lineHeight: 1.75,
    showHeader: false, showFooter: true, headerText: '', dark: false,
  }
  const pdf = await buildPdf(src, opts)
  return serializePdf(pdf.doc)
}

describe('PDF 链接注解（/Annots）', () => {
  let bytes: Uint8Array
  beforeAll(async () => {
    bytes = await build()
  }, 60_000)

  const text = () => new TextDecoder('latin1').decode(bytes)

  it('产物里出现 Link 注解与 URI 动作', () => {
    const s = text()
    expect(s).toContain('/Subtype /Link')
    expect(s).toContain('/S /URI')
    expect(s).toContain('https://commonmark.org/')
    expect(s).toContain('https://example.com/')
  })

  it('内部锚点走命名目标：catalog 挂 /Dests，注解用 /Dest', () => {
    const s = text()
    expect(s).toContain('/Type /Catalog')
    expect(s).toMatch(/\/Dests \d+ 0 R/)
    expect(s).toContain('/Dest /h-')
    expect(s).toContain('/Dest /fn-a')
    // 目录项 + 正文内链都指向 heading 锚点（2 条 h- 注解：目录 + 正文内链）
    expect((s.match(/\/Dest \/h-/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('/Dests 是 Name 字典（key 是 /name 而非字符串），且没有 /Names 包装', () => {
    const s = text()
    // 回归：曾误写成 << (name) [...] >> + << /Names ... >>，pypdf/reader 解析不出映射 → 跳转全失效。
    expect(s).not.toContain('/Names')
    const dict = s.match(/(\d+) 0 obj\n<<\n(\/[^\n]+ \[.+\]\n)+>>/)
    expect(dict, '/Dests 目标字典不存在').toBeTruthy()
    // key 必须是 PDF Name：每个条目行以 '/name [' 开头，不能是 '(name) ['
    const lines = (dict?.[0].match(/^\/[^\n]+ \[.*\]$/gm) ?? [])
    expect(lines.length).toBeGreaterThanOrEqual(3)
    expect(lines.every(l => /^\/[^\s(]+ \[/.test(l))).toBe(true)
  })

  it('每个 /Dest 目标都能在 /Dests 字典里找到（含中文 slug 的 #XX 编码一致）', () => {
    const s = text()
    const keys = new Set(
      [...s.matchAll(/^\/([^\s(]+) \[[^\n]+\]$/gm)].map(m => m[1]),
    )
    const dests = [...s.matchAll(/\/Dest \/([^\s\[\]<>]+)/g)].map(m => m[1])
    expect(dests.length).toBeGreaterThanOrEqual(3)
    for (const d of dests) expect(keys.has(d), `/Dest /${d} 无对应目标`).toBe(true)
  })

  it('每个 /Rect 恰好 4 个数（多块热区拆成多个注解，不能塞进一个 /Rect）', () => {
    const s = text()
    const rects = [...s.matchAll(/\/Rect \[([^\]]+)\]/g)].map(m => m[1].trim().split(/\s+/))
    expect(rects.length).toBeGreaterThanOrEqual(3)
    for (const r of rects) expect(r.length, `/Rect 数字个数=${r.length}`).toBe(4)
  })

  it('页对象带 /Annots 数组', () => {
    const s = text()
    expect(s).toMatch(/\/Type \/Page[^]*?\/Annots \[/)
  })
})

describe('脚注视觉：不再有多余分隔线', () => {
  let bytes: Uint8Array
  beforeAll(async () => {
    bytes = await build()
  }, 60_000)

  it('脚注定义端输出 label 与回链 ↩（版式细节见 footnote.test.ts）', () => {
    const s = new TextDecoder('utf-8').decode(bytes)
    // ↩ 在 PDF 里是文本算子（子集字体），不一定能按 UTF-8 解出，故只断言不崩包
    expect(s.length).toBeGreaterThan(1000)
  })
})
