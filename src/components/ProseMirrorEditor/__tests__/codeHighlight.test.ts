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
// 10. v0.4.6+:mermaid 走 code_block lang='mermaid',codeHeader 对 mermaid 跳过
//     (由 MermaidDecoration 自带 toolbar 接管,避免双层 header);v0.4.7+:mermaid
//     **语法高亮**走自写轻量 tokenizer(旁路 shiki,因 shiki mermaid grammar 是
//     "摆设"全输出默认色),颜色从当前代码块主题动态提取 hex,inline decoration
//     写 --shiki-light/dark 局部 CSS 变量(跟 shiki token 同形,代码块主题切换 +
//     dark/light 切换都自动生效);MermaidDecoration widget 叠加 SVG 预览。
//     两条 widget 共存不冲突(code header 跳过 / MermaidDecoration widget 默认 side: 0)。

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
import { foldDecoration, foldKey } from '../nodes/FoldDecoration'
import { mermaidDecoration, mermaidDecoKey } from '../nodes/MermaidDecoration'
import { frontmatterNodeViewPlugin } from '../nodes/FrontmatterNodeView'

// ★ stub mermaid:真实包 ~3MB,jsdom 执行顶层代码阻塞主线程 → 本测只关心
// code header 联动 editNodeSet,不需要真渲染 SVG。vi.mock 工厂让 getMermaid()
// 立即 resolve 一个 noop 实例,把 import 代价降到近零。
vi.mock('mermaid', () => {
  const noop = (): Promise<void> => Promise.resolve()
  return {
    default: {
      initialize: noop,
      parse: () => Promise.resolve(),
      render: () => Promise.resolve({ svg: '<svg></svg>', bindFunctions: undefined }),
    },
  }
})

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

// 双插件 view:同时挂 codeHighlight + mermaidDecoration,方能驱动 mermaid 的
// 展开/收起态(editNodeSet)来验证 code header 联动。
function makeViewWithMermaid(initialMd: string): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(initialMd, schema),
    plugins: [codeHighlightPlugin, mermaidDecoration],
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

function findFrontmatterPos(view: EditorView): number {
  let pos = -1
  view.state.doc.descendants((node, p) => {
    if (node.type.name === 'frontmatter' && pos === -1) {
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
    const wrap = view.dom.querySelector('.velo-code-header-widget')
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
    const wrap = view.dom.querySelector('.velo-code-header-widget')
    expect(wrap).not.toBeNull()
    const styledSpans = view.dom.querySelectorAll('pre code span[style*="--shiki"]')
    expect(styledSpans.length).toBe(0)
    // 语言输入框值为空(plain text)
    const langInput = view.dom.querySelector('.velo-code-lang-input') as HTMLInputElement | null
    expect(langInput?.value).toBe('')
    view.destroy()
  })

  it('4. language 未注册 → 工具条出现,无 inline decoration', async () => {
    const view = makeView('```xyz-not-registered\nfoo\n```')
    await flushHighlighter()
    const wrap = view.dom.querySelector('.velo-code-header-widget')
    expect(wrap).not.toBeNull()
    const styledSpans = view.dom.querySelectorAll('pre code span[style*="--shiki"]')
    expect(styledSpans.length).toBe(0)
    // 语言输入框值 = 原 lang 字符串
    const langInput = view.dom.querySelector('.velo-code-lang-input') as HTMLInputElement | null
    expect(langInput?.value).toBe('xyz-not-registered')
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
    const wrap = view.dom.querySelector('.velo-code-header-widget')
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
    const copyBtn = view.dom.querySelector('[data-testid="code-copy-btn"]') as HTMLElement | null
    expect(copyBtn).not.toBeNull()
    // click 不会抛错(内部 import 失败 / clipboard 不可用都被 swallow)
    expect(() => copyBtn!.click()).not.toThrow()
    view.destroy()
  })

  it('10. v0.4.6+ mermaid 的 code header 联动展开态:收起态隐藏,展开态显示但 fold chevron 隐藏', async () => {
    // v0.4.6+:mermaid 走 code_block { language: 'mermaid' }。
    // 修复前 code header 对 mermaid 总是挂上,收起态(显示 SVG + MermaidDecoration
    // 自带切换/删除 toolbar)上方孤零零浮一个 header,形成双层header。
    // 修复后:header 联动 mermaid 展开态(editNodeSet)—— 收起态跳过,
    // 展开态(源码可见)仍保留 header(语言选择 + 复制可用)。
    // token 着色旁路(测例 10b)不受影响(跳 header 不上诉 token decoration)。
    //
    // 方案 A:展开态 header 的 fold chevron 隐藏 —— 避免手闲点 fold 误触发
    // FoldDecoration 折叠 code_block → isMermaidFolded 把 SVG 也吞掉;mermaid 的
    // "收"由 mermaid toolbar toggle 承担,header 提供 fold 入口只会有害。
    const md = '```mermaid\ngraph TD\n  A --> B\n```'
    const view = makeViewWithMermaid(md)
    await flushHighlighter()
    const pos = findCodeBlockPos(view)
    expect(pos).toBeGreaterThanOrEqual(0)

    // 1. 收起态(默认,显示 SVG,源码隐藏)→ header 隐藏
    expect(view.dom.querySelectorAll('.velo-code-header-widget').length).toBe(0)

    // 2. 展开:dispatch setMeta toggleEditAt(absolutePos = pos + 1)→ editNodeSet 加入
    const absolutePos = pos + 1
    view.dispatch(view.state.tr.setMeta(mermaidDecoKey, { toggleEditAt: absolutePos }))
    // 展开态(源码可见)→ header 显示,但 fold chevron 必须隐藏
    expect(view.dom.querySelectorAll('.velo-code-header-widget').length).toBe(1)
    expect(view.dom.querySelectorAll('.velo-code-fold-btn').length).toBe(0)
    // 语言选择 + 复制仍可用
    expect(view.dom.querySelector('.velo-code-lang-input')).not.toBeNull()
    expect(view.dom.querySelector('[data-testid="code-copy-btn"]')).not.toBeNull()

    // 3. 收起:再次 toggle → editNodeSet 移除 → header 隐藏
    view.dispatch(view.state.tr.setMeta(mermaidDecoKey, { toggleEditAt: absolutePos }))
    expect(view.dom.querySelectorAll('.velo-code-header-widget').length).toBe(0)

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

  it('11. header 始终可见(非 hover-gated),含 fold + lang input + wrap + 行号 + copy', async () => {
    // header 取代旧 hover-gated toolbar,始终可见。
    // 验证结构正确:fold chevron + lang input wrap + fold-info + wrap + 行号 + copy。
    // 行号 toggle 是 b15dcac 把行号从全局设置改成 per-block 开关时加进来的第 6 个子节点。
    const view = makeView('```js\nx\n```')
    await flushHighlighter()
    const header = view.dom.querySelector('.velo-code-header-widget') as HTMLElement | null
    const foldBtn = view.dom.querySelector('.velo-code-fold-btn') as HTMLElement | null
    const langInputWrap = view.dom.querySelector('.velo-code-lang-input-wrap') as HTMLElement | null
    const wrapBtn = view.dom.querySelector('.velo-code-wrap-btn') as HTMLElement | null
    const lineBtn = view.dom.querySelector('.velo-code-line-btn') as HTMLElement | null
    const copyBtn = view.dom.querySelector('[data-testid="code-copy-btn"]') as HTMLElement | null
    expect(header).not.toBeNull()
    expect(foldBtn).not.toBeNull()
    expect(langInputWrap).not.toBeNull()
    expect(wrapBtn).not.toBeNull()
    expect(lineBtn).not.toBeNull()
    expect(copyBtn).not.toBeNull()
    // header 内有 fold + lang-input-wrap + fold-info + wrap + 行号 + copy 六个子节点
    expect(header!.children.length).toBe(6)
    // 按钮有 type='button'(防止 ProseMirror 把它当 form submit 截走)
    expect((foldBtn as HTMLButtonElement).type).toBe('button')
    expect((copyBtn as HTMLButtonElement).type).toBe('button')
    expect((lineBtn as HTMLButtonElement).type).toBe('button')
    // lang input wrap 内含 icon span + input
    const langInput = langInputWrap!.querySelector('.velo-code-lang-input') as HTMLInputElement | null
    expect(langInput).not.toBeNull()
    expect(langInput!.value).toBe('js')
    // data-fold-state 默认 expanded
    expect(header!.getAttribute('data-fold-state')).toBe('expanded')
    view.destroy()
  })

  it('12. 切 lang → 输入框值跟着更新(修 widget key bug)', async () => {
    // v0.4.3 fast-follow:widget key 必须含 lang,否则 ProseMirror 复用旧
    // DOM 输入框值不更新。验证切 lang 后 input value = 新 lang。
    const view = makeView('```python\nx = 1\n```')
    await flushHighlighter()
    let input = view.dom.querySelector('.velo-code-lang-input') as HTMLInputElement | null
    expect(input?.value).toBe('python')
    const pos = findCodeBlockPos(view)
    setCodeBlockLanguage(view.state, pos, 'rust', (tr) => view.dispatch(tr))
    input = view.dom.querySelector('.velo-code-lang-input') as HTMLInputElement | null
    expect(input?.value).toBe('rust')
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

  // Front Matter YAML 语法高亮(#frontmatter-enhance):frontmatter 节点始终走
  // yaml grammar,复用 dual-theme --shiki-light/dark inline decoration。
  it('18. frontmatter 节点走 yaml 高亮:复用 dual-theme inline decoration', async () => {
    const md = '---\ntitle: Hello\ndate: 2026-07-10\ntags:\n  - markdown\n  - velo\n---\n\n# Heading'
    // 同时装 frontmatterNodeView,让 frontmatter 渲染为 <pre><code>(跟生产一致);
    // 纯 schema toDOM 是裸 div,没有 pre/code 容器。contentDOM 仍由 PM 接管,
    // codeHighlightPlugin 的 inline decoration 照常在 contentDOM 内插 span。
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: fromMarkdown(md, schema),
      plugins: [codeHighlightPlugin, frontmatterNodeViewPlugin],
    })
    const view = new EditorView(container, { state })
    await flushHighlighter()
    const fmPos = findFrontmatterPos(view)
    expect(fmPos).toBeGreaterThanOrEqual(0)
    // frontmatter <pre> 内存在 shiki token span,同时定义 light / dark 变体
    // (装饰落在 .velo-editor 内,SCSS `.velo-editor pre span` 自动覆盖)。
    const fmPre = view.dom.querySelector('.velo-frontmatter pre') as HTMLElement | null
    expect(fmPre).not.toBeNull()
    const styledSpans = fmPre!.querySelectorAll('code span[style*="--shiki"]')
    expect(styledSpans.length).toBeGreaterThan(0)
    const hasDualThemes = Array.from(styledSpans).some((s) => {
      const st = s.getAttribute('style') || ''
      return st.includes('--shiki-light:') && st.includes('--shiki-dark:')
    })
    expect(hasDualThemes).toBe(true)
    view.destroy()
  })

  it('18b. extractLangsFromDoc:frontmatter 文档预装 yaml grammar(免闪烁)', async () => {
    const { extractLangsFromDoc } = await import('../editor/markdownIO')
    const md = [
      '---',
      'title: Hello',
      '---',
      '',
      '```javascript',
      'const a = 1',
      '```',
    ].join('\n')
    const langs = extractLangsFromDoc(md)
    // frontmatter 贡献 'yaml',fenced code 贡献 'javascript'
    expect(langs).toContain('yaml')
    expect(langs).toContain('javascript')
  })

  // extractLangsFromDoc 也应把 toml frontmatter 的 grammar 种进 seed 列表,
  // 避免首屏 toml 代码块闪烁。
  it('18c. extractLangsFromDoc:toml frontmatter 文档预装 toml grammar(免闪烁)', async () => {
    const { extractLangsFromDoc } = await import('../editor/markdownIO')
    const md = [
      '+++',
      'title = "Hello"',
      '+++',
    ].join('\n')
    const langs = extractLangsFromDoc(md)
    expect(langs).toContain('toml')
  })

  // toml frontmatter 应走 toml grammar 高亮(与 yaml 对称),复用 dual-theme 机制。
  it('18d. toml frontmatter 节点走 toml 高亮:复用 dual-theme inline decoration', async () => {
    const md = '+++\ntitle = "Hello"\ndate = 2026-07-10\n+++\n\n# Heading'
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: fromMarkdown(md, schema),
      plugins: [codeHighlightPlugin, frontmatterNodeViewPlugin],
    })
    const view = new EditorView(container, { state })
    await flushHighlighter()
    // frontmatter 节点带 lang=toml 属性。
    let fmAttrs: Record<string, unknown> | null = null
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'frontmatter') { fmAttrs = { ...node.attrs, pos }; return false }
      return true
    })
    expect(fmAttrs).not.toBeNull()
    expect(fmAttrs!.lang).toBe('toml')
    // toml <pre> 内存在 shiki token span,同时定义 light / dark 变体。
    const fmPre = view.dom.querySelector('.velo-frontmatter pre') as HTMLElement | null
    expect(fmPre).not.toBeNull()
    const styledSpans = fmPre!.querySelectorAll('code span[style*="--shiki"]')
    expect(styledSpans.length).toBeGreaterThan(0)
    const hasDualThemes = Array.from(styledSpans).some((s) => {
      const st = s.getAttribute('style') || ''
      return st.includes('--shiki-light:') && st.includes('--shiki-dark:')
    })
    expect(hasDualThemes).toBe(true)
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

  it('code_block 折叠:click fold btn → dispatch setMeta(foldKey) → pre 挂 velo-folded', async () => {
    // code_block 折叠由 CodeHighlightWidget 的 header chevron 触发,
    // dispatch setMeta(foldKey, { toggle: contentStart }) → FoldDecoration apply
    // → buildDecorations 给 pre 挂 Decoration.node({ class: 'velo-folded' })。
    // 需要同时挂 codeHighlightPlugin + foldDecoration 才能测完整链路。
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: fromMarkdown('```js\nconst x = 1\nconst y = 2\n```', schema),
      plugins: [codeHighlightPlugin, foldDecoration],
    })
    const view = new EditorView(container, { state })
    await flushHighlighter()
    // 初始:pre 没有 velo-folded class
    const pre = view.dom.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre!.classList.contains('velo-folded')).toBe(false)
    // 初始:header data-fold-state = expanded
    const header = view.dom.querySelector('.velo-code-header-widget') as HTMLElement | null
    expect(header?.getAttribute('data-fold-state')).toBe('expanded')
    // click fold btn
    const foldBtn = view.dom.querySelector('.velo-code-fold-btn') as HTMLElement | null
    expect(foldBtn).not.toBeNull()
    foldBtn!.click()
    // 折叠后:pre 挂 velo-folded class
    const preAfter = view.dom.querySelector('pre')
    expect(preAfter?.classList.contains('velo-folded')).toBe(true)
    // header data-fold-state = collapsed(widget key 不含折叠状态 → fold toggle
    // 复用旧 header DOM,click handler 手翻 data-fold-state 驱动 CSS 过渡)
    const headerAfter = view.dom.querySelector('.velo-code-header-widget') as HTMLElement | null
    expect(headerAfter?.getAttribute('data-fold-state')).toBe('collapsed')
    // 再次 click → 展开
    const foldBtnAfter = view.dom.querySelector('.velo-code-fold-btn') as HTMLElement | null
    foldBtnAfter!.click()
    const preFinal = view.dom.querySelector('pre')
    expect(preFinal?.classList.contains('velo-folded')).toBe(false)
    view.destroy()
  })

  it('空 code_block 折叠:click fold btn → pre 挂 velo-folded(不因 content.size===0 跳过)', async () => {
    // 回归:空 code_block 仍可折叠。CodeHighlightWidget 的 header(含 chevron)
    // 对所有 code_block 都渲染,若 FoldDecoration.addCodeBlockDecos 因
    // content.size===0 跳过 velo-folded → chevron 转了但 pre 不隐 → 折叠失效。
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: fromMarkdown('```js\n```', schema),
      plugins: [codeHighlightPlugin, foldDecoration],
    })
    const view = new EditorView(container, { state })
    await flushHighlighter()
    // 确认是空 code_block
    const pos = findCodeBlockPos(view)
    expect(pos).toBeGreaterThanOrEqual(0)
    expect(view.state.doc.nodeAt(pos)?.content.size).toBe(0)
    // 初始:pre 无 velo-folded,header expanded
    const pre = view.dom.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre!.classList.contains('velo-folded')).toBe(false)
    expect(
      (view.dom.querySelector('.velo-code-header-widget') as HTMLElement | null)
        ?.getAttribute('data-fold-state'),
    ).toBe('expanded')
    // click fold btn → pre 挂 velo-folded
    const foldBtn = view.dom.querySelector('.velo-code-fold-btn') as HTMLElement | null
    expect(foldBtn).not.toBeNull()
    foldBtn!.click()
    const preAfter = view.dom.querySelector('pre')
    expect(preAfter?.classList.contains('velo-folded')).toBe(true)
    expect(
      (view.dom.querySelector('.velo-code-header-widget') as HTMLElement | null)
        ?.getAttribute('data-fold-state'),
    ).toBe('collapsed')
    // 再次 click → 展开
    const foldBtnAfter = view.dom.querySelector('.velo-code-fold-btn') as HTMLElement | null
    foldBtnAfter!.click()
    const preFinal = view.dom.querySelector('pre')
    expect(preFinal?.classList.contains('velo-folded')).toBe(false)
    view.destroy()
  })

  it('heading 折叠含 code_block → header widget 跟着隐(不孤悬 fold 区段外)', async () => {
    // 回归:heading 折叠时,pre 被 velo-folded 隐,但 header widget 是
    // pre 的 side:-1 sibling(不在 pre 内部,velo-folded 影响不到),不跳过
    // 会孤悬在 fold 区段外 → "heading 折叠没收起代码块"。修法:祖先折叠
    // (isCodeBlockAncestorFolded(pos))时跳过整个 header(连同 token
    // inline decoration),展开帧 isCodeBlockAncestorFolded 翻 false → header 重建。
    // 自身折叠不跳过 —— header 是自身折叠的摘要,必须保留
    // (由上一条测例锁死)。
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: fromMarkdown('# title\n\n```js\nconst x = 1\n```\n', schema),
      plugins: [codeHighlightPlugin, foldDecoration],
    })
    const view = new EditorView(container, { state })
    await flushHighlighter()
    // 初始:header 存在
    expect(view.dom.querySelector('.velo-code-header-widget')).not.toBeNull()
    // 找 heading contentStart
    let hStart = -1
    view.state.doc.descendants((n, p) => {
      if (hStart < 0 && n.type.name === 'heading') { hStart = p + 1; return false }
      return true
    })
    expect(hStart).toBeGreaterThanOrEqual(0)
    // 折叠 heading → header 跟着隐
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: hStart }))
    expect(view.dom.querySelector('.velo-code-header-widget')).toBeNull()
    // pre 仍被 velo-folded 隐(顺便锁死既有行为)
    expect(view.dom.querySelector('pre')?.classList.contains('velo-folded')).toBe(true)
    // 展开 heading → header 回归
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: hStart }))
    expect(view.dom.querySelector('.velo-code-header-widget')).not.toBeNull()
    view.destroy()
  })

  it('code_block 自身折叠后 heading 折叠 → header 也跟着隐(不孤悬)', async () => {
    // 回归:code_block 先自身折叠(header 作为摘要保留),再折叠 heading。
    // 旧逻辑 `!isFolded && isCodeBlockFolded(pos)` 在 isFolded=true 时短路,
    // header 不跳过 → 孤悬在 heading 折叠区段外。修法:改用
    // isCodeBlockAncestorFolded(pos)(只含祖先折叠,不含自身折叠),
    // 祖先折叠时无论自身是否折叠都跳过 header。
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: fromMarkdown('# title\n\n```js\nconst x = 1\n```\n', schema),
      plugins: [codeHighlightPlugin, foldDecoration],
    })
    const view = new EditorView(container, { state })
    await flushHighlighter()

    // 找 heading contentStart
    const findHeadingCs = () => {
      let cs = -1
      view.state.doc.descendants((n, p) => {
        if (cs < 0 && n.type.name === 'heading') { cs = p + 1; return false }
        return true
      })
      return cs
    }

    // 1) 自身折叠 code_block → header 保留(collapsed 摘要)
    // 用 click fold btn 触发(click handler 手翻 data-fold-state;dispatch
    // 不经过 handler,widget key 不含 fold state → DOM 复用 → attribute 不变)
    const foldBtn = view.dom.querySelector('.velo-code-fold-btn') as HTMLElement | null
    expect(foldBtn).not.toBeNull()
    foldBtn!.click()
    const header = view.dom.querySelector('.velo-code-header-widget') as HTMLElement | null
    expect(header).not.toBeNull()
    expect(header!.getAttribute('data-fold-state')).toBe('collapsed')
    expect(view.dom.querySelector('pre')?.classList.contains('velo-folded')).toBe(true)

    // 2) 折叠 heading → header 跟着隐(不孤悬)
    const hCs = findHeadingCs()
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: hCs }))
    expect(view.dom.querySelector('.velo-code-header-widget')).toBeNull()

    // 3) 展开 heading → header 回归(仍是 collapsed 摘要)
    // header 在 heading 折叠时被 skip,展开时重建 → factory 重跑 →
    // isFolded 从当前 collapsedSet 读 → code_block 仍自身折叠 → collapsed
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: hCs }))
    const headerAfter = view.dom.querySelector('.velo-code-header-widget') as HTMLElement | null
    expect(headerAfter).not.toBeNull()
    expect(headerAfter!.getAttribute('data-fold-state')).toBe('collapsed')

    view.destroy()
  })
})
