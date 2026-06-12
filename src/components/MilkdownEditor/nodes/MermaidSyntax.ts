import { $nodeSchema, $remark } from '@milkdown/kit/utils'
import type { MilkdownPlugin } from '@milkdown/ctx'

// ========== Remark 插件：将 MDAST code(lang=mermaid) → type: 'mermaid' ==========

const remarkMermaidPlugin = $remark('remarkMermaid', () => {
  function walk(node: any) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        if (child.type === 'code' && child.lang === 'mermaid') {
          node.children[i] = {
            type: 'mermaid',
            value: child.value,
          }
        }
        else {
          walk(child)
        }
      }
    }
  }

  // remark 插件规范：(options) => (tree, file) => void
  return function mermaidRemarkPlugin(_options?: any) {
    return function mermaidTransformer(tree: any) {
      walk(tree)
    }
  }
})

// ========== $nodeSchema：ProseMirror mermaid 节点 ==========

export const mermaidSchema = $nodeSchema('mermaid', () => ({
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
  parseDOM: [
    {
      tag: 'div[data-type="mermaid"]',
      preserveWhitespace: 'full',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return { value: '' }
        return { value: dom.dataset.value ?? '' }
      },
    },
  ],
  toDOM: () => {
    const dom = document.createElement('span')
    dom.style.cssText = 'display:none'
    return dom
  },
  parseMarkdown: {
    match: ({ type }) => type === 'mermaid',
    runner: (state, node, type) => {
      state.addNode(type, { value: (node.value as string) ?? '' })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'mermaid',
    runner: (state, node) => {
      state.addNode('code', undefined, node.attrs.value, { lang: 'mermaid' })
    },
  },
}))

// ========== 导出 ==========

export const mermaidSyntax: MilkdownPlugin[] = [
  remarkMermaidPlugin,
  mermaidSchema,
].flat()
