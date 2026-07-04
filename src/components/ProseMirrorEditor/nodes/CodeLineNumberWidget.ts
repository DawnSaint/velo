// WYSIWYG code_block 行号(v0.5.11,可选开关)
//
// 为什么走 Decoration.widget 而非 NodeView / inline decoration:
//   - NodeView:改 outerHTML 会被 PM DOMObserver 当外部突变 → 重建闪烁
//     (见 CodeHighlightWidget.ts:4-5、MermaidDecoration.ts:2-3 的踩坑记录)。
//   - inline decoration:只能加 class/style 到现有 text node 范围,无法注入
//     新的 DOM 元素(<div>),不能画 gutter 列。
//   - 走 widget 是 ProseMirror 装饰 + 自管子元素的标准范式,与 TOC 目录
//     嵌套列表同形(单一 widget 内部渲染 N 个子节点,key 含 pos+hash
//     触发重建)。
//
// 与 toolbar 浮层机制的对比:
//   - toolbar 浮在 pre 右上(CSS `position: absolute`,JS 同步 top/right,
//     widget key 含 lang + text hash,lineNumbers 不重置)。本 widget 浮在
//     pre 左侧(top/left),key 含 pos + lineCount + lang。两个 widget 都
//     走同一套 syncPosition + ResizeObserver + scrollParent 同步机制,
//     是有意为之的复制(toolbar 已踩过的坑:offsetParent 在 widget 挂到
//     DOM 前是 null,必须 rAF 后再拿;scroll 容器是 index.vue 的
//     overflow-auto 外层,不冒泡到 window,要手动 walk up 找)。
//   - 行号不需要 hover 显示,常驻在 pre 左侧,opacity 0.5 兑水,不抢
//     视觉焦点。pointer-events: none,不响应点击(v0.5.11 不做点击跳光标)。
//
// mermaid code_block:不挂 widget。理由 —— 渲染态 SVG 取代 pre 显示,
//   行号与 SVG 并排视觉割裂;源码编辑态(SVG 隐藏,pre 显示)再开行号
//   才有意义。但 v0.5.11 用户确认"始终不显示",所以直接 lang === 'mermaid'
//   跳过整个装饰分支。
//
// schema 0 改动 / markdown 0 改动:行号是纯视觉装饰,完全在 decoration 层。
//
// 设计取舍(坑):
//   - line-height 必须与 .velo-editor pre 完全一致(1.6)。子元素
//     .velo-code-gutter-line 不允许加 padding/margin/border,任何 padding
//     都会让 N 号行偏一像素。SCSS 已写明禁止项。
//   - 显式 min-width 预留 3 位数字宽度(2.4em),跨 1~999 行不抖动。
//   - 关闭态(enabled=false)走 DecorationSet.empty,而不是返回包含空
//     decoration 的集合 —— ProseMirror 区分"空"和"空集合"语义。
//   - 重建策略:不主动 rebuild(不像 mermaid 那种 SVG 异步渲染),widget
//     同步生成 N 个 div,docChanged 触发 decorations() 重跑,key 变化
//     时 ProseMirror 自己 recreate widget(走与 TOC 相同的 WidgetType 缓存
//     机制)。
//
// 性能(N = doc 中 code_block 数量,实测 ~0.2ms/callback,包含两次
//   getBoundingClientRect + 一次 transform 写):
//   - N=10-20(典型文档):每帧 ~2-4ms,远低于 16ms 预算,无感知。
//   - N=50:每帧 ~10ms,接近预算,需关注但仍可接受。
//   - N=100+:每帧 ~20ms,超预算,会掉帧。优化方向:
//     ① 共享 rAF(一个 rAF 遍历所有 widget,避免 N 个 rAF 调度开销)。
//     ② 共享 ResizeObserver(一个 RO 观察所有 pre + 关键祖先)。
//     ③ 跳过视口外的 widget(off-screen 不需要 syncPosition)。v0.5.11
//     不实现,留作后续 N 大时的优化点。

import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { useEditorStore } from '@/stores/editor'
import { isCodeBlockFolded } from './FoldDecoration'

// ============================================================
//  Plugin state
// ============================================================

interface LineNumberState {
  /** 当前是否启用行号。设置面板开关切换 → App.vue 走 setMeta 翻这个值。 */
  enabled: boolean
}

/** 工厂:每次调都从 store 同步拿当前值,factory 内不能直接用 ref(模块
 *  加载时 store 还没就绪,改在 state.init 内联调)。 */
function makeInitialState(): LineNumberState {
  let enabled = false
  try {
    const store = useEditorStore()
    if (typeof store.showCodeLineNumbers === 'boolean') {
      enabled = store.showCodeLineNumbers
    }
  }
  catch { /* pinia 未就绪 / 单元测试场景,fallback false */ }
  return { enabled }
}

export const lineNumbersKey = new PluginKey<LineNumberState>('codeLineNumbers')

// ============================================================
//  Widget factory —— 单一 widget 内部 N 个 .velo-code-gutter-line 子 div
// ============================================================

/** 工具条 toDOM 工厂。widget key 由 spec.key 控制,toDOM 不需要做对比。
 *  - pos:code_block 节点 pos(本 widget 在 pos 之前,side: -1)
 *  - lang:当前语言
 *  - lineCount:行数
 *  - getPreEl:从 view 拿 pos 处 code_block 的 DOM `<pre>` 元素,
 *    用于 widget 绝对定位浮在 pre 内部左上角。
 *    prosemirror widget 永远在 pre 之**外**(side: -1 是 pre 前一个兄弟),
 *    不能嵌 pre DOM;走 absolute + JS 同步位置浮进去。
 *
 *  与 CodeHighlightWidget.ts:99-240 toolbar DOM 工厂同形(浮层机制
 *  复制粘贴 —— 见该文件 "为什么" 段注释,行号浮左侧,工具条浮右上)。
 */
function makeGutterDom(
  pos: number,
  lang: string,
  lineCount: number,
  getPreEl: () => HTMLElement | null,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'velo-code-gutter-widget'
  wrap.contentEditable = 'false'
  wrap.setAttribute('data-pos', String(pos))
  wrap.setAttribute('data-lang', lang)
  wrap.setAttribute('data-line-count', String(lineCount))
  // widget 走 position: absolute 到 offsetParent(ProseMirror div),**不**用
  // position: fixed。原因:
  //   1. **顶栏 stacking 正确性**:fixed 把 widget 提到 viewport 根 stacking
  //      context,跟顶栏同级;widget 在 DOM 里更靠后,绘制顺序压在顶栏之上
  //      → 用户上滑超出编辑器时行号浮在顶栏上方。absolute 回到 ProseMirror
  //      的 stacking context(深度低于顶栏所在层级),顶栏自然压住 widget。
  //   2. **scroll 跟手**:absolute 走 offsetParent 差值计算,差值在 scroll
  //      期间是常量(ProseMirror 与 pre 同步移动),widget 位置不变 →
  //      实际没有 1 帧延迟,数学上跟手。
  //   3. **transform 替代 top/left**:scroll/resize 时 transform 写只触发
  //      composite 不重排,GPU 合成层更顺滑。
  // top/left 留 0,所有定位由 transform 完成(transform 在 absolute 元素上
  // 以 offsetParent 的 (0,0) 为原点偏移)。
  wrap.style.position = 'absolute'
  wrap.style.top = '0'
  wrap.style.left = '0'
  // will-change: transform 提示浏览器把 widget 提到独立合成层,scroll
  // 期间位置更新只走 GPU。不写则浏览器可能让 widget 跟 pre 共享层,位
  // 置更新走 CPU,频繁 transform 写时掉帧。
  wrap.style.willChange = 'transform'
  // z-index: 1(行号在 pre 内容之上,但不抢 toolbar 的点击);pointer-events:
  // none 不抢 PM 选区。
  wrap.style.zIndex = '1'
  wrap.style.pointerEvents = 'none'

  // 生成 N 行行号(行高继承父级 1.6,与 pre 像素对齐)
  for (let i = 1; i <= lineCount; i++) {
    const line = document.createElement('div')
    line.className = 'velo-code-gutter-line'
    line.textContent = String(i)
    wrap.appendChild(line)
  }

  // 同步位置:用 offsetParent 差值 + transform: translate3d() 写 GPU 合成层。
  //
  // **数学**:`x = (preRect.left - opRect.left) + op.scrollLeft`、
  // `y = (preRect.top - opRect.top) + op.scrollTop + padTop`。offsetParent
  // (ProseMirror div) 与 pre 同处一个 scrollable 链,.overflow-auto 滚动时
  // 两者视口 Y 同步变化 → 差值常量 → widget 位置不需要变,scroll 期间
  // syncPosition 实际上是 no-op(写同一个 transform 值),跟手无延迟。
  //
  // **为什么用 transform 而非 top/left**:
  //   - top/left 写会触发 layout,scroll 期间(高 RO + rAF 频率)频繁 layout
  //     引起主线程阻塞,行号"黏手"。
  //   - transform: translate3d() 走 GPU 合成层,只触发 composite 不重排,
  //     浏览器把 widget 提到独立 layer,scroll 期间 transform 更新只走 GPU。
  //     will-change: transform 在 makeGutterDom 已写,提示浏览器建 layer。
  //
  // **vertical**:含 padTop 让行号第 1 行跟代码第 1 行同 Y(Mac 模式
  // padTop=2.4em 自动跟着下移,跟红黄绿圆点不冲突)。
  // **horizontal**:不含 padLeft —— pre 的 padding-left 已被 SCSS 加宽到
  // ~3em(data-velo-gutter hook),widget 浮在 pre 外框左缘(2.8em widget 宽),
  // 落在加宽 padding 区内,不遮代码 content。
  function syncPosition() {
    const preEl = getPreEl()
    if (!preEl) return
    const op = wrap.offsetParent as HTMLElement | null
    if (!op) return
    const preRect = preEl.getBoundingClientRect()
    const opRect = op.getBoundingClientRect()
    const padTop = parseFloat(getComputedStyle(preEl).paddingTop) || 0
    const x = (preRect.left - opRect.left) + op.scrollLeft
    const y = (preRect.top - opRect.top) + op.scrollTop + padTop
    wrap.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }

  // rAF 节流(保留):scroll / resize / RO 在同一帧多次触发 → 只算一次,
  // 避免高频 scroll 事件堆积。rAF 在 frame 边界跑 syncPosition,transform
  // 写只触发 composite 不重排,1 帧延迟肉眼几乎不可见;若觉得还黏手,可
  // 把 rAF 换成 microtask(setTimeout(0))或同步调用。
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
  // 监听 window resize / scroll(同步 panel 整体视口位置)。
  // 用 capture 模式(window scroll 事件)能捕获所有 scroll —— 不管滚动容器
  // 是 window、body 还是嵌套的 .overflow-auto div,capture 都能在事件冒泡
  // 之前命中。widget 是 position: fixed 在 viewport 坐标系,任何祖先的 scroll
  // 都会改变 pre 的 viewport 位置,window capture 一条就够覆盖。
  window.addEventListener('resize', scheduleSync)
  window.addEventListener('scroll', scheduleSync, true)
  // 监听 pre 自身的 resize(代码行数变化时 pre 高度变) **和祖先链 resize**。
  //
  // **祖先链 resize 是关键 —— 仅监听 pre 自己会漏掉侧栏变化**:
  //   - 展开/收起工作区侧栏 → .overflow-auto 容器缩放,但 pre 自身宽度
  //     可能不变(editor 是 `max-w-[64vw]`,在视口足够大时永远在上限,
  //     .overflow-auto 缩 100px 不影响 pre 宽度,只让 pre 的 viewport X
  //     偏移)。
  //   - 调整工作区侧栏宽度 → 同上。
  //   - 调整窗口大小 → window resize 已覆盖,但祖先链 RO 也兜底(避免
  //     window resize 事件不冒泡到 PM 内部等边角情况)。
  // 仅 RO(pre) 时侧栏变化不发火 → widget 留在原 pre 位置,看起来"漂走"。
  // 修法:walk up pre.parentElement 监听祖先链(覆盖 .ProseMirror /
  // velo-editor-mount / .velo-editor / .overflow-auto / App 根 / body),
  // 任一祖先缩放都触发 re-sync,position: fixed 的 viewport 坐标立即更新。
  // 实测 6 层足够覆盖 Velo 布局链(深一些也无害,RO 内部 dedup)。
  let ro: ResizeObserver | null = null
  requestAnimationFrame(() => {
    if (typeof ResizeObserver === 'undefined') return
    ro = new ResizeObserver(scheduleSync)
    const pre = getPreEl()
    if (pre) {
      ro.observe(pre)
      let ancestor: HTMLElement | null = pre.parentElement
      let depth = 0
      while (ancestor && depth < 6) {
        ro.observe(ancestor)
        ancestor = ancestor.parentElement
        depth++
      }
    }
  })
  // widget 销毁时清监听(用 MutationObserver 跟 widget 自身脱离)
  const mo = new MutationObserver(() => {
    if (!wrap.isConnected) {
      window.removeEventListener('resize', scheduleSync)
      window.removeEventListener('scroll', scheduleSync, true)
      ro?.disconnect()
      mo.disconnect()
    }
  })
  mo.observe(document.body, { childList: true, subtree: true })

  return wrap
}

// ============================================================
//  构造 decorations
// ============================================================

/** 走 `decorationSet.empty` 而不是 `null` —— enabled=false 时根本不要
 *  decoration,ProseMirror 区分"空"和"空集合"语义(后者仍走 decorations
 *  重建,前者直接短路返回)。 */
function buildDecorations(
  state: EditorState,
  enabled: boolean,
): DecorationSet {
  if (!enabled) return DecorationSet.empty
  const decos: Decoration[] = []
  state.doc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== 'code_block') return
    const lang = (node.attrs.language as string) || ''
    // mermaid 跳过:渲染态 SVG 取代 pre,行号与 SVG 并排视觉割裂;
    // 源码编辑态(用户切到"看源码")SVG 隐藏,pre 显示 —— 这种状态下
    // 仍按 mermaid 整体跳过(用户已确认 v0.5.11 始终不显示)。
    if (lang === 'mermaid') return
    // 在 fold 范围内的 code_block:祖先 heading/list_item 折叠时,本
    // code_block 被 ancestor `velo-folded` class 设为 display:none,
    // 但行号 widget 是 position:absolute 浮在 pre 外,失去定位锚点 →
    // 飞到界面左上角。修法:fold range 内的 code_block 整段不挂行号
    // widget(连同 `data-velo-gutter` padding 加宽一起跳过,折叠态 pre
    // 自身不可见,padding 也无意义)。
    if (isCodeBlockFolded(pos)) return
    const blockStart = pos + 1
    const blockEnd = pos + node.nodeSize - 1
    // 空 code_block(无内容):不显示行号
    if (blockStart >= blockEnd) return
    const code = state.doc.textBetween(blockStart, blockEnd, '\n', '\n')
    // 行数 = \n 数量 + 1(空行也算 1 行,与编辑器行号惯例一致)
    const lineCount = code.split('\n').length
    // 给 pre 加 data-velo-gutter="true" → SCSS 把 padding-left 加宽到 3.4em,
    // 给 gutter widget 让出空间。否则 widget 落在 pre 的 content 起点(代码
    // 第 1 个字符位置),右对齐的 "1" 直接覆盖代码前 2-3 个字符(实测:
    // 1em 字符宽 × 2 字符 ≈ 与 gutter 文本位置重叠)。
    decos.push(
      Decoration.node(pos, pos + node.nodeSize, {
        'data-velo-gutter': 'true',
      }, { key: `code-gutter-class:${pos}:${enabled}` }),
    )
    // key 含 pos + lineCount + lang:新增/删除行(lineCount 变)→ key 变 →
    // ProseMirror 重建 widget;切 lang 也强制重建(虽然行号本身不依赖 lang,
    // 但 widget DOM 类名带 data-lang,留作未来 lang-依赖样式的 hook)。
    const key = `code-gutter:${pos}:${lineCount}:${lang}`
    // **widget 锚在 pos + node.nodeSize(pre 之后)+ side: -1,不在 pos**。
    // 原因:CodeHighlightWidget 的 toolbar 也用 side: -1 锚在 pos,它的
    // 显隐依赖 SCSS 选择器 `.velo-code-toolbar-widget:has(+ pre:hover)`
    // —— 这个 + pre 要求 pre 必须是 toolbar 的紧邻下一个兄弟。如果本
    // widget 也锚在 pos + side: -1,PM 同位置同 side 的 widget 顺序未指定,
    // 本 widget 偶尔会插在 toolbar 与 pre 之间,toolbar 的 + pre 选择器就
    // 断了,hover pre 时 toolbar 按钮不显示。
    // 锚在 pos + node.nodeSize(pre 之后)+ side: -1 → DOM 顺序固定为
    // `toolbar → pre → line number`,toolbar 的 + pre 永远匹配,hover
    // 行为不受影响。`pos + node.nodeSize` 是 code_block 的结束位置,
    // 下一个节点是它的外层 block 起点;side: -1 表示 widget 渲染在该位置
    // 之前 → 实际上渲染在 code_block 结束标签之后、外层 block 内容之前,
    // 即 pre 之后。
    // **getPreEl 不变**:仍通过 `view.nodeDOM(pos)` 拿 pre(用闭包捕获的
    // 原 pos,而不是 widget 自己的位置 pos + node.nodeSize —— 因为
    // widget 自己的位置已经不在 pre 上了,需要用 pre 的实际位置)。
    decos.push(
      Decoration.widget(pos + node.nodeSize, (view, _getPos) => {
        // prosemirror-view 工厂签名:(view, getPos) => DOMNode
        // 这里 _getPos 是 widget 自己的位置(pos + node.nodeSize),不能用
        // 它找 pre。用闭包捕获的 pos 找 pre。
        return makeGutterDom(
          pos,
          lang,
          lineCount,
          () => {
            if (!view || view.isDestroyed) return null
            try {
              const node = view.nodeDOM(pos) as HTMLElement | null
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
  })
  return DecorationSet.create(state.doc, decos)
}

// ============================================================
//  Plugin
// ============================================================

export const codeLineNumberPlugin = new Plugin<LineNumberState>({
  key: lineNumbersKey,
  state: {
    init: makeInitialState,
    apply(tr, prev) {
      const meta = tr.getMeta(lineNumbersKey) as
        | { enabled?: boolean }
        | undefined
      if (!meta) return prev
      return {
        enabled: meta.enabled ?? prev.enabled,
      }
    },
  },
  props: {
    decorations(state) {
      const s = lineNumbersKey.getState(state)
      if (!s) return null
      return buildDecorations(state, s.enabled)
    },
  },
})
