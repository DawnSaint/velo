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
import { checkSvg, chevronDownSvg, copySvg, wrapTextSvg, nowrapSvg } from '@/components/icons/widgetIcons'
import { langIconSvg } from './langIcons'
import { foldKey, isCodeBlockAncestorFolded } from './FoldDecoration'
import { codeWrapKey, isCodeBlockWrapped } from './CodeWrapPlugin'
import { mermaidDecoKey } from './MermaidDecoration'
import { scanDoc } from './docScanCache'
import { getViewport, isInViewport, viewportKey } from './viewportPlugin'

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
  /** 缓存的 DecorationSet;null 表示需要全量重建。
   *  增量更新策略:apply 里 map 旧 set → 只重建 dirty range 内的 code_block
   *  decoration → 存回 state。decorations() 直接返回缓存,不再每次全量重建。 */
  decoSet: DecorationSet | null
}

/** 工厂:每次调都从 store 同步拿当前主题,factory 内不能直接用 ref(模块
 *  加载时 store 还没就绪),改在 state.init 内联调。 */
function makeInitialState(): CodeHighlightState {
  // store 在模块顶层还不可用(state.init 时已经在 component context)
  let light = DEFAULT_LIGHT_THEME
  let dark = DEFAULT_DARK_THEME
  try {
    const store = useEditorStore()
    // 用 != null 而非 falsy 判断:允许空字符串(NO_THEME 哨兵)通过
    if (store.codeLightTheme != null) light = store.codeLightTheme
    if (store.codeDarkTheme != null) dark = store.codeDarkTheme
  }
  catch { /* pinia 未就绪 / 单元测试场景,fallback DEFAULT */ }
  return {
    highlighter: getHighlighterSync(), // PM mount 时 App.vue codeBlockReady 守门后必然 ready
    lightTheme: light,
    darkTheme: dark,
    decoSet: null, // 首次 decorations() 调用时全量构建
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
 *  - isFolded:当前折叠状态(初始 chevron 方向 + data-fold-state;fold toggle
 *    依赖 click handler 手翻 attribute,key 不含此值,见下方 key 注释)
 *  - toggleFold:click chevron 时调,dispatch setMeta(foldKey, { toggle })
 *  - setLang:提交新语言时调,dispatch setNodeAttribute(language)
 *  - hideFoldBtn:true 时隐藏折叠 chevron(用于 mermaid 展开态 —— 避免与
 *    mermaid toolbar toggle 打斗,误触发 FoldDecoration 把 SVG 也吞掉;
 *    mermaid 的"收"由 mermaid toolbar toggle 承担,这里提供一个 fold 入口
 *    没意义)。header 本身仍渲染,语言选择 + 复制仍可用。
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
  isWrapped: boolean,
  toggleWrap: () => void,
  setLang: (lang: string) => void,
  focusCode: () => void,
  hideFoldBtn: boolean = false,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'velo-code-header-widget'
  wrap.contentEditable = 'false'
  wrap.setAttribute('data-pos', String(pos))
  wrap.setAttribute('data-lang', lang)
  wrap.setAttribute('data-fold-state', isFolded ? 'collapsed' : 'expanded')

  // 折叠 chevron —— 始终用 chevron-down,CSS rotate(-90deg) 实现折叠态。
  // mermaid 展开态 hideFoldBtn=true → 跳过 chevron(避免与 mermaid toolbar
  // toggle 打斗);其余 code_block 正常渲染。
  if (!hideFoldBtn) {
    const foldBtn = document.createElement('button')
    foldBtn.type = 'button'
    foldBtn.className = 'velo-icon-btn velo-code-fold-btn'
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
      // 与 heading / frontmatter fold 同范式(FoldDecoration.makeToggleButton /
      // FrontmatterNodeView):widget key 不含折叠状态,fold toggle 复用旧 header
      // DOM,factory 不重跑 → chevron 方向 + data-fold-state 不会自动翻。手动翻
      // data-fold-state + title,让 CSS transition 察觉属性变化,播放 0↔-90deg
      // 旋转;否则新 DOM 一开始就是终态(rotate -90deg),只会"闪烁一下直接变"。
      // 仅本 chevron 会切换 code_block 折叠(heading/list 走各自 contentStart),
      // wrap 的 data-fold-state 与 plugin state 一致,读它即当前态。
      const next = wrap.getAttribute('data-fold-state') === 'collapsed'
        ? 'expanded'
        : 'collapsed'
      wrap.setAttribute('data-fold-state', next)
      foldBtn.title = next === 'collapsed' ? '展开' : '折叠'
      foldBtn.setAttribute('aria-label', foldBtn.title)
      toggleFold()
    })
    wrap.appendChild(foldBtn)
  }

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

  // 自动换行 toggle 按钮(wrap):点击切换 pre 的 white-space 模式。
  // 与 fold/copy 按钮同款 mousedown preventDefault + stopPropagation +
  // click stopPropagation(防 index.vue onCardClick 抣焦点)。
  const wrapBtn = document.createElement('button')
  wrapBtn.type = 'button'
  wrapBtn.className = 'velo-icon-btn velo-code-wrap-btn'
  wrapBtn.title = isWrapped ? '取消自动换行' : '自动换行'
  wrapBtn.contentEditable = 'false'
  wrapBtn.innerHTML = isWrapped ? wrapTextSvg(14) : nowrapSvg(14)
  wrapBtn.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  wrapBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    toggleWrap()
  })
  wrap.appendChild(wrapBtn)

  // 复制按钮 —— widget 内部直接 await,避免跨组件 async 时序问题
  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'velo-icon-btn'
  copyBtn.setAttribute('data-testid', 'code-copy-btn')
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
//  构造 decorations —— per-node 构建函数
// ============================================================

/** 为单个 frontmatter 节点构建 token 高亮 inline decoration。 */
function buildDecosForFrontmatter(
  doc: PMNode,
  node: PMNode,
  pos: number,
  hl: Highlighter | null,
  lightTheme: string,
  darkTheme: string,
): Decoration[] {
  if (!hl) return []
  const lang = (node.attrs.lang as string) || 'yaml'
  const blockStart = pos + 1
  const blockEnd = pos + node.nodeSize - 1
  if (blockStart >= blockEnd) return []
  const code = doc.textBetween(blockStart, blockEnd, '\n', '\n')
  const result = getTokensCached(hl, code, lang, lightTheme, darkTheme)
  if (!result) return []
  return tokensToDecos(result.tokens, blockStart, blockEnd)
}

/** 为单个 code_block 节点构建 header widget + token 高亮 decoration。 */
function buildDecosForCodeBlock(
  doc: PMNode,
  node: PMNode,
  pos: number,
  isFolded: boolean,
  mermaidExpanded: boolean,
  hl: Highlighter | null,
  lightTheme: string,
  darkTheme: string,
): Decoration[] {
  const decos: Decoration[] = []
  const lang = (node.attrs.language as string) || ''
  const isMermaid = lang === 'mermaid'
  const renderHeader = !isMermaid || mermaidExpanded
  const blockStart = pos + 1
  const blockEnd = pos + node.nodeSize - 1
  const code = blockStart < blockEnd
    ? doc.textBetween(blockStart, blockEnd, '\n', '\n')
    : ''
  const isWrapped = isCodeBlockWrapped(pos)
  if (isCodeBlockAncestorFolded(pos)) return []
  if (renderHeader) {
    const key = `code-header:${pos}:${lang}:${hashCode(code)}:${isWrapped}`
    decos.push(
      Decoration.widget(pos, (view, _getPos) => {
        return makeHeaderDom(
          pos, lang, () => code, isFolded,
          () => {
            if (!view || view.isDestroyed) return
            view.dispatch(view.state.tr.setMeta(foldKey, { toggle: blockStart }))
          },
          isWrapped,
          () => {
            if (!view || view.isDestroyed) return
            view.dispatch(view.state.tr.setMeta(codeWrapKey, { toggle: pos }))
          },
          (newLang: string) => {
            if (!view || view.isDestroyed) return
            setCodeBlockLanguage(view.state, pos, newLang, (tr) => { view.dispatch(tr) })
          },
          () => {
            if (!view || view.isDestroyed) return
            view.focus()
            const $pos = view.state.doc.resolve(blockStart)
            view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
          },
          mermaidExpanded,
        )
      }, { side: -1, key, ignoreSelection: true, stopEvent: () => true }),
    )
  }
  if (!lang || blockStart >= blockEnd) return decos

  if (lang === 'mermaid') {
    const colors = getMermaidColors(hl, lightTheme, darkTheme)
    if (!colors) return decos
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
        decos.push(Decoration.inline(from, to, { style: parts.join(';') }))
      }
    }
    return decos
  }

  if (!hl) return decos
  const result = getTokensCached(hl, code, lang, lightTheme, darkTheme)
  if (!result) return decos
  return decos.concat(tokensToDecos(result.tokens, blockStart, blockEnd))
}

/** shiki tokens → Decoration.inline 数组。 */
function tokensToDecos(
  tokens: import('shiki').ThemedTokenWithVariants[][],
  blockStart: number,
  blockEnd: number,
): Decoration[] {
  const decos: Decoration[] = []
  for (const line of tokens) {
    for (const token of line) {
      const from = blockStart + token.offset
      const to = from + token.content.length
      if (from >= to || from < blockStart || to > blockEnd) continue
      const light = token.variants?.light?.color
      const dark = token.variants?.dark?.color
      if (!light && !dark) continue
      const parts: string[] = []
      if (light) parts.push(`--shiki-light:${light}`)
      if (dark) parts.push(`--shiki-dark:${dark}`)
      if (parts.length === 0) continue
      decos.push(Decoration.inline(from, to, { style: parts.join(';') }))
    }
  }
  return decos
}

/** 全量构建:遍历 code_block + frontmatter,生成 DecorationSet。
 *  B1 viewport 感知:只为视口内(及 buffer)节点构建 decoration,视口外跳过。 */
function buildDecorations(
  state: EditorState,
  hl: Highlighter | null,
  lightTheme: string,
  darkTheme: string,
): DecorationSet {
  const decos: Decoration[] = []
  const foldState = foldKey.getState(state)
  const mermaidState = mermaidDecoKey.getState(state)
  const scan = scanDoc(state.doc)
  const viewport = getViewport(state)
  for (const { node, pos } of scan.frontmatters) {
    if (!isInViewport(pos, node.nodeSize, viewport)) continue
    decos.push(...buildDecosForFrontmatter(state.doc, node, pos, hl, lightTheme, darkTheme))
  }
  for (const { node, pos } of scan.codeBlocks) {
    if (!isInViewport(pos, node.nodeSize, viewport)) continue
    const blockStart = pos + 1
    const isFolded = foldState ? foldState.collapsedSet.has(blockStart) : false
    const mermaidExpanded = Boolean(mermaidState?.editNodeSet.has(blockStart))
    decos.push(...buildDecosForCodeBlock(
      state.doc, node, pos, isFolded, mermaidExpanded, hl, lightTheme, darkTheme,
    ))
  }
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
    apply(tr, prev, oldState, newState) {
      const meta = tr.getMeta(codeHighlightKey) as
        | { highlighter?: Highlighter, lightTheme?: string, darkTheme?: string }
        | undefined
      // 主题/highlighter 变化或语言加载完成 → 全量重建
      if (meta) {
        return {
          highlighter: meta.highlighter ?? prev.highlighter,
          lightTheme: meta.lightTheme ?? prev.lightTheme,
          darkTheme: meta.darkTheme ?? prev.darkTheme,
          decoSet: null,
        }
      }
      // fold / mermaid / codeWrap 状态变化 → header 渲染变化 → 全量重建
      if (tr.getMeta(foldKey) || tr.getMeta(mermaidDecoKey) || tr.getMeta(codeWrapKey)) {
        return { ...prev, decoSet: null }
      }
      // viewport 变化(滚动)→ 全量重建,buildDecorations 会按新 viewport 过滤
      if (tr.getMeta(viewportKey)) {
        return { ...prev, decoSet: null }
      }
      // selection-only 交易(光标移动 / 选区变化):decorations 不变,返回同一引用
      // → PM 跳过 decoration diff,不重建 DOM。
      if (!tr.docChanged) {
        return prev
      }
      // prev.decoSet 为 null:上一帧标记了全量重建,这里保持 null 让 decorations() 处理
      if (!prev.decoSet) {
        return prev
      }

      // 增量更新:map 旧 set → 只重建 dirty range 内 code_block/frontmatter 的 decoration
      let newSet = prev.decoSet.map(tr.mapping, tr.doc)

      // 从 tr.steps 提取 dirty ranges(新 doc 坐标)
      const dirtyRanges: Array<{ from: number; to: number }> = []
      for (const step of tr.steps) {
        step.getMap().forEach((_os, _oe, ns, ne) => {
          dirtyRanges.push({ from: ns, to: ne })
        })
      }
      if (dirtyRanges.length === 0) {
        return { ...prev, decoSet: newSet }
      }

      // 找到与 dirty ranges 有交集的 code_block / frontmatter
      const scan = scanDoc(tr.doc)
      const foldState = foldKey.getState(oldState)
      const mermaidState = mermaidDecoKey.getState(oldState)

      const affectedCodeBlocks: Array<{ pos: number; node: PMNode }> = []
      const affectedFrontmatters: Array<{ pos: number; node: PMNode }> = []
      for (const range of dirtyRanges) {
        for (const { node, pos } of scan.codeBlocks) {
          if (pos + node.nodeSize >= range.from && pos <= range.to) {
            if (!affectedCodeBlocks.some(cb => cb.pos === pos)) {
              affectedCodeBlocks.push({ pos, node })
            }
          }
        }
        for (const { node, pos } of scan.frontmatters) {
          if (pos + node.nodeSize >= range.from && pos <= range.to) {
            if (!affectedFrontmatters.some(fm => fm.pos === pos)) {
              affectedFrontmatters.push({ pos, node })
            }
          }
        }
      }

      if (affectedCodeBlocks.length === 0 && affectedFrontmatters.length === 0) {
        return { ...prev, decoSet: newSet }
      }

      // 移除受影响节点的旧 decoration,再重建添加
      for (const { pos, node } of affectedCodeBlocks) {
        const found = newSet.find(pos, pos + node.nodeSize)
        newSet = newSet.remove(found)
      }
      for (const { pos, node } of affectedFrontmatters) {
        const found = newSet.find(pos, pos + node.nodeSize)
        newSet = newSet.remove(found)
      }

      const newDecos: Decoration[] = []
      const viewport = getViewport(newState)
      for (const { node, pos } of affectedFrontmatters) {
        if (!isInViewport(pos, node.nodeSize, viewport)) continue
        newDecos.push(...buildDecosForFrontmatter(
          tr.doc, node, pos, prev.highlighter, prev.lightTheme, prev.darkTheme,
        ))
      }
      for (const { node, pos } of affectedCodeBlocks) {
        if (!isInViewport(pos, node.nodeSize, viewport)) continue
        const blockStart = pos + 1
        const isFolded = foldState ? foldState.collapsedSet.has(blockStart) : false
        const mermaidExpanded = Boolean(mermaidState?.editNodeSet.has(blockStart))
        newDecos.push(...buildDecosForCodeBlock(
          tr.doc, node, pos, isFolded, mermaidExpanded,
          prev.highlighter, prev.lightTheme, prev.darkTheme,
        ))
      }
      if (newDecos.length > 0) {
        newSet = newSet.add(tr.doc, newDecos)
      }

      return { ...prev, decoSet: newSet }
    },
  },
  props: {
    decorations(state) {
      const s = codeHighlightKey.getState(state)
      if (!s) return null
      // decoSet 为 null:全量重建(首次加载 / 主题切换 / fold/mermaid 变化)
      if (!s.decoSet) {
        return buildDecorations(state, s.highlighter, s.lightTheme, s.darkTheme)
      }
      return s.decoSet
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
    // 后续"用户在 settings 面板切主题"路径由 App.vue 的 codeLightTheme/codeDarkTheme
    // watch 走 `ensureTheme` 追加 + dispatch setMeta 触发 rebuild,跟这里正交。
    ;(async () => {
      const store = useEditorStore()
      // ensureTheme 需要 valid theme id,空字符串(NO_THEME)用 DEFAULT 兼容;
      // 但 dispatch 给 plugin 的 lightTheme/darkTheme 用 store 原值(可能为 ''),
      // getTokensSync 据此跳过渲染。
      const lightEns = store.codeLightTheme || DEFAULT_LIGHT_THEME
      const darkEns = store.codeDarkTheme || DEFAULT_DARK_THEME
      // 即便 state.init 已经同步拿了 hl,这里再 ensureTheme 一次保证
      // "用户主题确实装上了"(防 init 时 cached 来自别的早调用方但装的是
      // DEFAULT 主题 —— 当前 App.vue codeBlockReady 已 ensure 过,理论上
      // cached 的 hl 已经装好用户主题,这里 ensureTheme 是幂等保险)。
      const hlReady = await ensureTheme(lightEns)
      await ensureTheme(darkEns)
      if (view.isDestroyed) return
      // **始终 dispatch**:state.init 从 store 同步读到主题名,但主题 hex
      // 可能尚未 loaded(PM 重挂载时若 App.vue watch 的 ensureTheme 还在
      // 异步路上 / 或设置页切换主题后 PM 卸载期间未预装)。此情况下
      // decorations 首帧拿 undefined token color → 全黑;ensureTheme resolve
      // 后必须 dispatch setMeta 触发 rebuild 才能出真色。若主题已 loaded,
      // dispatch 后 apply 返回等价 state、decorations 重算结果不变,PM 不
      // 更新 DOM —— 无副作用。对照 SourceModeEditor onMounted 的同款范式
      // (ensureMarkdownGrammar 后始终 dispatch setShikiTheme)。
      view.dispatch(view.state.tr.setMeta(codeHighlightKey, {
        highlighter: hlReady,
        lightTheme: store.codeLightTheme,
        darkTheme: store.codeDarkTheme,
      }))
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
