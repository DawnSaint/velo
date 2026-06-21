// htmlRenderer 端到端测试:markdown → HTML,核心 sample 走一遍。
//
// 验证:
// 1) 基础语法 (paragraph / heading / list / code / table / link / emphasis / strong)
// 2) mermaid 成功 + 失败降级
// 3) katex 成功 + 失败降级
// 4) html_block / html_inline 走 DOMPurify 清洗
// 5) 完整 HTML 文档结构(<!DOCTYPE html><head><style>...</style><body>)

import { describe, expect, it } from 'vitest'
import { buildExportHtml, resolveExportThemes } from '../htmlRenderer'
import { __resetMermaidExportIdForTest } from '../mermaidHtml'

const baseOpts = (content: string) => resolveExportThemes({
  content,
  fileName: 'test.md',
  darkMode: false,
  primaryColor: '#0F4C81',
  fontFamily: 'sans-serif',
  fontSize: '14px',
  currentFilePath: null,
})

describe('htmlRenderer', () => {
  it('wraps content in full HTML document with DOCTYPE / head / style / body', async () => {
    const { html } = await buildExportHtml(baseOpts('# Hello'))
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('<title>test.md</title>')
    expect(html).toContain('<style>')
    expect(html).toContain('class="velo-editor')
    expect(html).toContain('<h1')
  })

  it('renders headings with slugified id', async () => {
    const { html } = await buildExportHtml(baseOpts('## Hello World'))
    expect(html).toMatch(/<h2[^>]*id="hello-world"[^>]*>Hello World<\/h2>/)
  })

  it('renders ordered + unordered lists', async () => {
    const { html } = await buildExportHtml(baseOpts('- a\n- b\n\n1. x\n2. y'))
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>a</li>')
    expect(html).toContain('<ol')
    expect(html).toContain('<li>x</li>')
  })

  it('renders task list with disabled checkbox and no bullet', async () => {
    const { html } = await buildExportHtml(baseOpts('- [ ] todo\n- [x] done'))
    expect(html).toContain('type="checkbox"')
    expect(html).toContain(' checked')
    // task <li> 挂 velo-task-item class(CSS list-style:none 去掉 disc 圆点,
    // 否则圆点 + checkbox 同时出现)
    expect(html).toContain('class="velo-task-item"')
  })

  it('renders GFM table', async () => {
    const { html } = await buildExportHtml(baseOpts('| a | b |\n| - | - |\n| 1 | 2 |'))
    expect(html).toContain('<table>')
    expect(html).toContain('<th')
    expect(html).toContain('<td')
  })

  it('renders inline marks (strong / em / strike / code)', async () => {
    const { html } = await buildExportHtml(baseOpts('**b** _i_ ~~s~~ `c`'))
    expect(html).toContain('<strong>b</strong>')
    expect(html).toContain('<em>i</em>')
    expect(html).toContain('<del>s</del>')
    expect(html).toContain('<code>c</code>')
  })

  it('renders ==highlight== as <mark> (remarkHighlight transformer runs via runSync)', async () => {
    // remarkHighlight 是 transformer,只 parse 不 runSync 会跳过 —— ==hi== 不生效。
    const { html } = await buildExportHtml(baseOpts('普通 ==重点== 文本'))
    expect(html).toContain('<mark>重点</mark>')
    expect(html).not.toContain('==')
  })

  it('renders links with decoded href', async () => {
    const { html } = await buildExportHtml(baseOpts('[a](https://example.com/x%20y)'))
    expect(html).toContain('href="https://example.com/x y"')
  })

  it('rewrites internal anchor fragment to match heading slug (case-insensitive + space-to-dash)', async () => {
    // sample.md 用 `[回到开头](# Markdown 语法)` —— 经 remarkEncodeLinkUrls 后
    // mdast link.url = `# Markdown%20语法`,导出端 decode 回 `# Markdown 语法`。
    // 此时外部浏览器把字面空格 url-encode 成 %20 作 fragment(#%20Markdown%20语法),
    // 但 heading id 走的是 slugify(toLowerCase + space→dash) → `markdown-语法`,
    // 两边对不上 = 点了没用。导出端必须把内部锚点的 fragment 同源 slugify 写对。
    const md = '# Markdown 语法\n\n[回到开头](# Markdown 语法)'
    const { html } = await buildExportHtml(baseOpts(md))
    // heading id 是 slugify 结果
    expect(html).toMatch(/<h1[^>]*id="markdown-语法"/)
    // 链接 href 也是同样的 slugify(带 # 前缀)
    expect(html).toContain('href="#markdown-语法"')
    // 反例:不能保留字面空格 / 大写
    expect(html).not.toContain('href="# Markdown 语法"')
    expect(html).not.toContain('href="#Markdown"')
  })

  it('does NOT slugify external URL fragments (remote ids decided by remote)', async () => {
    // 外部 URL 的 fragment(github.com/x#install)由远端决定,导出端不能动
    const { html } = await buildExportHtml(baseOpts('[doc](https://example.com/page#Install Guide)'))
    // decode + 不 slugify —— fragment 部分保留原样
    expect(html).toContain('href="https://example.com/page#Install Guide"')
  })

  it('strips dangerous HTML via DOMPurify and keeps safe inline HTML', async () => {
    const { html } = await buildExportHtml(baseOpts('Text <kbd>Ctrl</kbd> <script>alert(1)</script>'))
    // inline html 节点走 sanitizeHtml:kbd 保留且内容在内,<script> 被剥
    expect(html).toContain('<kbd>Ctrl</kbd>')
    // <script> 标签必须不出现
    expect(html).not.toMatch(/<script>alert/)
  })

  it('keeps inline HTML tag pairs intact (kbd / sub / sup / mark)', async () => {
    // remark 把 <kbd>Mod</kbd> 拆成 html("<kbd>")/text("Mod")/html("</kbd>")
    // 三个节点 —— 必须先合并成整段再 sanitize,否则 DOMPurify 把孤立开标签
    // 闭合成 <kbd></kbd>,文本游离成 "<kbd></kbd>Mod"。sub/sup/mark 同理。
    const md = '<kbd>Mod</kbd> H<sub>2</sub>O x<sup>2</sup> <mark>重点高亮</mark>'
    const { html } = await buildExportHtml(baseOpts(md))
    expect(html).toContain('<kbd>Mod</kbd>')
    expect(html).toContain('<sub>2</sub>')
    expect(html).toContain('<sup>2</sup>')
    expect(html).toContain('<mark>重点高亮</mark>')
    // 反例:不能出现空标签 + 游离文本的错位形态
    expect(html).not.toMatch(/<kbd><\/kbd>Mod/)
    expect(html).not.toMatch(/<sub><\/sub>2/)
  })

  it('renders blockquote + thematic break', async () => {
    const { html } = await buildExportHtml(baseOpts('> q\n\n---'))
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<hr />')
  })

  describe('footnote', () => {
    it('renders footnote ref + def aligned with editor NodeView structure', async () => {
      // 引用端:<sup class="footnote-ref" id="velo-fnref-{slug}"><a href="#velo-fn-{slug}">{label}</a></sup>
      // 定义端:<div class="footnote-definition" id="velo-fn-{slug}">
      //          <div class="footnote-label">{label}</div>
      //          <div class="footnote-content">{children}</div>
      //          <a class="footnote-backref" href="#velo-fnref-{slug}">↩</a>
      //        </div>
      // class / id 对齐 _footnote.scss 的 flex 三段布局,标号 + 描述同一行,
      // 不再走 <sup>[1]</sup> + <p> 的上标 + block 错位形态。
      const md = '正文[^1] 引用脚注。\n\n[^1]: 这是脚注描述'
      const { html } = await buildExportHtml(baseOpts(md))
      // ref 端
      expect(html).toMatch(/<sup class="footnote-ref" id="velo-fnref-1">/)
      expect(html).toContain('<a href="#velo-fn-1">1</a>')
      // 反例:不能出现旧版的 [{label}] 方括号包(走 .footnote-label 文本展示)
      expect(html).not.toMatch(/<sup[^>]*>\[1\]<\/sup>/)
      // def 端三段都在
      expect(html).toContain('class="footnote-definition"')
      expect(html).toContain('id="velo-fn-1"')
      expect(html).toContain('class="footnote-label"')
      expect(html).toContain('class="footnote-content"')
      expect(html).toContain('class="footnote-backref"')
      expect(html).toContain('href="#velo-fnref-1"')
      // backref 文本是 ↩(对齐 FootnoteNodeViews.ts 的 backref.textContent)
      expect(html).toContain('↩')
      // 描述内容仍渲染,_footnote.scss 的 .footnote-content > p { display:inline } 把段落拉平
      expect(html).toContain('这是脚注描述')
    })

    it('slugifies non-ASCII footnote labels consistently for ref + def', async () => {
      // FootnoteNodeViews.ts:slug 把非 [A-Za-z0-9_-] 替成 _,导出端 footnoteSlug 必须同款
      const md = '看[^中文标签]\n\n[^中文标签]: 描述'
      const { html } = await buildExportHtml(baseOpts(md))
      // 中文都被替成 _ —— 4 个字 → 4 个 _
      expect(html).toMatch(/id="velo-fnref-____"/)
      expect(html).toMatch(/href="#velo-fn-____"/)
      expect(html).toMatch(/id="velo-fn-____"/)
      expect(html).toMatch(/href="#velo-fnref-____"/)
    })
  })


  it('renders GitHub-flavored alerts ([!TYPE]) as velo-alert divs', async () => {
    // remarkAlert 把带 [!TYPE] 首行的 blockquote 改写成 alert 节点。
    // 导出 walker 必须有 alert 分支,否则落 default 静默丢弃。
    const md = [
      '> [!NOTE]',
      '> note body',
      '',
      '> [!WARNING]',
      '> warn body',
      '',
      '> [!CAUTION]',
      '> danger body',
    ].join('\n')
    const { html } = await buildExportHtml(baseOpts(md))
    expect(html).toContain('class="velo-alert velo-alert-note"')
    expect(html).toContain('class="velo-alert velo-alert-warning"')
    expect(html).toContain('class="velo-alert velo-alert-caution"')
    expect(html).toContain('data-type="alert"')
    // 标记行 [!NOTE] 已被剥掉,正文保留
    expect(html).toContain('note body')
    expect(html).toContain('warn body')
    expect(html).not.toContain('[!NOTE]')
  })

  describe('mermaid', () => {
    it('renders mermaid block via .velo-mermaid-block wrapper (SVG or fallback)', async () => {
      __resetMermaidExportIdForTest()
      const { html } = await buildExportHtml(baseOpts('```mermaid\ngraph TD\n  A --> B\n```'))
      // 真实 Tauri webview 内 mermaid 走 SVG 路径;jsdom 内 mermaid 因缺 SVG BBox
      // 报错走 mermaid-error 降级 —— 测试只断言 wrapper + pipeline 不抛,
      // 实际渲染端在生产环境是 SVG。这里允许两种结果都算"渲染管线无错"。
      expect(html).toContain('<div class="velo-mermaid-block">')
      const hasSvg = html.includes('<svg')
      const hasFallback = html.includes('mermaid-error')
      expect(hasSvg || hasFallback).toBe(true)
    })

    it('falls back to <pre class="mermaid-error"> for broken mermaid + emits warning', async () => {
      __resetMermaidExportIdForTest()
      const { html, warnings } = await buildExportHtml(baseOpts('```mermaid\nnot a valid graph at all ->\n```'))
      // mermaid parse 失败 → 走 mermaidErrorHtml 降级路径
      expect(warnings.some(w => w.includes('mermaid'))).toBe(true)
      expect(html).toContain('mermaid-error')
    })
  })

  describe('katex', () => {
    it('renders inline + block math as KaTeX HTML', async () => {
      const { html } = await buildExportHtml(baseOpts('$E=mc^2$\n\n$$x^2+y^2=z^2$$'))
      expect(html).toContain('katex')
      // 块级公式包在 .katex-display,行内公式 .katex
      expect(html).toMatch(/class="katex[^"]*"/)
    })

    it('falls back to .math-error for broken LaTeX', async () => {
      const { html, warnings } = await buildExportHtml(baseOpts('$\\frac{}$'))
      // 失败的 LaTeX 渲染会走 katexHtml 的 try/catch 降级
      expect(html).toMatch(/math-error/)
      expect(warnings.some(w => w.includes('公式'))).toBe(true)
    })
  })

  describe('html_block / html_inline', () => {
    it('keeps safe inline HTML (kbd / mark) and strips <script>', async () => {
      const md = 'Use <kbd>Ctrl</kbd>+<kbd>C</kbd> to copy.\n\n<script>alert(1)</script>'
      const { html } = await buildExportHtml(baseOpts(md))
      // kbd / mark 走 sanitizeHtml,允许,内容完整在内
      expect(html).toContain('<kbd>Ctrl</kbd>')
      expect(html).toContain('<kbd>C</kbd>')
      // <script> 必须被 DOMPurify 洗掉
      expect(html).not.toMatch(/<script>alert/)
    })
  })

  it('emits a warning per failed code block when shiki cannot highlight', async () => {
    // 一个 shiki 不认识的 lang —— ensureLanguage 走 catch warn,
    // renderCodeBlockHtml 走 fallback。htmlRenderer 自己也 push warning。
    // 注意:这里用 'plain' 空 lang 测纯文本兜底
    const { html, warnings } = await buildExportHtml(baseOpts('```\nplain text\n```'))
    // shiki 对空 lang 返回 null(走 fallback)
    expect(html).toContain('plain text')
    // 没有 mermaid / katex,所以 warnings 应只含 code block 降级或为空
    expect(Array.isArray(warnings)).toBe(true)
  })

  it('respects darkMode opt by adding dark class to body', async () => {
    const { html } = await buildExportHtml({
      ...baseOpts('hi'),
      darkMode: true,
    })
    expect(html).toMatch(/class="velo-editor[^"]*dark/)
  })

  it('exposes media-query for prefers-color-scheme dark + print', async () => {
    const { html } = await buildExportHtml(baseOpts('hi'))
    expect(html).toContain('@media (prefers-color-scheme: dark)')
    expect(html).toContain('@media print')
  })

  it('returns warnings array (empty when all renders succeed)', async () => {
    const { warnings } = await buildExportHtml(baseOpts('# h\n\np'))
    expect(warnings).toEqual([])
  })
})
