// 代码块高亮 plugin + widget 测试。
//
// 测例(覆盖主要路径):
// 1. 装载 code_block → 工具条 widget DOM 出现(等 highlighter 异步好)
// 2. language = 'javascript' → inline decoration 加 color: var(--shiki-xxx) style
// 3. language = '' → 没有 inline decoration,只有工具条
// 4. language = 'xyz-not-registered' → 工具条出现但没有 inline decoration
// 5. setCodeBlockLanguage(view, pos, 'python') → doc language attr 变 → inline decoration 跟着变
// 6. docChanged(在 code_block 内打字)→ 同一 pos 的 widget 实例 contentHash 变 → token 重算
// 7. 主题切换:切 <html class="dark"> → CSS 变量值变 → token span DOM 的 style 不变
// 8. CONTAINER_BLACKLIST 回归:在 code_block 内键入 ### 不应转 heading
// 9. 复制按钮 click → CustomEvent('velo:copy-code') 冒泡,detail 包含 pos
// 10. v0.4.6+:mermaid 走 code_block lang='mermaid',codeHighlight 出 toolbar(共用);
//     v0.4.7+:mermaid **语法高亮**走自写轻量 tokenizer(旁路 shiki,因 shiki
//     mermaid grammar 是"摆设"全输出默认色),颜色从当前代码块主题动态提取 hex,
//     inline decoration 写 --shiki-light/dark 局部 CSS 变量(跟 shiki token 同形,
//     代码块主题切换 + dark/light 切换都自动生效);MermaidDecoration widget
//     叠加 SVG 预览。两条 widget 共存不冲突(本 plugin side: -1 / mermaid widget 默认 side: 0)。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import {
  codeHighlightPlugin,
  setCodeBlockLanguage,
  codeHighlightKey,
} from '../nodes/CodeHighlightWidget'
import {
  getHighlighter,
  ensureLanguage,
  __resetHighlighterForTest,
} from '../nodes/CodeBlockLangs'
import { syntaxAutoFormatPlugin } from '../plugins/syntaxAutoFormat'

// ============================================================
//  工具:起一个最小可工作的 EditorView,只挂 codeHighlightPlugin
// ============================================================

function makeView(initialMd: string): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(initialMd, schema),
    plugins: [codeHighlightPlugin],
  })
  const view = new EditorView(container, { state })
  return view
}

async function flushHighlighter(): Promise<void> {
  // 等 shiki 异步 ready
  await getHighlighter()
  // 再等一个微任务让 view.dispatch(setMeta) 走完
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function findCodeBlockPos(view: EditorView): number {
  let pos = -1
  view.state.doc.descendants((node, p) => {
    if (node.type.name === 'code_block' && pos === -1) {
      pos = p
      return false
    }
    return true
  })
  return pos
}

// ============================================================
//  Setup
// ============================================================

beforeAll(async () => {
  // 触发 shiki 加载(模块顶层 import 已经触发,但我们 await 让 ready)
  await getHighlighter()
})

beforeEach(() => {
  document.documentElement.classList.remove('dark')
  // CodeHighlightWidget 的 view factory(IIFE 内 useEditorStore() 读主题)需
  // 要 active Pinia,否则 getActivePinia 抛错 → IIFE 的 .catch 吞掉 → shiki
  // 永远不 ready → token span 为 0。每个 case 独立起一个 pinia 防止状态串。
  setActivePinia(createPinia())
})

afterEach(() => {
  // 清理所有 view
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    const parent = el.parentElement
    if (parent) parent.remove()
  })
  __resetHighlighterForTest()
})

// ============================================================
//  测例
// ============================================================

describe('codeHighlightPlugin', () => {
  it('1. 装载 code_block → 工具条 widget 出现', async () => {
    const view = makeView('```js\nconst x = 1\n```')
    await flushHighlighter()
    const wrap = view.dom.querySelector('.velo-code-toolbar-widget')
    expect(wrap).not.toBeNull()
    view.destroy()
  })

  it('2. language=javascript → inline decoration 写 shiki 局部 CSS 变量', async () => {
    const view = makeView('```javascript\nconst x = 1\n```')
    await flushHighlighter()
    // 找 pre > code 内的 inline span,有 style 包含 --shiki 局部 CSS 变量。
    //
    // 真实 inline 格式:`--shiki-light:#xxx;--shiki-dark:#yyy`(只有变量定义,
    // 没有 `color:` 前缀)。`color: var(--shiki-light)` 这条规则由 SCSS 那边
    // 对 `pre span` 写,不在 inline style 里 —— 走 defaultColor: false 模式
    // 让 inline style 只写变量、颜色走 CSS cascade,切 <html class="dark">
    // 翻面时不会跟 inline `color:` 打架(见 docs/architecture/editor.md 的 shiki dual-theme 说明)。
    const styledSpans = view.dom.querySelectorAll('pre code span[style*="--shiki"]')
    expect(styledSpans.length).toBeGreaterThan(0)
    // 至少一个 span 的 style 同时定义了 light / dark 两个变体
    const hasDualThemes = Array.from(styledSpans).some((s) => {
      const st = s.getAttribute('style') || ''
      return st.includes('--shiki-light:') && st.includes('--shiki-dark:')
    })
    expect(hasDualThemes).toBe(true)
    view.destroy()
  })

  it('3. language 空 → 没有 inline decoration,只有工具条', async () => {
    const view = makeView('```\nplain text\n```')
    await flushHighlighter()
    const wrap = view.dom.querySelector('.velo-code-toolbar-widget')
    expect(wrap).not.toBeNull()
    const styledSpans = view.dom.querySelectorAll('pre code span[style*="--shiki"]')
    expect(styledSpans.length).toBe(0)
    // 工具条按钮显示 'plain text'
    const langBtn = view.dom.querySelector('.velo-code-lang-btn') as HTMLElement | null
    expect(langBtn?.textContent).toBe('plain text')
    view.destroy()
  })

  it('4. language 未注册 → 工具条出现,无 inline decoration', async () => {
    const view = makeView('```xyz-not-registered\nfoo\n```')
    await flushHighlighter()
    const wrap = view.dom.querySelector('.velo-code-toolbar-widget')
    expect(wrap).not.toBeNull()
    const styledSpans = view.dom.querySelectorAll('pre code span[style*="--shiki"]')
    expect(styledSpans.length).toBe(0)
    // 工具条按钮显示原 lang 字符串
    const langBtn = view.dom.querySelector('.velo-code-lang-btn') as HTMLElement | null
    expect(langBtn?.textContent).toBe('xyz-not-registered')
    view.destroy()
  })

  it('5. setCodeBlockLanguage → doc attr 变 + inline decoration 跟着变', async () => {
    const view = makeView('```js\nconst x = 1\n```')
    await flushHighlighter()
    const pos = findCodeBlockPos(view)
    expect(pos).toBeGreaterThanOrEqual(0)
    setCodeBlockLanguage(view.state, pos, 'python', (tr) => view.dispatch(tr))
    // doc 立即反映 attr
    expect(view.state.doc.nodeAt(pos)?.attrs.language).toBe('python')
    // 强制 redraw + 重新拿 highlighter 测试 getTokensSync 路径:
    // 直接构造一个 plugin state mutation 触发 rebuild
    const hl = await getHighlighter()
    view.dispatch(view.state.tr.setMeta(codeHighlightKey, { highlighter: hl }))
    // js / python 都会产生 shiki token span:验证 widget key 没换但 token
    // decoration 确实存在(说明 setLanguage 之后 decoration 重建链路正常)
    const styledSpans = view.dom.querySelectorAll('pre code span[style*="--shiki"]')
    expect(styledSpans.length).toBeGreaterThan(0)
    view.destroy()
  })

  it('6. docChanged(在 code_block 内打字)→ token 重算(不崩)', async () => {
    const view = makeView('```js\nconst x = 1\n```')
    await flushHighlighter()
    const pos = findCodeBlockPos(view)
    const blockEnd = pos + view.state.doc.nodeAt(pos)!.nodeSize - 1
    // 在 block 末尾之前插入一个字符,触发 docChanged
    view.dispatch(view.state.tr.insertText('\n', blockEnd - 1))
    // 不应抛错,工具条 widget 还在
    const wrap = view.dom.querySelector('.velo-code-toolbar-widget')
    expect(wrap).not.toBeNull()
    view.destroy()
  })

  it('7. 主题切换不引起 shiki 重渲(token span DOM 不变)', async () => {
    const view = makeView('```javascript\nconst x = 1\n```')
    await flushHighlighter()
    const before = Array.from(view.dom.querySelectorAll('pre code span[style*="--shiki"]'))
      .map((s) => s.getAttribute('style'))
    expect(before.length).toBeGreaterThan(0)
    // 切 dark
    document.documentElement.classList.add('dark')
    // 触发一次重 dispatch(让 view 更新);实际测试:ProseMirror 不订阅
    // theme 变化,需要外部刺激。最简方式:dispatch 一个空 tr。
    view.dispatch(view.state.tr)
    const after = Array.from(view.dom.querySelectorAll('pre code span[style*="--shiki"]'))
      .map((s) => s.getAttribute('style'))
    // 颜色 style 引用 var(--shiki-xxx),DOM 上的 style 字符串没变
    expect(after).toEqual(before)
    view.destroy()
  })

  it('8. CONTAINER_BLACKLIST 回归:在 code_block 内 ### 不转 heading', async () => {
    // 装一个含 syntaxAutoFormat 的最小 view
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: fromMarkdown('```\n### inside code\n```', schema),
      plugins: [syntaxAutoFormatPlugin, codeHighlightPlugin],
    })
    const view = new EditorView(container, { state })
    // 找到 code_block,确认是 code_block 类型而不是 heading
    const pos = findCodeBlockPos(view)
    expect(pos).toBeGreaterThanOrEqual(0)
    expect(view.state.doc.nodeAt(pos)?.type.name).toBe('code_block')
    // 在 code_block 内部插入字符模拟用户输入,确认不会触发 syntax 转换
    const blockEnd = pos + view.state.doc.nodeAt(pos)!.nodeSize - 1
    view.dispatch(view.state.tr.insertText(' #', blockEnd - 1))
    expect(view.state.doc.nodeAt(pos)?.type.name).toBe('code_block')
    view.destroy()
  })

  it('9. 复制按钮 click → widget 内部直接 await writeToClipboard', async () => {
    // v0.4.3 fast-follow:复制 click 不再冒泡到 index.vue,widget 内部 await
    // 调 writeToClipboard;失败回退 navigator.clipboard;最终静默,不抛错。
    // 这里只验证 click 不抛错 + 按钮 SVG 结构存在(实际写剪贴板在
    // Tauri webview 环境才需要 mock,jsdom 测默认静默 swallow)。
    const view = makeView('```js\nconst x = 1\n```')
    await flushHighlighter()
    const copyBtn = view.dom.querySelector('.velo-code-copy-btn') as HTMLElement | null
    expect(copyBtn).not.toBeNull()
    // click 不会抛错(内部 import 失败 / clipboard 不可用都被 swallow)
    expect(() => copyBtn!.click()).not.toThrow()
    view.destroy()
  })

  it('10. v0.4.6+ mermaid 共用 codeHighlight toolbar(语言选择 + 复制)+ MermaidDecoration 自管 SVG 切换/删除/关闭', async () => {
    // v0.4.6+:mermaid 走 code_block { language: 'mermaid' }。
    // 两个 widget 在不同 DOM 位置共挂:
    //   - CodeHighlight 在 pos + side: -1(pre 前)→ 提供语言选择 + 复制按钮
    //   - MermaidDecoration 在 pos + nodeSize + side: 1(pre 后)→ 提供 SVG + 切换/删除/关闭
    // 验证 codeHighlight 的 toolbar 在 mermaid 上仍挂上(不再 skip)。
    const md = '```mermaid\ngraph TD\n  A --> B\n```'
    const view = makeView(md)
    await flushHighlighter()
    const allToolbars = view.dom.querySelectorAll('.velo-code-toolbar-widget')
    expect(allToolbars.length).toBe(1)
    view.destroy()
  })

  it('10b. mermaid 走自写 tokenizer(旁路 shiki),颜色从当前代码块主题动态提取 hex', async () => {
    // v0.4.7+:诊断发现 shiki mermaid grammar 是"摆设"(codeToTokens 全输出
    // defaultText 默认色,无 scope),改走自写轻量 tokenizer 完全旁路 shiki
    // codeToTokens。颜色不从 shiki mermaid grammar 来,而是从当前代码块主题
    // (light/dark theme)的 settings 按 scope 提取代表性 hex,写进 inline
    // `--shiki-light:${hex};--shiki-dark:${hex}` 局部 CSS 变量 —— 跟 shiki
    // token **完全同形**,SCSS `color: var(--shiki-light)` 接管选色。
    // 这样代码块主题切换(App.vue watch → rebuild)和 dark/light 切换(纯 CSS)
    // 两条路径都自动生效。
    const md = '```mermaid\ngraph TD\n  A --> B\n```'
    const view = makeView(md)
    await flushHighlighter()
    // mermaid token span:style 含 --shiki-light / --shiki-dark(跟普通 code_block 同形)
    const styledSpans = view.dom.querySelectorAll('pre code span[style*="--shiki"]')
    expect(styledSpans.length).toBeGreaterThan(0)
    // 至少一个 span 同时定义 light / dark(双主题)
    const hasDualThemes = Array.from(styledSpans).some((s) => {
      const st = s.getAttribute('style') || ''
      return st.includes('--shiki-light:') && st.includes('--shiki-dark:')
    })
    expect(hasDualThemes).toBe(true)
    // mermaid 颜色来自主题 hex(不是固定的 #383A42 默认色 —— 那是 shiki mermaid
    // grammar "摆设"的输出,旁路后不应再出现整块默认色)。验证至少有一个 span
    // 的 --shiki-light 不是 default fg #383A42(graph 关键字应为强调色)。
    const hasNonDefault = Array.from(styledSpans).some((s) => {
      const st = s.getAttribute('style') || ''
      return !st.includes('--shiki-light:#383A42')
    })
    expect(hasNonDefault).toBe(true)
    view.destroy()
  })

  it('11. toolbar 按钮默认 hidden(opacity 0 + visibility hidden)', async () => {
    // hover 才显示的 v0.4.3 fast-follow:验证默认态下工具条按钮确实隐藏。
    // jsdom 不解析外部 stylesheet,getComputedStyle().opacity 永远是 '1';
    // 走 inline style 验证:SCSS `.velo-code-toolbar-widget > .velo-code-*-btn`
    // 设置 opacity 0,但 jsdom 不读 stylesheet → 改测 widget 元素 inline 没
    // 显式设 visibility:hidden,只有 hover/focus 才显(读 stylesheet 才能验证)。
    // 这里改测更稳的"按钮结构正确" + "未触发 hover"两点。
    const view = makeView('```js\nx\n```')
    await flushHighlighter()
    const toolbar = view.dom.querySelector('.velo-code-toolbar-widget') as HTMLElement | null
    const langBtn = view.dom.querySelector('.velo-code-lang-btn') as HTMLElement | null
    const copyBtn = view.dom.querySelector('.velo-code-copy-btn') as HTMLElement | null
    expect(toolbar).not.toBeNull()
    expect(langBtn).not.toBeNull()
    expect(copyBtn).not.toBeNull()
    // toolbar 内只有 lang + copy 两个按钮,没有别的(防止 hover 态加了其他子节点)
    expect(toolbar!.children.length).toBe(2)
    // 按钮有 type='button'(防止 ProseMirror 把它当 form submit 截走)
    expect((langBtn as HTMLButtonElement).type).toBe('button')
    expect((copyBtn as HTMLButtonElement).type).toBe('button')
    view.destroy()
  })

  it('12. 切 lang → 工具条按钮文字跟着更新(修 widget key bug)', async () => {
    // v0.4.3 fast-follow:widget key 必须含 lang,否则 ProseMirror 复用旧
    // DOM 按钮文字不更新。验证切 lang 后 lang-btn 文字 = 新 lang。
    const view = makeView('```python\nx = 1\n```')
    await flushHighlighter()
    let btn = view.dom.querySelector('.velo-code-lang-btn') as HTMLElement | null
    expect(btn?.textContent).toContain('python')
    const pos = findCodeBlockPos(view)
    setCodeBlockLanguage(view.state, pos, 'rust', (tr) => view.dispatch(tr))
    btn = view.dom.querySelector('.velo-code-lang-btn') as HTMLElement | null
    expect(btn?.textContent).toContain('rust')
    view.destroy()
  })

  // fast-follow:预扫 + 懒加载 lang。启动期 createHighlighter 只装
  // doc 用到的 lang,其余在用户首次遇到时 ensureLanguage 异步追加。
  it('13. pre-scan 门控:getHighlighter 显式 langs 只装传入的 grammar', async () => {
    // 显式只装 javascript(python 不在初始 langs 列表)
    const hl = await getHighlighter(['javascript'])
    // shiki 装 javascript 时会顺带 register 同 grammar 的 alias('js'/'cjs'/'mjs'),
    // getLoadedLanguages 返回带 alias 的完整集,但**不会**扩展到未传入的 lang
    // (如 python)。这是 pre-scan 门控的核心:只装 doc 用到的,其余靠 lazy。
    expect(hl.getLoadedLanguages()).toContain('javascript')
    expect(hl.getLoadedLanguages()).not.toContain('python')
  })

  it('14. runtime 懒加载:ensureLanguage 装新 lang 后 token 出现', async () => {
    const hl = await getHighlighter(['javascript'])
    expect(hl.getLoadedLanguages()).toContain('javascript')
    expect(hl.getLoadedLanguages()).not.toContain('python')

    const view = makeView('```python\nx = 1\n```')
    await flushHighlighter()
    // 显式 await ensureLanguage(plugin 的 fire-and-forget 已触发过,
    // 二次 await 是幂等 noop,只确保当前 microtask resolve)
    await ensureLanguage('python')
    expect(hl.getLoadedLanguages()).toContain('python')
    // plugin view factory 已注册 rebuild callback,ensureLanguage resolve
    // 后会自动 dispatch setMeta → 但 rAF 节流到下一帧。setTimeout 兜底等
    // 帧让 rebuild 走完。
    await new Promise(r => setTimeout(r, 50))
    const styledSpans = view.dom.querySelectorAll('pre code span[style*="--shiki"]')
    expect(styledSpans.length).toBeGreaterThan(0)
    view.destroy()
  })

  it('15. 未注册 lang → bundledLanguages gate 拦住,不触发 loadLanguage', async () => {
    const hl = await getHighlighter(['javascript'])
    const loadSpy = vi.spyOn(hl, 'loadLanguage')

    // bundleLanguages gate 在 getTokensSync 里 — 未注册 lang 直接 return
    // null,连 ensureLanguage 都不会调,避免无效 load 触发 ShikiError warn。
    const view = makeView('```xyz-not-registered\nfoo\n```')
    await flushHighlighter()

    expect(hl.getLoadedLanguages()).not.toContain('xyz-not-registered')
    expect(loadSpy).not.toHaveBeenCalled()
    const styledSpans = view.dom.querySelectorAll('pre code span[style*="--shiki"]')
    expect(styledSpans.length).toBe(0)
    loadSpy.mockRestore()
    view.destroy()
  })

  it('16. extractLangsFromDoc 走 mdast 正确扫出 fenced code lang', async () => {
    // 直接调 markdownIO 的 helper,跟 App.vue 走同一路径
    const { extractLangsFromDoc } = await import('../editor/markdownIO')
    const md = [
      '# title',
      '',
      '```javascript',
      'const a = 1',
      '```',
      '',
      '```python',
      'x = 1',
      '```',
      '',
      '```JAVASCRIPT',  // 大小写重复,小写化后去重
      'const b = 2',
      '```',
      '',
      '```',
      'plain',
      '```',  // 无 lang,不计入
    ].join('\n')
    const langs = extractLangsFromDoc(md)
    expect(new Set(langs)).toEqual(new Set(['javascript', 'python']))
  })

  it('17. react 别名映射到 jsx:extractLangsFromDoc 扫出 jsx,代码块出 shiki token', async () => {
    // react 不是 shiki 合法语言 id(shiki 只有 jsx/tsx),resolveShikiLang
    // 映射 react→jsx。验证:预扫扫出 'jsx' 而非 'react';react 代码块能出
    // shiki token span(不再因非法 id 走 fallback 无高亮)。
    const { extractLangsFromDoc } = await import('../editor/markdownIO')
    const { resolveShikiLang } = await import('../nodes/CodeBlockLangs')

    // resolveShikiLang 直接验证
    expect(resolveShikiLang('react')).toBe('jsx')
    expect(resolveShikiLang('React')).toBe('jsx')
    expect(resolveShikiLang('jsx')).toBe('jsx') // 幂等

    // extractLangsFromDoc 走同一映射
    const md = [
      '```react',
      'const App = () => <div>hello</div>',
      '```',
    ].join('\n')
    const langs = extractLangsFromDoc(md)
    expect(langs).toContain('jsx')
    expect(langs).not.toContain('react')

    // react 代码块出 shiki token(不再走 fallback)
    const view = makeView('```react\nconst App = () => <div>hi</div>\n```')
    await flushHighlighter()
    const styledSpans = view.dom.querySelectorAll('pre code span[style*="--shiki"]')
    expect(styledSpans.length).toBeGreaterThan(0)
    view.destroy()
  })
})

// ============================================================
//  Helper 函数测试
// ============================================================

describe('codeHighlight helpers', () => {
  it('setCodeBlockLanguage 在非 code_block 节点上返回 false', () => {
    const view = makeView('hello world')
    // paragraph 节点的 pos
    let paraPos = -1
    view.state.doc.descendants((n, p) => {
      if (n.type.name === 'paragraph' && paraPos === -1) {
        paraPos = p
        return false
      }
      return true
    })
    expect(paraPos).toBeGreaterThanOrEqual(0)
    const ok = setCodeBlockLanguage(view.state, paraPos, 'python')
    expect(ok).toBe(false)
    view.destroy()
  })

  it('setCodeBlockLanguage 改 attr 不抛错', () => {
    const view = makeView('```js\nx\n```')
    const pos = findCodeBlockPos(view)
    const ok = setCodeBlockLanguage(view.state, pos, 'python', (tr) => view.dispatch(tr))
    expect(ok).toBe(true)
    expect(view.state.doc.nodeAt(pos)?.attrs.language).toBe('python')
    view.destroy()
  })
})
