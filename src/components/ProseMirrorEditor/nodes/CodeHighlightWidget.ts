// 代码块高亮 —— inline decoration(高亮) + widget(工具条)。
//
// 为什么不走 NodeView:
//   NodeView 的 outer dom 改 innerHTML 会被 ProseMirror DOMObserver 当外部
//   突变,触发 view.updateState → NodeView 重建闪烁(详见 mermaid 同样教训)。
//
// 走 ProseMirror 标准做法:
//   1. 工具条:Decoration.widget(pos, toDOM, { side: -1, key })
//      prosemirror-view v1.41 的 d.ts 没 export WidgetType 类(运行时
//      是有的,只是类型层面),这里直接传 (view, getPos) => DOMNode 函数。
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
// widget key 必须含 lang + 文本 hash —— lang 变化时 ProseMirror 会复用
// 同 key 的 widget DOM 导致按钮文字不更新;docChange 时 inline decoration
// 已经走 state 自动 rebuild,但 widget 走的是 toDOM 缓存,所以 key 也得跟。

import { Plugin, PluginKey } from 'prosemirror-state'
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
} from './CodeBlockLangs'
import { tokenizeMermaid } from './mermaidTokenizer'
import { writeClipboardText } from '@/utils/clipboard'
import { checkSvg, chevronDownSvg, copySvg } from '@/components/icons/widgetIcons'
import { langIconSvg } from './langIcons'

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
//  Toolbar widget factory —— prosemirror-view 接受 (view, getPos) => DOMNode
// ============================================================

/** 工具条 toDOM 工厂。widget key 由 spec.key 控制,toDOM 不需要做对比。
 *  - pos:code_block 节点 pos(本 widget 在 pos 之前,side: -1)
 *  - lang:当前语言
 *  - getCode:同步拿 code_block 文本(切 lang 时变 → widget key 变)
 *  - getPreEl:从 view 拿 pos 处 code_block 的 DOM `<pre>` 元素,
 *    用于 widget 绝对定位浮在 pre 内部右上角。
 *    prosemirror widget 永远在 pre 之**外**(side: -1 是 pre 前一个兄弟),
 *    不能嵌进 pre DOM;走 absolute + JS 同步位置浮进去。
 */
function makeToolbarDom(
  pos: number,
  lang: string,
  getCode: () => string,
  getPreEl: () => HTMLElement | null,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'velo-code-toolbar-widget text-gray-400'
  wrap.contentEditable = 'false'
  wrap.setAttribute('data-pos', String(pos))
  wrap.setAttribute('data-lang', lang)
  // widget 自身 absolute 定位(由 syncPosition 同步 top/right 到 pre 内部右上角)
  wrap.style.position = 'absolute'
  wrap.style.zIndex = '2'

  // 同步位置:把 widget 浮到 pre 内部右上角(preRect + offsetParent 换算)
  function syncPosition() {
    const preEl = getPreEl()
    if (!preEl) return
    const op = wrap.offsetParent as HTMLElement | null
    if (!op) return
    const preRect = preEl.getBoundingClientRect()
    const opRect = op.getBoundingClientRect()
    // top:pre 顶边 + 6px 留白(在 pre padding 区内)
    const topInOp = (preRect.top - opRect.top) + op.scrollTop + 6
    const rightInOp = (opRect.right - preRect.right) + op.scrollLeft + 8
    wrap.style.top = `${topInOp}px`
    wrap.style.right = `${rightInOp}px`
  }

  // rAF 节流:scroll / resize / RO 在同一帧多次触发 → 只算一次。
  // 没有节流时高速滚动每像素都跑一次 getBoundingClientRect×2 + inline 写,
  // 浏览器 paint 前排队阻塞,看起来"工具条黏手"。
  let rafId = 0
  function scheduleSync() {
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      syncPosition()
    })
  }

  // mount 后等一帧同步(等 PM 完成 DOM 挂载)
  requestAnimationFrame(() => syncPosition())
  // 监听 window resize / scroll(同步 panel 整体视口位置)
  window.addEventListener('resize', scheduleSync)
  window.addEventListener('scroll', scheduleSync, true)
  // 监听 pre 自身 + pre.offsetParent(PM 编辑区容器)的 resize。
  // 仅监听 window.resize/scatch 命中不了"设置/大纲面板挤压 PM 编辑区"
  // 这类内部 layout 变化 —— 大纲开合的瞬间 PM 容器宽度变了,但窗口没
  // resize、window 没 scroll,工具条 widget 的 inline style 还是旧的,
  // 看起来"漂到其他地方"。把 offsetParent 也接进 RO,容器一缩工具条跟着压。
  //
  // **必须在 RAF 之后再拿 offsetParent**:makeToolbarDom 同步执行时 wrap
  // 还没挂到 DOM,offsetParent 是 null;RAF 后 PM 把 widget 挂好,offsetParent
  // 才是真实定位祖先(可能是 .velo-editor / 最近的transformed 容器,看 flex 链)。
  //
  // **scroll listener 同样挂到 offsetParent 上**:index.vue 里编辑器外层
  // 有 `overflow-auto` 滚动容器,容器滚动事件不会冒泡到 window —— 挂在
  // window 上只靠 capture 兜底,事件延迟 + 1 帧;直接挂 offsetParent 命中
  // 更直接。
  let ro: ResizeObserver | null = null
  let scrollParent: HTMLElement | null = null
  requestAnimationFrame(() => {
    if (typeof ResizeObserver === 'undefined') return
    ro = new ResizeObserver(scheduleSync)
    const pre = getPreEl()
    if (pre) ro.observe(pre)
    const op = wrap.offsetParent as HTMLElement | null
    if (op && op !== pre) {
      ro.observe(op)
      // 滚动容器通常是 offsetParent 的某个祖先(可能不止一层),递归往上找
      // 第一个 overflow-y: auto/scroll 的祖先,挂 scroll listener 直接命中
      let sp: HTMLElement | null = op.parentElement
      while (sp && sp !== document.body) {
        const cs = getComputedStyle(sp)
        if (cs.overflowY === 'auto' || cs.overflowY === 'scroll'
          || cs.overflow === 'auto' || cs.overflow === 'scroll') {
          scrollParent = sp
          sp.addEventListener('scroll', scheduleSync, { passive: true })
          break
        }
        sp = sp.parentElement
      }
    }
  })
  // widget 销毁时清监听(用 MutationObserver 跟 widget 自身脱离)
  const mo = new MutationObserver(() => {
    if (!wrap.isConnected) {
      window.removeEventListener('resize', scheduleSync)
      window.removeEventListener('scroll', scheduleSync, true)
      scrollParent?.removeEventListener('scroll', scheduleSync)
      ro?.disconnect()
      mo.disconnect()
    }
  })
  mo.observe(document.body, { childList: true, subtree: true })

  // 语言按钮(下拉箭头 + lang 名)
  const langBtn = document.createElement('button')
  langBtn.type = 'button'
  langBtn.className = 'velo-code-lang-btn'
  langBtn.title = '选择语言'
  langBtn.contentEditable = 'false'
  // 按钮内容:语言图标(品牌色由 devicon body 自带 fill,兜底项走单色) + lang 名 + chevron
  langBtn.innerHTML = `${langIconSvg(lang, 12)}<span class="velo-lang-label">${escapeHtml(lang || 'plain text')}</span>${chevronDownSvg(10)}`
  langBtn.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  langBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    // 通过事件冒泡让父级 (index.vue) 收到,父级从 widget DOM 读 pos
    wrap.dispatchEvent(new CustomEvent('velo:open-lang-picker', {
      detail: { pos, lang, anchor: langBtn },
      bubbles: true,
    }))
  })
  wrap.appendChild(langBtn)

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
  state.doc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== 'code_block') return
    const lang = (node.attrs.language as string) || ''
    // 注意:mermaid 与普通 code_block 共用本 toolbar(语言选择 + 复制)。
    // MermaidDecoration 的 widget 锚在 pos + nodeSize + side: 1(pre 之后),
    // 本 toolbar 锚在 pos + side: -1(pre 之前)→ 两个 widget DOM 位置不冲突,
    // mermaid 走 MermaidDecoration 的额外 SVG / 切换源码 / 删除按钮 / 关闭按钮。
    // 工具条 widget —— key 含 lang + 文本 hash,lang 变 / 文本变都强制重挂,
    // 否则 ProseMirror 复用旧 DOM 按钮文字不更新。
    const blockStart = pos + 1
    const blockEnd = pos + node.nodeSize - 1
    const code = blockStart < blockEnd
      ? state.doc.textBetween(blockStart, blockEnd, '\n', '\n')
      : ''
    const key = `code-toolbar:${pos}:${lang}:${hashCode(code)}`
    decos.push(
      Decoration.widget(pos, (view, getPos) => {
        // prosemirror-view 工厂签名:(view, getPos) => DOMNode
        // getPreEl:从 view 拿 pos 处 code_block 的 DOM <pre>
        return makeToolbarDom(
          pos,
          lang,
          () => code,
          () => {
            if (!view || view.isDestroyed) return null
            try {
              const node = view.nodeDOM(getPos?.() ?? pos) as HTMLElement | null
              // nodeDOM 可能是 <pre> 本身(就是它),也可能包一层;pre 标签即 nodeDOM
              return node?.tagName === 'PRE' ? node : node?.querySelector('pre') ?? null
            }
            catch { return null }
          },
        )
      }, {
        side: -1,
        key,
        ignoreSelection: true,
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

export { buildDecorations, makeToolbarDom, writeToClipboard }
