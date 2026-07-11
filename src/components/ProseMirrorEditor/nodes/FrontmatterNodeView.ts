// YAML Front Matter NodeView — Typora 风格 styled code block。
//
// schema 给 frontmatter 节点占一槽位(content:'text*', code:true, marks:''),
// 本文件提供 NodeView 渲染:
//   <div class="velo-frontmatter">
//     <div class="velo-frontmatter-header">
//       <button velo-frontmatter-fold-btn ▼>折叠 chevron(独立 DOM,PM 不接管)</button>
//       Front Matter
//     </div>
//     <pre><code>...YAML content...</code></pre>  ← contentDOM(PM 接管文本编辑)
//   </div>
//
// 设计要点:
// - **content:'text*' + 非 atom**:内容可直接在 WYSIWYG 编辑(同 code_block 范式),
//   contentDOM = <code>,PM 接管文本编辑,光标自然进入。
// - **header 不可编辑**:`contentEditable=false`,user-select:none。
// - **code:true**:选区不可"跨"frontmatter(同 code_block / math_inline)。
// - **fold chevron**:header 内嵌独立 <button>,click 走 foldKey 集中 toggle;
//   立即翻 data-fold-state(attribute 驱动 CSS 过渡动画),update() 读 foldKey state
//   兜底同步(防经 tr.mapping 等非 click 路径漏同步)。
// - **ignoreMutation**:header(含 chevron)是静态 DOM,其 mutation 不影响 PM state;
//   pre/code 的文本突变由 PM DOMObserver 正常处理(不能 ignore,否则用户输入不同步)。
//   实际上 contentDOM 子树的 mutation PM 会自动放行,这里 ignore 外层 div 的
//   非 contentDOM 突变(如 header 被外部脚本改动)。
// - **stopEvent**:header(含 chevron)返回 true 隔离 PM 对 header 内 click/mousedown
//   的处理(chev click 自管;防点 header 时光标跳到 contentDOM 首部)。

import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { foldKey } from './FoldDecoration'
import { chevronDownSvg } from '@/components/icons/widgetIcons'

export function createFrontmatterNodeView() {
  return function frontmatterNodeViewFactory(
    _node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ): NodeView {
    const dom = document.createElement('div')
    dom.className = 'velo-frontmatter'
    dom.setAttribute('data-type', 'frontmatter')
    // data-lang 镜像节点的 lang 属性(yaml / toml),供导出/CSS 选择器使用。
    dom.setAttribute('data-lang', (_node.attrs.lang as string) || 'yaml')

    // header 标题栏 —— 不可编辑,折叠 chevron、格式 chip 也内嵌于此
    const header = document.createElement('div')
    header.className = 'velo-frontmatter-header'
    header.contentEditable = 'false'

    // 标题文本 "Front Matter" —— 独立 span,方便 chip 与标题并排
    const titleSpan = document.createElement('span')
    titleSpan.className = 'velo-frontmatter-title'
    titleSpan.textContent = 'Front Matter'
    titleSpan.contentEditable = 'false'
    header.appendChild(titleSpan)

    // == 折叠 chevron(▼) —— 独立 DOM,PM 不接管,click 走 foldKey 集中 toggle ==
    const chevron = document.createElement('button')
    chevron.type = 'button'
    chevron.className = 'velo-icon-btn velo-frontmatter-fold-btn'
    chevron.contentEditable = 'false'
    chevron.title = '展开'
    chevron.setAttribute('aria-label', '展开')
    chevron.innerHTML = chevronDownSvg(14)
    // 初始态:默认展开(data-fold-state='expanded');update() 会再同步一次
    chevron.setAttribute('data-fold-state', 'expanded')
    function setChevronCollapsed(collapsed: boolean): void {
      chevron.setAttribute('data-fold-state', collapsed ? 'collapsed' : 'expanded')
      chevron.title = collapsed ? '展开' : '折叠'
      chevron.setAttribute('aria-label', chevron.title)
    }
    chevron.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    chevron.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (view.isDestroyed || typeof getPos() !== 'number') return
      const contentStart = getPos()! + 1
      const s = foldKey.getState(view.state)
      const currentlyCollapsed = s ? s.collapsedSet.has(contentStart) : false
      const nextCollapsed = !currentlyCollapsed
      // 立即翻 attribute(CSS 过渡动画先行)——同步修改三方视觉状态,全部在
      // 同一 tick 完成,避免等 PM reconcile:
      //   (1) chevron data-fold-state + title(self)
      //   (2) wrapper is-collapsed class(视觉折叠)
      setChevronCollapsed(nextCollapsed)
      dom.classList.toggle('is-collapsed', nextCollapsed)
      // 然后 dispatch 推进 foldKey state(持久化链路 store.sync 跟 tr.mapping)
      view.dispatch(view.state.tr.setMeta(foldKey, { toggle: contentStart }))
    })
    // == 格式 chip(header 右侧 "YAML"/"TOML" 按钮) —— 点击切换 lang 种类 ==
    // 显示节点 lang 属性,dispatch setNodeMarkup 切换 yaml ↔ toml,序列化 fence +
    // shiki grammar 同步跟随。chip 文案 + wrapper data-lang 由 update() 跟住。
    const langBtn = document.createElement('button')
    langBtn.type = 'button'
    langBtn.className = 'velo-frontmatter-lang'
    langBtn.contentEditable = 'false'
    function refreshLangChip(lang: string): void {
      const kind = lang === 'toml' ? 'toml' : 'yaml'
      langBtn.setAttribute('data-lang', kind)
      langBtn.textContent = kind.toUpperCase() // YAML / TOML
      langBtn.title = `当前格式: ${kind.toUpperCase()}，点击切换为 ${kind === 'toml' ? 'YAML' : 'TOML'}`
      langBtn.setAttribute('aria-label', `当前格式 ${kind}，点击切换`)
    }
    refreshLangChip((_node.attrs.lang as string) || 'yaml')
    langBtn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    langBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (view.isDestroyed || typeof getPos() !== 'number') return
      const pos = getPos()!
      const node = view.state.doc.nodeAt(pos)
      if (!node) return
      const cur = node.attrs.lang === 'toml' ? 'toml' : 'yaml'
      const next = cur === 'toml' ? 'yaml' : 'toml'
      // 切换 lang 即改序列化 fence —— 真实内容变更,需进入 dirty/保存链路,
      // 不设 SKIP_CONTENT_EMIT。setNodeMarkup 保留节点类型 + 位置,只改 attrs,
      // PM 会调 update() 跟住 chip 文案 + wrapper data-lang(NodeView 不重建)。
      view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, lang: next }))
    })
    header.appendChild(langBtn)

    header.prepend(chevron)
    dom.appendChild(header)

    // contentDOM —— PM 接管文本编辑(同 code_block 的 <pre><code>)
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    pre.appendChild(code)
    dom.appendChild(pre)

    function refreshChevron(): void {
      if (typeof getPos() !== 'number') return
      const contentStart = getPos()! + 1
      const s = foldKey.getState(view.state)
      const collapsed = s ? s.collapsedSet.has(contentStart) : false
      setChevronCollapsed(collapsed)
      // **视觉折叠由 NodeView 自管**(Decoration.node 对 NodeView 内层无效;
      // chevron 仍为 Decoration.widget,但用于 header 自管 chevron)。
      dom.classList.toggle('is-collapsed', collapsed)
    }

    return {
      dom,
      contentDOM: code,
      update(newNode: PMNode) {
        if (newNode.type.name !== 'frontmatter') return false
        refreshChevron() // dispatch tr.mapping 跟住后 chevron 方向 + 折叠 class 同步,防非 click 路径漏同步
        refreshLangChip((newNode.attrs.lang as string) || 'yaml') // lang 切换(setNodeMarkup)由 PM 驱动 update 跟住 chip 文案
        // 同步 wrapper 的 data-lang(供 CSS 区分 yaml / toml 色调),同样由 update 驱动。
        dom.setAttribute('data-lang', newNode.attrs.lang === 'toml' ? 'toml' : 'yaml')
        return true
      },
      // header(含 chevron)内事件隔离:click/mousedown 不交给 PM,chev click 自管
      stopEvent(event: Event) {
        return event.target instanceof Node && header.contains(event.target)
      },
      // header(含 chevron)是静态 DOM,其 mutation 不影响 PM state;contentDOM 内的
      // 文本 mutation 由 PM DOMObserver 自动处理(不经过 ignoreMutation)。
      //
      // **根 dom 的 mutation 也必须 ignore**:fold chevron click 会同步
      // `dom.classList.toggle('is-collapsed')`,这是 NodeView 自管的视觉状态。
      // 若 PM 把它当外部突变 → 销毁整个 NodeView 重建 → 新实例 dom 没有
      // is-collapsed class → chevron 立刻翻回展开态(用户看到"亮一下然后没反应")。
      // 详见 docs/superpowers/specs/2026-07-10-frontmatter-fold-design.md。
      ignoreMutation(mutation: ViewMutationRecord) {
        if (!(mutation.target instanceof Node)) return false
        return mutation.target === dom || header.contains(mutation.target)
      },
    }
  }
}

export const frontmatterNodeViewKey = new PluginKey('frontmatterNodeView')

export const frontmatterNodeViewPlugin = new Plugin({
  key: frontmatterNodeViewKey,
  props: {
    nodeViews: {
      frontmatter: createFrontmatterNodeView(),
    },
  },
})
