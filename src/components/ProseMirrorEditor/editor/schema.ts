// 基础 schema 装配。一处提供整套 ProseMirror schema(commonmark + gfm + 自定义节点)。
//
// 设计原则:
// - **自定义节点(math_inline / math_block / mermaid)只占 schema 槽位**,
//   parseDOM/toDOM 是占位,真正的渲染走 NodeView / Decoration.widget。
//   见 docs/architecture/editor.md 的 mermaid Decoration/widget 说明。
// - **list_item 一并合并 task list checked attr**。NodeView 在
//   TaskListNodeView.ts 里按 checked != null 分支渲染 checkbox。
//
// 不在这里:input rules、keymap、history —— 那些是 Plugin,不是 schema spec。

import { Schema } from 'prosemirror-model'
import type { NodeSpec, MarkSpec } from 'prosemirror-model'
import { tableNodes } from 'prosemirror-tables'

// ============================================================
//  Nodes
// ============================================================

const nodes: Record<string, NodeSpec> = {
  doc: {
    content: 'block+',
  },

  text: {
    group: 'inline',
  },

  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },

  heading: {
    content: 'inline*',
    group: 'block',
    defining: true,
    attrs: {
      id: { default: '' },
      level: { default: 1 },
    },
    parseDOM: [1, 2, 3, 4, 5, 6].map(level => ({
      tag: `h${level}`,
      getAttrs: (dom: HTMLElement) => ({ level, id: dom.id }),
    })),
    toDOM: (node) => {
      const id = (node.attrs.id as string)
        || (node.textContent || '').toLowerCase().trim().replace(/\s+/g, '-')
      return [`h${node.attrs.level}`, { id }, 0]
    },
  },

  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0],
  },

  // GitHub 风格警告框 / callout / admonition。
  // 由 plugins/remarkAlert.ts 在 mdast 阶段从 blockquote(首行 [!TYPE])改造而来;
  // toMarkdown 时反向写回 blockquote + [!TYPE] 文本前缀,保 GFM 可读性。
  // 5 种 variant:note / tip / important / warning / caution
  alert: {
    content: 'block+',
    group: 'block',
    defining: true,
    attrs: {
      variant: { default: 'note' },
    },
    parseDOM: [{
      tag: 'div[data-type="alert"]',
      getAttrs: (dom: HTMLElement) => ({
        variant: dom.dataset.variant ?? 'note',
      }),
    }],
    toDOM: (node) => [
      'div',
      {
        'data-type': 'alert',
        'data-variant': node.attrs.variant as string,
        'class': `velo-alert velo-alert-${node.attrs.variant}`,
      },
      0,
    ],
  },

  // TOC (Table of Contents):[TOC] 独占段落的渲染节点。
  // 由 nodes/TocDecoration.ts 的 Decoration.widget 接管真实渲染;
  // schema 只占槽位,toDOM 输出空 div。
  // 注意:不能加 atom: true —— setBlockType 要求目标类型是 textblock,
  // atom 类型会被拒绝(报 "Type given to setBlockType should be a textblock")。
  toc: {
    group: 'block',
    marks: '',
    parseDOM: [{
      tag: 'div[data-type="toc"]',
    }],
    toDOM: () => ['div', { 'data-type': 'toc' }],
  },

  bullet_list: {
    content: 'list_item+',
    group: 'block',
    attrs: {
      spread: { default: false },
    },
    parseDOM: [{
      tag: 'ul',
      getAttrs: (dom: HTMLElement) => ({
        spread: dom.dataset.spread === 'true',
      }),
    }],
    toDOM: (node) => ['ul', { 'data-spread': String(node.attrs.spread) }, 0],
  },

  ordered_list: {
    content: 'list_item+',
    group: 'block',
    attrs: {
      order: { default: 1 },
      spread: { default: false },
    },
    parseDOM: [{
      tag: 'ol',
      getAttrs: (dom: HTMLElement) => ({
        spread: dom.dataset.spread === 'true',
        order: dom.hasAttribute('start') ? Number(dom.getAttribute('start')) : 1,
      }),
    }],
    toDOM: (node) => {
      const order = node.attrs.order as number
      const attrs: Record<string, string> = { 'data-spread': String(node.attrs.spread) }
      if (order !== 1) attrs.start = String(order)
      return ['ol', attrs, 0]
    },
  },

  list_item: {
    group: 'list_item',
    content: 'paragraph block*',
    defining: true,
    attrs: {
      label: { default: '•' },
      listType: { default: 'bullet' },
      spread: { default: true },
      // task list 扩展:null = 普通项 / true = 已勾选 / false = 未勾选
      // TaskListNodeView 按 checked != null 分支渲染 checkbox
      checked: { default: null },
    },
    parseDOM: [
      // task 项优先匹配
      {
        tag: 'li[data-item-type="task"]',
        getAttrs: (dom: HTMLElement) => ({
          label: dom.dataset.label,
          listType: dom.dataset.listType,
          spread: dom.dataset.spread === 'true',
          checked: dom.dataset.checked
            ? dom.dataset.checked === 'true'
            : null,
        }),
      },
      {
        tag: 'li',
        getAttrs: (dom: HTMLElement) => ({
          label: dom.dataset.label,
          listType: dom.dataset.listType,
          spread: dom.dataset.spread === 'true',
        }),
      },
    ],
    toDOM: (node) => {
      const checked = node.attrs.checked as boolean | null
      const baseAttrs: Record<string, string> = {
        'data-label': node.attrs.label as string,
        'data-list-type': node.attrs.listType as string,
        'data-spread': String(node.attrs.spread),
      }
      if (checked != null) {
        return ['li', {
          ...baseAttrs,
          'data-item-type': 'task',
          'data-checked': String(checked),
        }, 0]
      }
      return ['li', baseAttrs, 0]
    },
  },

  code_block: {
    content: 'text*',
    group: 'block',
    marks: '',
    defining: true,
    code: true,
    attrs: {
      language: { default: '' },
    },
    parseDOM: [{
      tag: 'pre',
      preserveWhitespace: 'full',
      getAttrs: (dom: HTMLElement) => ({
        language: dom.dataset.language ?? '',
      }),
    }],
    toDOM: (node) => {
      const language = node.attrs.language as string
      const preAttrs = language ? { 'data-language': language } : {}
      return ['pre', preAttrs, ['code', {}, 0]]
    },
  },

  hardbreak: {
    inline: true,
    group: 'inline',
    selectable: false,
    attrs: {
      isInline: { default: false },
    },
    parseDOM: [
      { tag: 'br' },
      { tag: 'span[data-type="hardbreak"]', getAttrs: () => ({ isInline: true }) },
    ],
    toDOM: (node) => node.attrs.isInline ? ['span', {}, ' '] : ['br'],
    leafText: () => '\n',
  },

  hr: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr'],
  },

  image: {
    inline: true,
    group: 'inline',
    selectable: true,
    draggable: true,
    marks: '',
    atom: true,
    defining: true,
    isolating: true,
    attrs: {
      src: { default: '' },
      alt: { default: '' },
      title: { default: '' },
    },
    parseDOM: [{
      tag: 'img[src]',
      getAttrs: (dom: HTMLElement) => ({
        src: dom.getAttribute('src') || '',
        alt: dom.getAttribute('alt') || '',
        title: dom.getAttribute('title') || dom.getAttribute('alt') || '',
      }),
    }],
    toDOM: (node) => ['img', { ...node.attrs }],
  },

  // ============================================================
  //  GFM 扩展节点
  // ============================================================

  // 脚注 definition 的 label 现在是 footnote_label 节点的 text content(非 attrs),
  // 与 footnote_reference 同范式(见 editor.md 禁令速查"不要把脚注编号写回 attrs.label")。
  // 改之前 label 在 attrs.label + NodeView 自管一个不在 contentDOM 子树里的 labelSpan
  // (input/keydown 同步),PM 看不到 labelSpan → 点击 label 时 PM 默认把光标推进
  // 到最近的 content 子树 = 描述段前,Backspace/Delete 删错位置。
  // 把 label 拆成 footnote_label 节点(content:'text*')作为强制首子,PM 接管
  // label 文本编辑(光标自然进入、selection 正确)。
  // 序列化:toMarkdown 从 firstChild.textContent 读 identifier;parseDOM
  // 通过 <dt> 反向解析回 footnote_label。<dl> 整体作为 contentElement 让 PM
  // 解析 <dt>(→ footnote_label) + <dd>(→ paragraph) 两个 block 兄弟节点。
  footnote_definition: {
    group: 'block',
    content: 'footnote_label block+',
    defining: true,
    parseDOM: [{
      tag: 'dl[data-type="footnote_definition"]',
      contentElement: 'dl',
    }],
    toDOM: (node) => {
      const label = node.firstChild?.textContent ?? ''
      return [
        'dl',
        { 'data-label': label, 'data-type': 'footnote_definition' },
        0,
      ]
    },
  },

  // footnote_definition 的强制首子:承载 label 文本(content:'text*')。
  // 与 footnote_reference 同范式 —— 文本由 PM 接管,NodeView 不需要自管 input。
  // 不用 inline:true(它是 block,与 definition 同一行 flex 排版由 SCSS 处理);
  // 不用 marks:''(让 label text 能带 mark)。
  footnote_label: {
    group: 'block',
    content: 'text*',
    parseDOM: [{ tag: 'dt' }],
    toDOM: () => ['dt', 0],
  },

  footnote_reference: {
    group: 'inline',
    inline: true,
    // 不设 atom —— PM selection 能进入 sup 内的 text,逐字符编辑 label。
    // 之前用 atom + contentEditable sup 的方案在 ProseMirror 的 contentEditable
    // (view.dom) 内拿不到独立 focus(contentEditable 嵌套 selection 统一由外层
    // 管理),导致 sup 上的 keydown/beforeinput listener 全部不触发,Backspace
    // 被 PM 按 selection(sup 外)处理 → "删错位置"。去 atom 后 label 作为 text
    // content 由 PM 接管,光标自然进入,不需要 contentEditable / 事件隔离补丁。
    // label 合法性(不能含空白/])靠 toMarkdown 自然惩罚(含非法字符时 remark
    // 解析不回 footnote,round-trip 后变普通文本)。
    content: 'text*',
    marks: '',
    parseDOM: [{
      tag: 'sup[data-type="footnote_reference"]',
    }],
    toDOM: () => [
      'sup',
      { 'data-type': 'footnote_reference', class: 'footnote-ref-node' },
      0,
    ],
  },

  // ============================================================
  //  自定义节点(math)—— 见各 NodeView 文件
  // ============================================================

  // math_inline:LaTeX 行内公式。Obsidian/Typora 风格:source 是 node 的 text content
  // (非 atom),NodeView 显式渲染两端的 `$` 分隔符 + katex 预览;光标进入时切到
  // edit 模式显示 source,光标离开时切到 display 模式只显示预览 —— 与
  // footnote_reference "label as text content" 修复同范式(contentDOM 由 PM 接管,
  // 选区自然进入节点内,Backspace/Delete 按节点内 selection 处理)。
  //
  // 之前 `atom: true` 的设计:NodeView 自己挂 input/textarea 做编辑,blur 后销毁编辑
  // 壳重渲染 —— 用户感知"显式输入框",与"光标进入即编辑、离开即预览"的现代编辑器
  // 体验割裂;NodeView 还要自管 stopEvent / isolateInput / 异步 stale-check 一堆补丁
  // (editor.md 旧版"NodeView 必须实现 stopEvent" / "async render stale-check"段均
  // 服务于这个旧设计)。去 atom 后这些补丁一并消失。
  //
  // 保留 `code: true` —— 选区不可"跨" math_inline(防止从外部文本选到公式中间
  // 又从公式中间选到外部文本,与 footnote_reference 同形)。
  // 保留 `marks: ''` —— source text 不参与外部 mark 继承。
  math_inline: {
    group: 'inline',
    inline: true,
    atom: false,
    content: 'text*',
    marks: '',
    code: true,
    parseDOM: [{
      tag: 'span[data-type="math_inline"]',
      preserveWhitespace: 'full',
    }],
    toDOM: () => ['span', { 'data-type': 'math_inline' }, 0],
  },

  math_block: {
    group: 'block',
    atom: true,
    isolating: true,
    defining: true,
    marks: '',
    attrs: {
      value: { default: '' },
    },
    parseDOM: [{
      tag: 'div[data-type="math_block"]',
      preserveWhitespace: 'full',
      getAttrs: (dom: HTMLElement) => ({ value: dom.dataset.value ?? '' }),
    }],
    toDOM: (node) => [
      'div',
      { 'data-type': 'math_block', 'data-value': node.attrs.value as string },
    ],
  },

  // mermaid 节点已废弃(v0.4.6+ 走 code_block { language: 'mermaid' },与其他 fenced
  // code 同管线;MermaidDecoration widget 扫描 code_block 渲染 SVG / 编辑壳)。

  // html_block / html_inline:atom 节点,attrs.value 存原始 HTML 字符串。
  // toDOM 输出占位(数据传递),真实渲染由 nodes/HtmlNodeView.ts 的 NodeView
  // 用 DOMPurify sanitize 后 innerHTML 写入。
  // 与 math_block / math_inline 同形态。
  html_block: {
    group: 'block',
    atom: true,
    isolating: true,
    defining: true,
    marks: '',
    attrs: {
      value: { default: '' },
    },
    parseDOM: [{
      tag: 'div[data-type="html_block"]',
      preserveWhitespace: 'full',
      getAttrs: (dom: HTMLElement) => ({ value: dom.dataset.value ?? '' }),
    }],
    toDOM: (node) => [
      'div',
      { 'data-type': 'html_block', 'data-value': node.attrs.value as string },
    ],
  },

  html_inline: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: {
      value: { default: '' },
    },
    parseDOM: [{
      tag: 'span[data-type="html_inline"]',
      getAttrs: (dom: HTMLElement) => ({ value: dom.dataset.value ?? '' }),
    }],
    toDOM: (node) => [
      'span',
      { 'data-type': 'html_inline', 'data-value': node.attrs.value as string },
    ],
  },

  // ============================================================
  //  Tables (gfm) —— 用 prosemirror-tables 的 tableNodes 工厂
  // ============================================================

  ...tableNodes({
    tableGroup: 'block',
    cellContent: 'paragraph',
    cellAttributes: {
      alignment: {
        default: 'left',
        getFromDOM: (dom) => (dom as HTMLElement).style.textAlign || 'left',
        setDOMAttr: (value, attrs) => {
          attrs.style = `text-align: ${value || 'left'}`
        },
      },
    },
  }),
}

// tableNodes 默认 content 是 'table_row+',需要替换成头行优先。
// 同时新增 table_header_row 节点(prosemirror-tables 默认无)。
nodes.table = {
  ...nodes.table,
  content: 'table_header_row table_row+',
  isolating: true,
}

nodes.table_header_row = {
  content: '(table_header)*',
  tableRole: 'row',
  parseDOM: [
    { tag: 'tr[data-is-header]' },
    {
      tag: 'tr',
      getAttrs: (dom: HTMLElement) =>
        dom.querySelector('th') ? {} : false,
    },
  ],
  toDOM: () => ['tr', { 'data-is-header': 'true' }, 0],
}

nodes.table_row = {
  ...nodes.table_row,
  content: '(table_cell)*',
}

// ============================================================
//  Marks
// ============================================================

const marks: Record<string, MarkSpec> = {
  code: {
    code: true,
    parseDOM: [{ tag: 'code' }],
    toDOM: () => ['code'],
    excludes: '_',
  },

  emphasis: {
    attrs: {
      // marker 字段决定序列化时用 `*` 还是 `_`;UI 默认 `*`
      marker: { default: '*' },
    },
    parseDOM: [
      { tag: 'i' },
      { tag: 'em' },
      { style: 'font-style', getAttrs: v => v === 'italic' && null },
    ],
    toDOM: () => ['em', 0],
  },

  strong: {
    attrs: {
      marker: { default: '*' },
    },
    parseDOM: [
      { tag: 'b', getAttrs: (node: HTMLElement) => node.style.fontWeight !== 'normal' && null },
      { tag: 'strong' },
      { style: 'font-weight=400', clearMark: m => m.type.name === 'strong' },
      { style: 'font-weight', getAttrs: (v: string) => /^(bold(er)?|[5-9]\d{2,})$/.test(v) && null },
    ],
    toDOM: () => ['strong', 0],
  },

  link: {
    attrs: {
      href: {},
      title: { default: null },
    },
    // inclusive: false —— 光标在 link 边界输入新字符时不继承 link mark
    // 否则用户在链接末尾打字会变成链接的一部分(蓝色 + 可点击)
    inclusive: false,
    parseDOM: [{
      tag: 'a[href]',
      getAttrs: (dom: HTMLElement) => ({
        href: dom.getAttribute('href'),
        title: dom.getAttribute('title'),
      }),
    }],
    toDOM: (mark) => ['a', { ...mark.attrs }],
  },

  strike_through: {
    parseDOM: [
      { tag: 'del' },
      { style: 'text-decoration', getAttrs: v => v === 'line-through' && null },
    ],
    toDOM: () => ['del', 0],
  },

  // ==xxx== 高亮。toDOM 用原生 <mark>,复用 _editor-typography.scss:108
  // 已有的 #fff3a3 黄色背景。从 markdown 文本解析时,==xxx== 不在 GFM 范围,
  // 由 markdownIO 的 fromMarkdown 端做文本后处理切三段(前/带 highlight/后)。
  highlight: {
    parseDOM: [{ tag: 'mark' }],
    toDOM: () => ['mark', 0],
  },
}

// ============================================================
//  导出 Schema 实例
// ============================================================

export const schema = new Schema({ nodes, marks })

// 类型别名 —— 方便 NodeView / 插件代码引用统一类型
export type VeloSchema = typeof schema
