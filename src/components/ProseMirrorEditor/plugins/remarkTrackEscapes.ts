// 追踪 CommonMark 反斜杠转义（§2.4 `\<ASCII punct>`）。
//
// remark-parse 默认把 characterEscape 解码后直接拼进 text.value，丢弃了
// 「哪几个字符来自反斜杠转义」的信息。这里通过 fromMarkdownExtensions
// 接管 characterEscapeValue 的 exit 钩子，在写入 text.value 之前把当前
// 下标记进 `text._escapes`：
//   - 下游 remark 插件（remarkCjkEmphasis / remarkHighlight / remarkSupSub /
//     remarkEmoji）据此跳过被转义的界定符，避免 `\*\*x\*\*` 被误补成粗体；
//   - markdownIO 把 `_escapes` 对应字符挂上 PM `escape` mark，支持 WYSIWYG
//     点击展开 `\` 与 toMarkdown 精确还原；
//   - 节点类型仍为普通 `text`，image alt / link title / renderMarkdown 等
//     既有消费者零破坏。

import type { Processor } from 'unified'

interface EscapeToken {
  end: { line: number; column: number; offset: number }
}

interface EscapeTextNode {
  type: string
  value: string
  _escapes?: number[]
  _marker?: string
  position?: { start?: unknown; end?: { line: number; column: number; offset: number } }
}

interface CompileContextLike {
  stack: EscapeTextNode[]
  sliceSerialize: (token: EscapeToken) => string
}

export function remarkTrackEscapes(this: Processor) {
  const data = this.data() as Record<string, unknown>
  const list = (data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = [])) as unknown[]
  list.push({
    exit: {
      characterEscapeValue(this: CompileContextLike, token: EscapeToken) {
        const tail = this.stack[this.stack.length - 1]
        if (tail && tail.type === 'text') {
          if (!tail._escapes) tail._escapes = []
          tail._escapes.push(tail.value.length)
        }
        tail.value += this.sliceSerialize(token)
        if (tail.position) {
          tail.position.end = {
            line: token.end.line,
            column: token.end.column,
            offset: token.end.offset,
          }
        }
        this.stack.pop()
      },
      // 顺带在 parse 期标注 strong 的分隔符（`*` / `_`），供 remarkCjkEmphasis
      // 区分 `**...**` 与 `__...__`（如 `前**_a_**中**_b_**后` 中 remark-parse
      // 会把中间的 `**中**` 误配成 strong(`*`)，需按 `**` 展平重配，但不动 `__`）。
      strongSequence(this: CompileContextLike, token: EscapeToken) {
        const top = this.stack[this.stack.length - 1]
        if (top && top.type === 'strong' && !top._marker) {
          const ch = this.sliceSerialize(token)[0]
          if (ch === '*' || ch === '_') top._marker = ch
        }
      },
    },
  })
}
