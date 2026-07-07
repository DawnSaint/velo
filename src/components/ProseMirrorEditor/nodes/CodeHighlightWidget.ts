// 代码块高亮 —— inline decoration(高亮) + widget(header 标题栏)。
//
// 为什么不走 NodeView:
//   NodeView 的 outer dom 改 innerHTML 会被 ProseMirror DOMObserver 当外部
//   突变,触发 view.updateState → NodeView 重建闪烁(详见 mermaid 同样教训)。
//
// 走 ProseMirror 标准做法:
//   1. header:Decoration.widget(pos, toDOM, { side: -1, key })
//      渲染在 `<pre>` 之前(兄弟节点),正常文档流 block 元素,视觉与 pre
//      连为一体(共享 border / bg,header 上圆角 + pre 下圆角)。
//   2. 高亮:codeToTokens 拿 ThemedToken[][],逐 token 转
//      Decoration.inline(from, to, { style: 'color: var(--shiki-xxx)' })。
//   3. plugin.state 缓存 highlighter 实例 + 当前 light/dark 主题名;
//      首次 await getHighlighter() 期间,plugin.decorations 返回空 inline
//      decoration,等 token 到了通过 tr.setMeta 触发重新构建。
//
// **暗色模式** (darkMode toggle):零重渲。token.color 是 `var(--shiki-keyword)`
// 字符串,只要 <html class="dark"> 切换 → CSS 变量值变 → token 颜色自动变;
// ProseMirror 不知道、不参与。**不要**在 widget 内订阅 'velo:theme-change'
// 再 setState 触发 rebuild,会死循环。
//
// **代码块主题切换** (settings 面板里换 vitesse-light → dracula):需要 rebuild
// decoration,因为新主题的 hex 颜色不同,得重新生成 token 的 inline style。
// App.vue watch store.codeLightTheme / codeDarkTheme → 调 ensureTheme +
// dispatch tr.setMeta({ highlighter, lightTheme, darkTheme }) → plugin state
// apply → buildDecorations 重新跑。这条路径是 *设置* 触发的,跟 darkMode
// toggle 的纯 CSS 路径正交。
//
// **code_block 折叠**:header 内置折叠 chevron,click → dispatch
// setMeta(foldKey, { toggle: contentStart })。折叠状态由 FoldDecoration
// 的 collapsedSet 跟踪;buildDecorations 读 foldKey.getState 判断是否折叠,
// 折叠态写入 widget key → PM 销毁旧 widget 创建新 widget(chevron 方向 +
// data-fold-state 正确)。pre 的 display:none 由 FoldDecoration 的
// Decoration.node({ class: 'velo-folded' }) 接管。
//
// widget key 必须含 lang + 文本 hash + 折叠状态 —— lang 变化 / 文本变化 /
// 折叠切换时 ProseMirror 会复用同 key 的 widget DOM 导致内容不更新。

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import type { Highlighter } from 'shiki'
import { useEditorStore } from '@/stores/editor'
import {
  getHighlighterSync,
  getTokensCached,
  hashCode,
  ensureTheme,
  setDecorationRebuildCallback,
  DEFAULT_LIGHT_THEME,
  DEFAULT_DARK_THEME,
  LANG_OPTIONS,
} from './CodeBlockLangs'
import { tokenizeMermaid } from './mermaidTokenizer'
import { writeClipboardText } from '@/utils/clipboard'
import { checkSvg, chevronDownSvg, copySvg } from '@/components/icons/widgetIcons'
import { langIconSvg } from './langIcons'
import { foldKey, isCodeBlockFolded } from './FoldDecoration'

// ============================================================
//  Plugin state
// ============================================================

interface CodeHighlightState {
  /** 异步 highlighter;null 表示还没好(grammar 还在 load)。 */
  highlighter: Highlighter | null
  /** 当前浅色主题名(双主题代码块的 light 变体)。 */
  lightTheme: string
  /** 当前深色主题名(双主题代码块的 dark 变体)。 */
  darkTheme: string
}

/** 工厂:每次调都从 store 同步拿当前主题,factory 内不能直接用 ref(模块
 *  加载时 store 还没就绪),改在 state.init 内联调。 */
function makeInitialState(): CodeHighlightState {
  // store 在模块顶层还不可用(state.init 时已经在 component context)
  let light = DEFAULT_LIGHT_THEME
  let dark = DEFAULT_DARK_THEME
  try {
    const store = useEditorStore()
    if (store.codeLightTheme) light = store.codeLightTheme
    if (store.codeDarkTheme) dark = store.codeDarkTheme
  }
  catch { /* pinia 未就绪 / 单元测试场景,fallback DEFAULT */ }
  return {
    highlighter: getHighlighterSync(), // PM mount 时 App.vue codeBlockReady 守门后必然 ready
    lightTheme: light,
    darkTheme: dark,
  }
}

export const codeHighlightKey = new PluginKey<CodeHighlightState>('codeHighlight')

// ============================================================
//  Header widget factory —— prosemirror-view 接受 (view, getPos) => DOMNode
// ============================================================

/** header toDOM 工厂。widget key 由 spec.key 控制,toDOM 不需要做对比。
 *  - pos:code_block 节点 pos(本 widget 在 pos 之前,side: -1)
 *  - lang:当前语言
 *  - getCode:同步拿 code_block 文本(切 lang 时变 → widget key 变)
 *  - isFolded:当前折叠状态(chevron 方向 + data-fold-state)
 *  - toggleFold:click chevron 时调,dispatch setMeta(foldKey, { toggle })
 *  - setLang:提交新语言时调,dispatch setNodeAttribute(language)
 *
 * header 是正常文档流 block 元素(非 absolute),视觉与 pre 连为一体:
 * header 上圆角 + pre 下圆角,共享 border / bg。折叠时 pre 被
 * FoldDecoration 的 velo-folded class 隐藏,header 保留显示(含行数摘要)。
 *
 * 语言选择器是内嵌 input(非按钮 + 浮层):input 值 = 当前 lang,icon 实时
 * 跟随输入值变化。focus / 输入时在 body 上挂 fixed 定位下拉,点击候选项
 * 或 Enter 提交;setLang 触发 widget 重建(key 含 lang),新 input 自动显示新值。
 */
function makeHeaderDom(
  pos: number,
  lang: string,
  getCode: () => string,
  isFolded: boolean,
  toggleFold: () => void,
  setLang: (lang: string) => void,
  focusCode: () => void,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'velo-code-header-widget'
  wrap.contentEditable = 'false'
  wrap.setAttribute('data-pos', String(pos))
  wrap.setAttribute('data-lang', lang)
  wrap.setAttribute('data-fold-state', isFolded ? 'collapsed' : 'expanded')

  // 折叠 chevron —— 始终用 chevron-down,CSS rotate(-90deg) 实现折叠态
  const foldBtn = document.createElement('button')
  foldBtn.type = 'button'
  foldBtn.className = 'velo-code-fold-btn'
  foldBtn.title = isFolded ? '展开' : '折叠'
  foldBtn.contentEditable = 'false'
  foldBtn.innerHTML = chevronDownSvg(14)
  foldBtn.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  foldBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    toggleFold()
  })
  wrap.appendChild(foldBtn)

  // 语言输入框(替代旧按钮 + 浮层方案):input 值 = lang,icon 实时跟随,
  // focus / 输入时在 body 上挂 fixed 下拉,点击候选项或 Enter 提交。
  const langWrap = document.createElement('div')
  langWrap.className = 'velo-code-lang-input-wrap'
  langWrap.contentEditable = 'false'

  const iconSpan = document.createElement('span')
  iconSpan.className = 'velo-code-lang-icon'
  iconSpan.innerHTML = langIconSvg(lang, 14)

  const langInput = document.createElement('input')
  langInput.type = 'text'
  langInput.className = 'velo-code-lang-input'
  langInput.value = lang
  langInput.placeholder = 'plain text'
  langInput.spellcheck = false
  langInput.setAttribute('aria-label', '代码块语言')
  langInput.contentEditable = 'false'

  let dropdown: HTMLDivElement | null = null
  let committed = false
  // 键盘高亮索引(-1 = 无高亮,0..N = 第 N 个候选项)
  let highlightIndex = -1

  function updateIcon(value: string): void {
    iconSpan.innerHTML = langIconSvg(value, 14)
  }

  function getFiltered(value: string): string[] {
    const q = value.toLowerCase().trim()
    if (!q) return [...LANG_OPTIONS]
    return LANG_OPTIONS.filter((l) => {
      if (l === '') return q === 'plain' || q === 'text' || q === 'plaintext'
      return l.toLowerCase().includes(q)
    })
  }

  function updateDropdownPosition(): void {
    if (!dropdown || !langInput.isConnected) return
    const rect = langInput.getBoundingClientRect()
    dropdown.style.top = `${rect.bottom + 2}px`
    dropdown.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 188))}px`
  }

  /** 把语言名中匹配 query 的部分用 <b> 包裹,其余 escape。 */
  function highlightMatch(text: string, query: string): string {
    const q = query.toLowerCase().trim()
    if (!q) return escapeHtml(text)
    const idx = text.toLowerCase().indexOf(q)
    if (idx < 0) return escapeHtml(text)
    return (
      escapeHtml(text.slice(0, idx)) +
      `<b class="velo-lang-match">${escapeHtml(text.slice(idx, idx + q.length))}</b>` +
      escapeHtml(text.slice(idx + q.length))
    )
  }

  function renderDropdownItems(): void {
    if (!dropdown) return
    const value = langInput.value
    const filtered = getFiltered(value)
    // 无匹配 → 隐藏面板(不显示空白下拉框)
    if (filtered.length === 0) {
      dropdown.style.display = 'none'
      return
    }
    dropdown.style.display = ''
    dropdown.innerHTML = ''

    for (let i = 0; i < filtered.length; i++) {
      const l = filtered[i]
      const item = document.createElement('div')
      item.className = 'velo-lang-dropdown-item'
      if (i === highlightIndex) item.classList.add('highlighted')
      const displayText = l || 'plain text'
      item.innerHTML = `<span class="velo-lang-icon">${langIconSvg(l, 16)}</span><span>${highlightMatch(displayText, value)}</span>`
      // mousedown preventDefault 阻止 input blur,让 click 正常触发
      item.addEventListener('mousedown', (e) => { e.preventDefault() })
      item.addEventListener('click', () => { commitLang(l) })
      dropdown.appendChild(item)
    }
  }

  /** 把高亮条目滚进可视区(键盘导航越界时) */
  function scrollHighlightIntoView(): void {
    if (!dropdown) return
    const items = dropdown.querySelectorAll('.velo-lang-dropdown-item')
    const el = items[highlightIndex] as HTMLElement | undefined
    if (el) el.scrollIntoView({ block: 'nearest' })
  }

  function showDropdown(): void {
    if (dropdown) {
      updateDropdownPosition()
      renderDropdownItems()
      return
    }
    dropdown = document.createElement('div')
    dropdown.className = 'velo-lang-dropdown'
    document.body.appendChild(dropdown)
    updateDropdownPosition()
    renderDropdownItems()
    window.addEventListener('scroll', updateDropdownPosition, { capture: true, passive: true })
    window.addEventListener('resize', updateDropdownPosition)
  }

  function hideDropdown(): void {
    if (!dropdown) return
    dropdown.remove()
    dropdown = null
    highlightIndex = -1
    window.removeEventListener('scroll', updateDropdownPosition, { capture: true } as EventListenerOptions)
    window.removeEventListener('resize', updateDropdownPosition)
  }

  /** 直接用输入框当前值提交(不做精确匹配 / 取首项等智能解析)。 */
  function commitInputValue(): void {
    if (committed) return
    commitLang(langInput.value.trim())
  }

  function commitLang(value: string): void {
    if (committed) return
    committed = true
    hideDropdown()
    setLang(value)
    // setLang → setNodeAttribute → widget key 变 → PM 销毁旧 DOM 建新 DOM,
    // 旧 input 的 blur 会被 committed flag 拦住,不会二次提交。
  }

  // mousedown + click 都 stopPropagation(不 preventDefault),让 input 可获得焦点。
  // **click 必须也 stop**:index.vue 外层卡片有 @click="onCardClick" → focusEditor(),
  // click 不拦会冒泡到卡片 → 焦点被抢回编辑器 → input 失焦(光标"自动移出"根因)。
  // fold/copy 按钮在 click 上也 stopPropagation 了,同因。
  langWrap.addEventListener('mousedown', (e) => {
    e.stopPropagation()
  })
  langWrap.addEventListener('click', (e) => {
    e.stopPropagation()
  })
  langInput.addEventListener('input', () => {
    updateIcon(langInput.value)
    highlightIndex = -1
    if (dropdown) {
      renderDropdownItems()
      updateDropdownPosition()
    }
  })
  langInput.addEventListener('focus', () => {
    showDropdown()
  })
  // blur 延迟 150ms,让候选项 click 先触发(commitLang 会置 committed=true 拦住本次)
  langInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (committed) return
      hideDropdown()
      // 值没变就不提交(避免无谓 widget 重建)
      if (langInput.value.trim() === lang) return
      commitInputValue()
    }, 150)
  })
  langInput.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      langInput.value = lang
      updateIcon(lang)
      hideDropdown()
      langInput.blur()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      // 有键盘高亮条目 → 提交该条目
      if (highlightIndex >= 0) {
        const filtered = getFiltered(langInput.value)
        if (highlightIndex < filtered.length) {
          commitLang(filtered[highlightIndex])
          focusCode()
          return
        }
      }
      // 无高亮条目 → 提交输入框值并 focus 代码
      commitInputValue()
      focusCode()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      commitInputValue()
      focusCode()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const filtered = getFiltered(langInput.value)
      if (filtered.length === 0) return
      if (e.key === 'ArrowDown') {
        highlightIndex = highlightIndex < filtered.length - 1 ? highlightIndex + 1 : 0
      } else {
        highlightIndex = highlightIndex > 0 ? highlightIndex - 1 : filtered.length - 1
      }
      renderDropdownItems()
      scrollHighlightIntoView()
      return
    }
  })

  langWrap.appendChild(iconSpan)
  langWrap.appendChild(langInput)
  wrap.appendChild(langWrap)

  // 折叠态行数摘要(展开态 CSS 隐藏)
  const lineCount = getCode().split('\n').length
  const infoSpan = document.createElement('span')
  infoSpan.className = 'velo-code-fold-info'
  infoSpan.textContent = `${lineCount} 行`
  wrap.appendChild(infoSpan)

  // 复制按钮 —— widget 内部直接 await,避免跨组件 async 时序问题
  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'velo-code-copy-btn'
  copyBtn.title = '复制代码'
  copyBtn.contentEditable = 'false'
  copyBtn.innerHTML = copySvg(12)
  copyBtn.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  copyBtn.addEventListener('click', async (e) => {
    e.preventDefault()
    e.stopPropagation()
    const code = getCode()
    await writeToClipboard(code, copyBtn)
  })
  wrap.appendChild(copyBtn)

  return wrap
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 写剪贴板。Tauri webview 下 navigator.clipboard 不稳,优先走
 * @tauri-apps/plugin-clipboard-manager;失败回退 navigator.clipboard;
 * 都不行 → 静默(按钮 flash 一下 ✓ 也比抛错体验好)。
 * 不发任何外抛,UI 闪一下即可。
 */
async function writeToClipboard(text: string, btn: HTMLElement): Promise<void> {
  const ok = await writeClipboardText(text)
  const wasHtml = btn.innerHTML
  if (ok) {
    btn.innerHTML = checkSvg(12)
    btn.classList.add('velo-copy-flash-ok')
  }
  setTimeout(() => {
    btn.innerHTML = wasHtml
    btn.classList.remove('velo-copy-flash-ok')
  }, 1200)
}

// ============================================================
//  Mermaid token 颜色 —— 从 shiki 主题动态提取 hex
// ============================================================

// mermaid 6 类 token 映射到 shiki TextMate scope(语义近似):
//   keyword   → keyword        (图类型词,跟 const/return 同类)
//   direction → keyword        (TD/LR 也是关键字性质,复用 keyword 色)
//   shape     → string         (节点形状 [],跟字符串同色系)
//   edge      → keyword.operator (箭头 --> 是操作符性质)→ fallback keyword
//   label     → string         (label 文字,跟字符串同类)
//   comment   → comment        (%% 注释)
//
// **为什么要从 shiki 主题提色**:mermaid 走自写 tokenizer 旁路 shiki,但颜色
// 必须**跟随用户选的代码块主题**(vitesse-light → dracula 时 mermaid 也得变)。
// shiki 路径靠 `codeToTokensWithThemes` 把每个 token 的 hex 写进 inline style;
// mermaid 路径没有 token → hex 的现成映射,所以手动从 `hl.getTheme(theme).settings`
// 按 scope 提取代表性 hex,再以 `--shiki-light:${hex};--shiki-dark:${hex}` 局部
// CSS 变量写进 inline decoration —— 跟 shiki token **完全同形**,SCSS 那边
// `color: var(--shiki-light)` 的 cascade 选色机制直接复用,代码块主题切换
// (App.vue watch → dispatch setMeta → rebuild)和 dark/light 切换(纯 CSS)
// 两条路径都不用额外处理。
const MERMAID_TYPE_TO_SCOPE: Record<string, string> = {
  keyword: 'keyword',
  direction: 'keyword',
  shape: 'string',
  edge: 'keyword.operator',
  label: 'string',
  comment: 'comment',
}

/** 从 shiki 主题 settings 数组找指定 scope 的前景色 hex。
 *  scope 匹配:精确 / 前缀(如 'keyword.operator' 命中 'keyword.operator' 也命中
 *  'keyword' 前缀)。返回首个非空 foreground,找不到返回 null(调用方 fallback)。 */
function extractScopeColor(
  settings: any[] | undefined,
  scopeMatch: string,
): string | null {
  if (!settings) return null
  for (const s of settings) {
    const raw = Array.isArray(s.scope) ? s.scope : [s.scope]
    for (const sc of raw) {
      if (typeof sc !== 'string') continue
      // scope 可能是逗号分隔的复合 "entity.name.class,entity.name.type.class"
      for (const part of sc.split(',')) {
        const trimmed = part.trim()
        if (trimmed === scopeMatch || trimmed.startsWith(scopeMatch)) {
          const fg = s.settings?.foreground
          if (fg) return fg
        }
      }
    }
  }
  return null
}

/** 给 mermaid token type 算出当前 [light, dark] 主题下的 hex 颜色对。
 *  - 优先取主题里 scope 对应的 foreground
 *  - edge 的 keyword.operator 在不少主题里是 default 色(不可区分),fallback 到 keyword
 *  - 全部 miss 时返回 null,调用方跳过该 token(让默认色接管)
 *
 *  返回的 hex 直接写进 inline `--shiki-light:${light};--shiki-dark:${dark}`,
 *  跟 shiki token 完全同形,SCSS `color: var(--shiki-light)` 接管选色。 */
function getMermaidColors(
  hl: Highlighter | null,
  lightTheme: string,
  darkTheme: string,
): Partial<Record<string, { light: string, dark: string }>> | null {
  if (!hl) return null
  let lightSettings: any[] | undefined
  let darkSettings: any[] | undefined
  try {
    lightSettings = hl.getTheme(lightTheme as any)?.settings
    darkSettings = hl.getTheme(darkTheme as any)?.settings
  }
  catch { return null }
  if (!lightSettings && !darkSettings) return null

  const result: Partial<Record<string, { light: string, dark: string }>> = {}
  for (const [type, scope] of Object.entries(MERMAID_TYPE_TO_SCOPE)) {
    let light = extractScopeColor(lightSettings, scope)
    let dark = extractScopeColor(darkSettings, scope)
    // edge 的 keyword.operator 在很多主题里就是默认色(不可区分箭头),
    // fallback 到 keyword 让它至少有强调色
    if (type === 'edge' && (!light || light === extractScopeColor(lightSettings, 'keyword'))) {
      // operator 跟 keyword 同色或没找到 → 直接用 keyword 色(已是强调色)
      light = light || extractScopeColor(lightSettings, 'keyword')
      dark = dark || extractScopeColor(darkSettings, 'keyword')
    }
    if (light || dark) {
      result[type] = { light: light || dark || '', dark: dark || light || '' }
    }
  }
  return result
}

// ============================================================
//  构造 decorations
// ============================================================

function buildDecorations(
  state: EditorState,
  hl: Highlighter | null,
  lightTheme: string,
  darkTheme: string,
): DecorationSet {
  const decos: Decoration[] = []
  // 读 fold 状态:判断 code_block 是否折叠(chevron 方向 + widget key)
  const foldState = foldKey.getState(state)
  state.doc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== 'code_block') return
    const lang = (node.attrs.language as string) || ''
    // 注意:mermaid 与普通 code_block 共用本 header(语言选择 + 复制)。
    // MermaidDecoration 的 widget 锚在 pos + nodeSize + side: 1(pre 之后),
    // 本 header 锚在 pos + side: -1(pre 之前)→ 两个 widget DOM 位置不冲突,
    // mermaid 走 MermaidDecoration 的额外 SVG / 切换源码 / 删除按钮 / 关闭按钮。
    // header widget —— key 含 lang + 文本 hash + 折叠状态,lang 变 / 文本变 /
    // 折叠切换都强制重挂,否则 ProseMirror 复用旧 DOM 内容不更新。
    const blockStart = pos + 1
    const blockEnd = pos + node.nodeSize - 1
    const code = blockStart < blockEnd
      ? state.doc.textBetween(blockStart, blockEnd, '\n', '\n')
      : ''
    const isFolded = foldState ? foldState.collapsedSet.has(blockStart) : false
    // 祖先(heading / list_item)折叠把本 code_block 隐了:pre 已被
    // velo-folded display:none,但 header widget 是 pre 的 side:-1 sibling
    // (不在 pre 内部,velo-folded 影响不到),不跳过会孤零零浮在 fold 区段
    // 外 → heading 折叠"没收起代码块"。跳过整个 header(连同 token inline
    // decoration 一起,pre 既隐高亮也无意义),展开帧 isCodeBlockFolded 翻
    // false → header 重建 → 完整回归(同 CodeLineNumberWidget / MermaidDecoration
    // 范式)。**自身折叠(isFolded)不跳过**:header 是自身折叠的摘要
    // (行数 + 语言 + 复制),必须保留。
    if (!isFolded && isCodeBlockFolded(pos)) return
    const key = `code-header:${pos}:${lang}:${hashCode(code)}:${isFolded}`
    decos.push(
      Decoration.widget(pos, (view, _getPos) => {
        return makeHeaderDom(
          pos,
          lang,
          () => code,
          isFolded,
          () => {
            if (!view || view.isDestroyed) return
            view.dispatch(view.state.tr.setMeta(foldKey, { toggle: blockStart }))
          },
          (newLang: string) => {
            if (!view || view.isDestroyed) return
            setCodeBlockLanguage(view.state, pos, newLang, (tr) => {
              view.dispatch(tr)
            })
          },
          () => {
            if (!view || view.isDestroyed) return
            view.focus()
            const $pos = view.state.doc.resolve(blockStart)
            view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
          },
        )
      }, {
        side: -1,
        key,
        ignoreSelection: true,
        // stopEvent:true 让 PM 不拦截来自 widget 内部的事件(mousedown / keydown /
        // input / focus 等)。不加时 PM 的 eventBelongsToView 认为 widget 内的事件
        // "属于编辑器" → mousedown → selection 变化 → DOMObserver 反推选区 →
        // 光标被拉出 input(与 math_block NodeView stopEvent 同源坑,见
        // editor.md "NodeView 必须实现 stopEvent")。按钮(fold / copy)自己
        // mousedown preventDefault + stopPropagation,不依赖 stopEvent,这里
        // 返回 true 对它们无影响。
        stopEvent: () => true,
      }),
    )
    if (!lang) return
    if (blockStart >= blockEnd) return

    // ★ mermaid 旁路:shiki mermaid grammar 实际是"摆设"(codeToTokens 全输出
    // defaultText 默认色,无 scope),不调 shiki codeToTokens,走自写轻量
    // tokenizer。tokenizeMermaid 输出 {content, offset, type},type 是我们定义
    // 的 keyword/direction/shape/edge/label/comment。
    //
    // **颜色来自当前代码块主题**:getMermaidColors 从 hl.getTheme(light/dark)
    // .settings 按 scope 提取代表性 hex,写进 inline `--shiki-light:${hex};
    // --shiki-dark:${hex}` 局部 CSS 变量 —— 跟 shiki token **完全同形**,SCSS
    // 那边 `color: var(--shiki-light)` 的 cascade 选色机制直接复用:
    //   - 代码块主题切换(App.vue watch → dispatch setMeta → rebuild)→ 新 hex
    //   - dark/light 切换(纯 CSS cascade,零重渲)
    // hl 还没 ready 时 colors 为 null,本次不出 inline decoration(走默认色),
    // 等 hl ready 后 App.vue / plugin view factory 会 dispatch setMeta 触发 rebuild。
    if (lang === 'mermaid') {
      const colors = getMermaidColors(hl, lightTheme, darkTheme)
      if (!colors) return
      const mermaidLines = tokenizeMermaid(code)
      for (const line of mermaidLines) {
        for (const token of line) {
          const from = blockStart + token.offset
          const to = from + token.content.length
          if (from >= to || from < blockStart || to > blockEnd) continue
          const c = colors[token.type]
          if (!c) continue
          const parts: string[] = []
          if (c.light) parts.push(`--shiki-light:${c.light}`)
          if (c.dark) parts.push(`--shiki-dark:${c.dark}`)
          if (parts.length === 0) continue
          decos.push(
            Decoration.inline(from, to, {
              style: parts.join(';'),
            }),
          )
        }
      }
      return
    }

    if (!hl) return
    // inline decoration:code_block 内部的 text 加 token color。
    // 走 LRU 缓存版本 —— 同 (lang + 两套主题 + content-hash) 命中跳过 shiki 同步分词,
    // 是 per-keystroke 性能的关键路径(详见 CodeBlockLangs.ts 注释)。
    const result = getTokensCached(hl, code, lang, lightTheme, darkTheme)
    if (!result) return
    const { tokens } = result
    // shiki 的 ThemedToken.offset 是"相对于输入 code 字符串开头"的全局偏移
    // (不是行内偏移),所以直接 blockStart + token.offset 即可。早期实现里
    // 又加了一层 lineOffsets[li],导致 offset 双重累加 → 高亮错位(单字符
    // 落错位置,相邻 token 互相覆盖)。
    //
    // **dual themes**:`codeToTokensWithThemes` + `defaultColor: false` 模式
    // 下 token 是 ThemedTokenWithVariants,hex 颜色在 variants.light /
    // variants.dark 两套里。每个 span 写自己 light/dark 颜色到 inline
    // style(--shiki-light / --shiki-dark 局部 CSS 变量),pre 自身用
    // `color: var(--shiki-light)` 走 CSS cascade 选色,切 <html class="dark">
    // 时翻面到 dark,ProseMirror / shiki 不参与(零重渲)。
    for (const line of tokens) {
      for (const token of line) {
        const from = blockStart + token.offset
        const to = from + token.content.length
        if (from >= to) continue
        if (from < blockStart || to > blockEnd) continue
        const light = token.variants?.light?.color
        const dark = token.variants?.dark?.color
        if (!light && !dark) continue
        const parts: string[] = []
        if (light) parts.push(`--shiki-light:${light}`)
        if (dark) parts.push(`--shiki-dark:${dark}`)
        decos.push(
          Decoration.inline(from, to, {
            style: parts.join(';'),
          }),
        )
      }
    }
  })
  return DecorationSet.create(state.doc, decos)
}

// ============================================================
//  Plugin
// ============================================================

export const codeHighlightPlugin = new Plugin<CodeHighlightState>({
  key: codeHighlightKey,
  state: {
    init() {
      // 同步从 cached highlighter 拿 hl(PM mount 时 App.vue codeBlockReady
      // 守门已 await getHighlighter() 完成 → cachedHighlighter 必然非空),
      // initialState.highlighter 直接填好,plugin.decorations 第一次跑就
      // 写 token inline style → 首屏零闪烁。
      // 主题从 store 读,App.vue setup 顶层 initSettings() 已 hydrate 完。
      return makeInitialState()
    },
    apply(tr, prev) {
      const meta = tr.getMeta(codeHighlightKey) as
        | { highlighter?: Highlighter, lightTheme?: string, darkTheme?: string }
        | undefined
      if (!meta) return prev
      return {
        highlighter: meta.highlighter ?? prev.highlighter,
        lightTheme: meta.lightTheme ?? prev.lightTheme,
        darkTheme: meta.darkTheme ?? prev.darkTheme,
      }
    },
  },
  props: {
    decorations(state) {
      const s = codeHighlightKey.getState(state)
      if (!s) return null
      return buildDecorations(state, s.highlighter, s.lightTheme, s.darkTheme)
    },
  },
  view: (view) => {
    // **首屏零闪烁机制**:
    //   1) App.vue setup 内 `codeBlockReady` 守门,等 `await getHighlighter(
    //      store.codeLightTheme, store.codeDarkTheme) + ensureTheme(...)`
    //      完成才翻 true,ProseMirrorEditor 子组件才 mount。
    //   2) PM mount → plugin `state.init` 同步从 `getHighlighterSync()` 拿
    //      cached hl(已 resolve),initialState.highlighter 直接填好 →
    //      `decorations(state)` 第一次跑就有 token style。
    //   3) 主题从 store 同步读(`useEditorStore()` 在 component context
    //      内可用,init 时已就绪)。
    // → 第一次 view 绘制时,代码块 token 颜色就是用户主题色,零闪烁。
    //
    // 本 view factory 仍保留 setMeta dispatch 作为防御性兜底(防个别 race
    // 场景 state.init 时 hl 还没 ready,但 App.vue codeBlockReady 已守门,
    // 正常路径下这是 noop —— state.highlighter 已经被 init 填好,apply
    // 改写后值不变)。
    //
    // 后续"用户在 settings 面板切主题"路径由 App.vue 4.5 段 watch 走
    // `ensureTheme` 追加 + dispatch setMeta 触发 rebuild,跟这里正交。
    ;(async () => {
      const store = useEditorStore()
      const light = store.codeLightTheme || DEFAULT_LIGHT_THEME
      const dark = store.codeDarkTheme || DEFAULT_DARK_THEME
      // 即便 state.init 已经同步拿了 hl,这里再 ensureTheme 一次保证
      // "用户主题确实装上了"(防 init 时 cached 来自别的早调用方但装的是
      // DEFAULT 主题 —— 当前 App.vue codeBlockReady 已 ensure 过,理论上
      // cached 的 hl 已经装好用户主题,这里 ensureTheme 是幂等保险)。
      const hlReady = await ensureTheme(light)
      await ensureTheme(dark)
      if (view.isDestroyed) return
      const s = codeHighlightKey.getState(view.state)
      // 防御:仅在 hl/主题与 state 不一致时 dispatch,避免无谓的 state mutation
      if (!s || s.highlighter !== hlReady || s.lightTheme !== light || s.darkTheme !== dark) {
        view.dispatch(view.state.tr.setMeta(codeHighlightKey, {
          highlighter: hlReady,
          lightTheme: light,
          darkTheme: dark,
        }))
      }
    })().catch((err) => {
      console.warn('[codeHighlight] shiki highlighter 加载失败:', err)
    })

    // **Deco rebuild 通知钩子**:ensureLanguage resolve 后通过这个 callback
    // 通知 plugin 重新跑 `decorations(state)`(rAF 节流避免一帧多次 rebuild)。
    // 一次粘贴 10 个未装 lang → 10 个 ensureLanguage resolve 全部 coalesce
    // 到下一帧一次 dispatch。destroy 时清空 callback + 取消未触发的 rAF,
    // 防止 zombie dispatch 到已销毁 view(否则 throw)。
    let rafId = 0
    setDecorationRebuildCallback(() => {
      if (view.isDestroyed) return
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        if (view.isDestroyed) return
        const s = codeHighlightKey.getState(view.state)
        if (!s) return
        // dispatch 同 highlighter / 主题的 setMeta → state.apply 跑 → 新 state
        // 触发 `decorations(state)` 重新跑 → getTokensCached 重新调到(此时
        // ensureLanguage 已 resolve,lang 已 in hl.getLoadedLanguages())→ 出 token
        view.dispatch(view.state.tr.setMeta(codeHighlightKey, {
          highlighter: s.highlighter,
          lightTheme: s.lightTheme,
          darkTheme: s.darkTheme,
        }))
      })
    })
    return {
      destroy: () => {
        if (rafId) {
          cancelAnimationFrame(rafId)
          rafId = 0
        }
        setDecorationRebuildCallback(null)
      },
    }
  },
})

// ============================================================
//  Command: setCodeBlockLanguage
// ============================================================

/**
 * 改 code_block 的 language attr。setNodeAttribute 不会改变 text 也不会
 * 触发 syntax 转换,syntax 框架基于 text tr.mapping,不挂这条路径。
 */
export function setCodeBlockLanguage(
  state: EditorState,
  pos: number,
  lang: string,
  dispatch?: (tr: Transaction) => void,
): boolean {
  const node = state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'code_block') return false
  if (dispatch) {
    const tr = state.tr.setNodeAttribute(pos, 'language', lang)
    dispatch(tr)
  }
  return true
}

// ============================================================
//  Helpers(测试可见)
// ============================================================

export { buildDecorations, makeHeaderDom, writeToClipboard }
