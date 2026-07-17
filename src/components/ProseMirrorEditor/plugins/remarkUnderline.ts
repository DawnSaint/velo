// `<u>text</u>` 下划线 — remark 插件。
//
// GFM / CommonMark 不支持下划线语法(<u> 是 HTML 标签,不是 markdown 语法)。
// remark-parse 把 `<u>text</u>` 拆成三个 mdast 节点:html("<u>") / text("text") /
// html("</u>"),逐个转 PM 会得到 html_inline atom 节点,无法体现"下划线 mark"语义。
//
// 这里在 mdast 阶段扫描每个 inline children 数组,把 `<u>` 开标签 + 内容 +
// `</u>` 闭标签配对重写为 `underline` 节点(children 复用,保留嵌套的 strong /
// emphasis / link 等)。markdownIO fromMarkdown 把 underline 节点转成 text +
// underline mark。
//
// 与 remarkHighlight 的关系:
// - remarkHighlight 处理 `==` 文本标记(==text==),在 mdast text 节点内切段
// - remarkUnderline 处理 `<u>` HTML 标签对,在 mdast html 节点间配对
// - 两者正交,注册顺序无冲突;`==<u>text</u>==` 和 `<u>==text==</u>` 都能
//   正确 round-trip(remarkHighlight 先跑把 == 收成 highlight 节点,remarkUnderline
//   后跑把 <u> 收成 underline 节点;反之亦然,html 节点在 highlight 内部不影响)
//
// 边界:
// - 开标签可带属性:`<u class="x">text</u>` 也能匹配
// - 支持嵌套 `<u>`:深度计数,内层 `<u>` 作为内容保留在 underline children 里
// - 未闭合的 `<u>`(无对应 `</u>`):保持原样,html 节点不转换
// - 自闭合 `<u/>`:不匹配(下划线需要内容)

import { visit } from 'unist-util-visit'
import type { Root, PhrasingContent } from 'mdast'

// 匹配 <u> 或 <u attr="x"> 形式的开标签(整段 html 节点 value)
const OPEN_RE = /^<u(\s[^>]*)?>$/i
// 匹配 </u> 闭标签
const CLOSE_RE = /^<\/u>$/i

function rewriteChildren(children: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = []
  // underline 区域缓冲:收集 <u> 与 </u> 之间的所有子节点
  let buffer: PhrasingContent[] | null = null
  // 嵌套深度:处理 <u>outer <u>inner</u> text</u> 这种嵌套场景
  let depth = 0

  for (const child of children) {
    if (child.type === 'html' && typeof child.value === 'string') {
      if (OPEN_RE.test(child.value)) {
        if (buffer === null) {
          // 首个 <u> —— 开启 underline 区域
          buffer = []
          depth = 1
        } else {
          // 嵌套 <u> —— 作为内容保留
          buffer.push(child)
          depth++
        }
        continue
      }
      if (CLOSE_RE.test(child.value)) {
        if (buffer !== null) {
          depth--
          if (depth === 0) {
            // 最外层 </u> 闭合 —— flush 成 underline 节点
            out.push({
              type: 'underline',
              children: buffer,
            } as unknown as PhrasingContent)
            buffer = null
            continue
          } else {
            // 嵌套 </u> —— 作为内容保留
            buffer.push(child)
            continue
          }
        }
        // 无对应 <u> 的孤立 </u> —— 透传
        out.push(child)
        continue
      }
    }

    if (buffer !== null) {
      buffer.push(child)
    } else {
      out.push(child)
    }
  }

  // 未闭合的 <u>(无对应 </u>):缓冲区内容原样透传,不转 underline
  if (buffer !== null) {
    out.push(...buffer)
  }
  return out
}

export function remarkUnderline() {
  return (tree: Root) => {
    visit(tree, (node: any) => {
      if (Array.isArray(node.children)) {
        node.children = rewriteChildren(node.children)
      }
    })
  }
}
