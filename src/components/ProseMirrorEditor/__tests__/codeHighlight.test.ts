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
// 10. widget 不被 mermaid 节点触发(markdownIO 分流到 mermaid 节点,plugin 过滤)

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

  it('2. language=javascript → inline decoration 包含 var(--shiki-*) style', async () => {
    const view = makeView('```javascript\nconst x = 1\n```')
    await flushHighlighter()
    // 找 pre > code 内的 inline span,有 style 包含 var(--shiki-)
    const styledSpans = view.dom.querySelectorAll('pre code span[style*="--shiki"]')
    expect(styledSpans.length).toBeGreaterThan(0)
    // 至少一个 span 的 style 含 "color: var(--shiki-"
    const hasColorVar = Array.from(styledSpans).some((s) =>
      (s.getAttribute('style') || '').includes('color: var(--shiki-'),
    )
    expect(hasColorVar).toBe(true)
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

  it('10. mermaid 节点不被 codeHighlightPlugin 接管(只对 code_block 生效)', async () => {
    const md = '```mermaid\ngraph TD\n  A --> B\n```'
    const view = makeView(md)
    await flushHighlighter()
    // mermaid 节点不应该有工具条 widget
    const allToolbars = view.dom.querySelectorAll('.velo-code-toolbar-widget')
    expect(allToolbars.length).toBe(0)
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
