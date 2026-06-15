// 基础 schema 装配。一处提供整套 ProseMirror schema(commonmark + gfm + 自定义节点)。
//
// 设计原则:
// - **自定义节点(math_inline / math_block / mermaid)只占 schema 槽位**,
//   parseDOM/toDOM 是占位,真正的渲染走 NodeView / Decoration.widget。
//   见 ARCHITECTURE.md 的"mermaid 走 widget 不走 NodeView"段。
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

  footnote_definition: {
    group: 'block',
    content: 'block+',
    defining: true,
    attrs: {
      label: { default: '' },
    },
    parseDOM: [{
      tag: 'dl[data-type="footnote_definition"]',
      contentElement: 'dd',
      getAttrs: (dom: HTMLElement) => ({ label: dom.dataset.label ?? '' }),
    }],
    toDOM: (node) => [
      'dl',
      { 'data-label': node.attrs.label as string, 'data-type': 'footnote_definition' },
      ['dt', {}, node.attrs.label as string],
      ['dd', {}, 0],
    ],
  },

  footnote_reference: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: {
      label: { default: '' },
    },
    parseDOM: [{
      tag: 'sup[data-type="footnote_reference"]',
      getAttrs: (dom: HTMLElement) => ({ label: dom.dataset.label ?? '' }),
    }],
    toDOM: (node) => [
      'sup',
      { 'data-label': node.attrs.label as string, 'data-type': 'footnote_reference' },
      node.attrs.label as string,
    ],
  },

  // ============================================================
  //  自定义节点(math / mermaid)—— 见各 NodeView 文件
  // ============================================================

  // math_inline / math_block:LaTeX 公式。
  // - inline 走 KaTeX 行内渲染,内容为 source(textContent)
  // - block 走 KaTeX displayMode,source 在 attrs.value 里
  math_inline: {
    group: 'inline',
    inline: true,
    atom: true,
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

  // mermaid:atom block,内容存 attrs.value。toDOM 输出 height:0 占位 —
  // 真实渲染由 MermaidDecoration.ts 的 widget plugin 接管。
  // 详见 ARCHITECTURE.md "mermaid 走 widget 不走 NodeView"。
  mermaid: {
    content: 'text*',
    group: 'block',
    marks: '',
    defining: true,
    atom: true,
    isolating: true,
    code: true,
    attrs: {
      value: { default: '' },
    },
    parseDOM: [{
      tag: 'div[data-type="mermaid"]',
      preserveWhitespace: 'full',
      getAttrs: (dom: HTMLElement) => ({ value: dom.dataset.value ?? '' }),
    }],
    toDOM: () => {
      const dom = document.createElement('span')
      dom.style.cssText = 'display:none'
      return dom
    },
  },

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
}

// ============================================================
//  导出 Schema 实例
// ============================================================

export const schema = new Schema({ nodes, marks })

// 类型别名 —— 方便 NodeView / 插件代码引用统一类型
export type VeloSchema = typeof schema
