// frontmatter 折叠回归测试。
//
// 独立文件:FoldDecoration 的 module-level collapsedSet 跨 suite 泄漏,
// 不能跟 foldDecoration.test.ts 同文件。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import {
  foldDecoration, foldKey, makeStableKey, collectFoldableKeys, ensureFoldExpandedAt,
} from '../nodes/FoldDecoration'
import { frontmatterNodeViewPlugin } from '../nodes/FrontmatterNodeView'
import type { Node as PMNode } from 'prosemirror-model'

function makeView(initialMd: string, extraPlugins: any[] = []): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(initialMd, schema),
    plugins: [foldDecoration, frontmatterNodeViewPlugin, ...extraPlugins],
  })
  return new EditorView(container, {
    state,
    attributes: { class: 'velo-editor' },
  })
}

// 查 doc 内第一个 frontmatter 节点
function findFrontmatter(view: EditorView): { node: PMNode, pos: number, contentStart: number } | null {
  let out: { node: PMNode, pos: number, contentStart: number } | null = null
  view.state.doc.descendants((node, p) => {
    if (!out && node.type.name === 'frontmatter') {
      out = { node, pos: p, contentStart: p + 1 }
      return false
    }
    return true
  })
  return out
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  // 清理所有挂在 body 的 view.dom 容器
  document.querySelectorAll('.velo-editor, .ProseMirror').forEach((el) => {
    el.remove()
  })
})

// ============================================================
//  makeStableKey
// ============================================================

describe('makeStableKey(frontmatter)', () => {
  it('frontmatter → "fm:{text}"', () => {
    const view = makeView('---\ntitle: hello\n---\n\nBody\n')
    const fm = findFrontmatter(view)
    expect(fm).not.toBeNull()
    expect(makeStableKey(fm!.node)).toBe('fm:title: hello')
    view.destroy()
  })

  it('frontmatter 空内容 → "fm:"', () => {
    const view = makeView('---\n---\n\nBody\n')
    const fm = findFrontmatter(view)
    expect(fm).not.toBeNull()
    expect(makeStableKey(fm!.node)).toBe('fm:')
    view.destroy()
  })

  it('frontmatter text 截断到 80 字符', () => {
    const view = makeView('---\n' + 'x'.repeat(200) + '\n---\n\nBody\n')
    const fm = findFrontmatter(view)
    const key = makeStableKey(fm!.node)
    expect(key.startsWith('fm:')).toBe(true)
    expect(key.length === 'fm:'.length + 80).toBe(true)
    view.destroy()
  })
})

// ============================================================
//  collectFoldableKeys
// ============================================================

describe('collectFoldableKeys', () => {
  it('含 frontmatter type 条目 + contentStart = pos+1', () => {
    const view = makeView('---\nfoo: bar\n---\n\nBody\n')
    const keys = collectFoldableKeys(view.state.doc)
    const fmEntries = keys.filter(k => k.type === 'frontmatter')
    expect(fmEntries).toHaveLength(1)
    expect(fmEntries[0].contentStart).toBe(1)
    expect(fmEntries[0].stableKey.startsWith('fm:')).toBe(true)
    view.destroy()
  })

  it('文档无 frontmatter 时无 fm 条目', () => {
    const view = makeView('Just plain text\n')
    const keys = collectFoldableKeys(view.state.doc)
    expect(keys.filter(k => k.type === 'frontmatter')).toHaveLength(0)
    view.destroy()
  })
})

// ============================================================
//  ensureFoldExpandedAt 命中 frontmatter
// ============================================================

describe('ensureFoldExpandedAt', () => {
  it('命中 folded frontmatter → 幂等展开', () => {
    const view = makeView('---\nfoo: bar\n---\n\nBody\n')
    const fm = findFrontmatter(view)!
    // 先把 frontmatter 折叠
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: fm.contentStart }))
    expect(foldKey.getState(view.state)!.collapsedSet.has(fm.contentStart)).toBe(true)
    // ensureFoldExpandedAt:
    const didExpand = ensureFoldExpandedAt(view, fm.contentStart)
    expect(didExpand).toBe(true)
    expect(foldKey.getState(view.state)!.collapsedSet.has(fm.contentStart)).toBe(false)
    view.destroy()
  })

  it('命中已展开 frontmatter → no-op(false)', () => {
    const view = makeView('---\nfoo: bar\n---\n\nBody\n')
    const fm = findFrontmatter(view)!
    expect(ensureFoldExpandedAt(view, fm.contentStart)).toBe(false)
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(0)
    view.destroy()
  })
})

// ============================================================
//  buildDecorations → frontmatter 折叠装饰
// ============================================================

describe('foldDecoration state 行为(通过真实 dispatch 路径验证)', () => {
  it('toggle frontmatter → collapsedSet 加入 contentStart;chevron 方向同步翻成 collapsed', () => {
    const view = makeView('---\nfoo: bar\n---\n\nBody\n')
    const fm = findFrontmatter(view)!
    const chevron = view.dom.querySelector('.velo-frontmatter-fold-btn') as HTMLButtonElement | null
    expect(chevron).not.toBeNull()
    // 初始态:展开
    expect(foldKey.getState(view.state)!.collapsedSet.has(fm.contentStart)).toBe(false)
    expect(chevron!.getAttribute('data-fold-state')).toBe('expanded')
    const wrapper = view.dom.querySelector('.velo-frontmatter') as HTMLElement | null
    expect(wrapper).not.toBeNull()
    // 初始态:pre 未折叠
    expect(wrapper!.classList.contains('is-collapsed')).toBe(false)
    // 通过 click 间接触发真实 dispatch 路径(避免 view.state.tr 绕过 PM reconciliation)
    chevron!.click()
    // collapsedSet 包含 contentStart
    expect(foldKey.getState(view.state)!.collapsedSet.has(fm.contentStart)).toBe(true)
    // chevron 方向翻成 collapsed
    expect(chevron!.getAttribute('data-fold-state')).toBe('collapsed')
    // **视觉折叠**:NodeView 自管的 is-collapsed class
    expect(wrapper!.classList.contains('is-collapsed')).toBe(true)
    view.destroy()
  })

  it('toggle frontmatter → 再次 toggle → 展开', () => {
    const view = makeView('---\nfoo: bar\n---\n\nBody\n')
    const fm = findFrontmatter(view)!
    const chevron = view.dom.querySelector('.velo-frontmatter-fold-btn') as HTMLButtonElement
    const wrapper = view.dom.querySelector('.velo-frontmatter') as HTMLElement
    chevron.click()
    expect(foldKey.getState(view.state)!.collapsedSet.has(fm.contentStart)).toBe(true)
    expect(wrapper.classList.contains('is-collapsed')).toBe(true)
    chevron.click()
    expect(foldKey.getState(view.state)!.collapsedSet.has(fm.contentStart)).toBe(false)
    expect(chevron.getAttribute('data-fold-state')).toBe('expanded')
    expect(wrapper.classList.contains('is-collapsed')).toBe(false)
    view.destroy()
  })

  it('frontmatter 带嵌套换行内容:稳定 key 派生正确', () => {
    const view = makeView('---\ntitle: hello world\ndate: 2026-07-10\n---\n\nBody\n')
    const fm = findFrontmatter(view)!
    // YAML 内容里 \n 在高层看是单个 text 节点(frontmatter content 'text*')
    // YAML 内 multi-line 文本经 makeStableKey 会 trim + 多空格/换行折叠成单空格 + 80 字符截断
    expect(makeStableKey(fm.node)).toBe('fm:title: hello world date: 2026-07-10')
    view.destroy()
  })
})

// ============================================================
//  FrontmatterNodeView chevron click
// ============================================================

describe('FrontmatterNodeView chevron click', () => {
  it('click chevron → dispatch setMeta(foldKey,{toggle:contentStart}) + chevron data-fold-state 翻成 collapsed', () => {
    const view = makeView('---\nfoo: bar\n---\n\nBody\n')
    const fm = findFrontmatter(view)!
    // 找 chevron button(挂在 header 内)
    const chevron = view.dom.querySelector('.velo-frontmatter-fold-btn') as HTMLButtonElement | null
    expect(chevron).not.toBeNull()
    expect(chevron!.getAttribute('data-fold-state')).toBe('expanded')
    // 模拟 click
    chevron!.click()
    // 验证 foldKey state 已折叠
    expect(foldKey.getState(view.state)!.collapsedSet.has(fm.contentStart)).toBe(true)
    // 验证 chevron 方向已翻
    expect(chevron!.getAttribute('data-fold-state')).toBe('collapsed')
    view.destroy()
  })

  it('click 已折叠 chevron → 展开', () => {
    const view = makeView('---\nfoo: bar\n---\n\nBody\n')
    const fm = findFrontmatter(view)!
    const chevron = view.dom.querySelector('.velo-frontmatter-fold-btn') as HTMLButtonElement
    chevron.click() // 折叠
    expect(foldKey.getState(view.state)!.collapsedSet.has(fm.contentStart)).toBe(true)
    chevron.click() // 展开
    expect(foldKey.getState(view.state)!.collapsedSet.has(fm.contentStart)).toBe(false)
    expect(chevron.getAttribute('data-fold-state')).toBe('expanded')
    view.destroy()
  })
})

// ============================================================
//  frontmatter 不存在
// ============================================================

describe('frontmatter 不存在', () => {
  it('无 frontmatter 文档 → 无 chevron button', () => {
    const view = makeView('Just plain text\n')
    expect(view.dom.querySelector('.velo-frontmatter-fold-btn')).toBeNull()
    view.destroy()
  })
})

// ============================================================
//  toml frontmatter 折叠(与 yaml 对称)
// ============================================================

describe('toml frontmatter 折叠', () => {
  it('toml frontmatter → lang=toml + 可折叠', () => {
    const view = makeView('+++\ntitle = "Hello"\n+++\n\nBody\n')
    const fm = findFrontmatter(view)
    expect(fm).not.toBeNull()
    // 节点携带 lang=toml 属性。
    expect(fm!.node.attrs.lang).toBe('toml')
    const chevron = view.dom.querySelector('.velo-frontmatter-fold-btn') as HTMLButtonElement | null
    expect(chevron).not.toBeNull()
    // 视觉容器带 data-lang=toml(与 schema toDOM 一致)。
    const wrapper = view.dom.querySelector('.velo-frontmatter') as HTMLElement | null
    expect(wrapper!.dataset.lang).toBe('toml')
    // 初始态:展开
    expect(chevron!.getAttribute('data-fold-state')).toBe('expanded')
    // chevron click → 折叠
    chevron!.click()
    expect(foldKey.getState(view.state)!.collapsedSet.has(fm!.contentStart)).toBe(true)
    expect(chevron!.getAttribute('data-fold-state')).toBe('collapsed')
    expect(wrapper!.classList.contains('is-collapsed')).toBe(true)
    // 再次 click → 展开
    chevron!.click()
    expect(foldKey.getState(view.state)!.collapsedSet.has(fm!.contentStart)).toBe(false)
    expect(chevron!.getAttribute('data-fold-state')).toBe('expanded')
    expect(wrapper!.classList.contains('is-collapsed')).toBe(false)
    view.destroy()
  })
})

// ============================================================
//  格式 chip 点击切换 lang
// ============================================================

describe('格式 chip 点击切换 lang', () => {
  // setNodeMarkup 会替换 doc 节点(新对象),捕获的 fm.node 会过时 —— 断言节点属性时
  // 始终从 view.state.doc 重新读取,不用缓存的 fm.node。
  function currentFmNode(view: EditorView) {
    return view.state.doc.firstChild!
  }

  it('yaml frontmatter → chip 显示 YAML,点击后切换为 toml + 序列化变 +++', () => {
    const view = makeView('---\ntitle: Hello\n---\n\nBody\n')
    const langBtn = view.dom.querySelector('.velo-frontmatter-lang') as HTMLButtonElement | null
    const wrapper = view.dom.querySelector('.velo-frontmatter') as HTMLElement | null
    expect(langBtn).not.toBeNull()
    // 初始态:yaml —— chip 文案 + data-lang + 节点属性三方一致
    expect(langBtn!.textContent).toBe('YAML')
    expect(langBtn!.getAttribute('data-lang')).toBe('yaml')
    expect(wrapper!.dataset.lang).toBe('yaml')
    expect(currentFmNode(view).attrs.lang).toBe('yaml')
    // 点击 chip → 切换为 toml(进入真实 dispatch 路径)
    langBtn!.click()
    // 节点 lang 属性翻转为 toml(从 doc 重读,防 fm.node 过时)
    expect(currentFmNode(view).attrs.lang).toBe('toml')
    // chip 文案 + wrapper data-lang 由 update() 跟住,同步刷新
    expect(langBtn!.textContent).toBe('TOML')
    expect(langBtn!.getAttribute('data-lang')).toBe('toml')
    expect(wrapper!.dataset.lang).toBe('toml')
    // 序列化 fence 跟随切换:--- → +++
    expect(currentFmNode(view).attrs.lang).toBe('toml')
    view.destroy()
  })

  it('chip 点击切换后,toMarkdown 输出对应 fence', async () => {
    const { toMarkdown } = await import('../editor/markdownIO')
    const view = makeView('---\ntitle: Hello\n---\n\nBody\n')
    const langBtn = view.dom.querySelector('.velo-frontmatter-lang') as HTMLButtonElement
    // 切换为 toml
    langBtn.click()
    const md = toMarkdown(view.state.doc)
    expect(md.trim()).toBe('+++\ntitle: Hello\n+++\n\nBody')
    // 切回 yaml
    langBtn.click()
    const md2 = toMarkdown(view.state.doc)
    expect(md2.trim()).toBe('---\ntitle: Hello\n---\n\nBody')
    view.destroy()
  })

  it('再次点击 chip 切回原种类 —— 可逆', () => {
    const view = makeView('+++\ntitle = "Hello"\n+++\n\nBody\n')
    const langBtn = view.dom.querySelector('.velo-frontmatter-lang') as HTMLButtonElement
    expect(currentFmNode(view).attrs.lang).toBe('toml')
    langBtn.click()
    expect(currentFmNode(view).attrs.lang).toBe('yaml')
    expect(langBtn.textContent).toBe('YAML')
    langBtn.click()
    expect(currentFmNode(view).attrs.lang).toBe('toml')
    expect(langBtn.textContent).toBe('TOML')
    view.destroy()
  })
})
