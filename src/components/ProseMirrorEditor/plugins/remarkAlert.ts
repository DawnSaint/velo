// GitHub 风格警告框 / callout 的 mdast 改写器。
//
// CommonMark / GFM 没有 alert 语法,GitHub 在 blockquote 之上扩展了 `[!TYPE]`
// 首行约定。本插件 visit 所有 blockquote,识别首行的 `[!NOTE|TIP|IMPORTANT|WARNING|CAUTION]`,
// 把 blockquote 节点就地改写成自定义 `alert` 类型并标记 variant。markdownIO 那边
// 按 node.type === 'alert' 分支转 schema 节点。
//
// 设计要点:
// - **就地 mutate node.type / 加 variant 字段**(非标准 mdast 节点),这样不需要在
//   全局 mdast 类型表注册新类型,markdownIO 那边 `as any` 一次即可。
// - **保持 GFM 兼容序列化**:toMarkdown 那边把 alert → blockquote + `[!TYPE]\n` 文本前缀
//   写回去。这样 .md 文件在 GitHub / 其它 markdown 工具里仍然能正确显示。
// - **大小写**:GitHub 文档要求 `[!NOTE]` 全大写,但用户难免敲错,这里 case-insensitive
//   匹配,落到 PM 的 attrs.variant 统一小写。
//
// 不在这里:
// - alert 节点的 schema(在 editor/schema.ts)
// - alert 双向(在 editor/markdownIO.ts)

import { visit } from 'unist-util-visit'
import type { Root, Blockquote } from 'mdast'

const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i

/** unified 插件工厂。返回的 transformer 直接在 mdast 树上 mutate。 */
export function remarkAlert() {
  return function transformer(tree: Root): void {
    visit(tree, 'blockquote', (node: Blockquote) => {
      const first = node.children[0]
      if (first?.type !== 'paragraph') return
      const head = first.children[0]
      if (head?.type !== 'text') return
      const match = head.value.match(ALERT_RE)
      if (!match) return

      const variant = match[1].toLowerCase()
      // 剥掉 [!TYPE] 标记(可能跟换行,可能跟空格)
      const stripped = head.value.replace(ALERT_RE, '')
      if (stripped) {
        first.children[0] = { type: 'text', value: stripped }
      }
      else {
        first.children.shift()
      }
      // 首段被掏空就把整段去掉
      if (first.children.length === 0) {
        node.children.shift()
      }

      // 就地改类型 + 标 variant。下游 markdownIO 按 node.type === 'alert' 分支。
      // mdast 类型不允许这样改,but unified 不校验运行时类型,本地 cast 即可。
      ;(node as unknown as { type: string }).type = 'alert'
      ;(node as unknown as { variant: string }).variant = variant
    })
  }
}