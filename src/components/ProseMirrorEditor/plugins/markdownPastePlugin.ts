// text/plain 粘贴接管 —— 走 fromMarkdown 直接解析为 PM doc,
//
// 绕开 prosemirror-view 默认 plain-text fallback 的两个坑:
//
//   1. 默认 fallback(prosemirror-view/dist/index.js:2836-2844)把整段 text 按
//      `(?:\r\n?|\n)+` 拆成多个 `<p>`,然后 normalizeSiblings(:2881, :2901-2930)
//      给 doc 顶层找 wrapper 把这些 `<p>` 兄弟包起来 —— 自动选 blockquote 等 block
//      容器,产出 `Fragment([blockquote(p1, p2)])`,openStart=1
//
//   2. replaceSelection 的 Fitter(prosemirror-transform/dist/index.js:1375-1426)
//      把 blockquote 塞进当前 paragraph 失败 → dropNode → 字符被错位 mix 进原
//      paragraph → 后续 syntaxAutoFormatPlugin 在错位 doc 上跑 heading + strong,
//      进一步把字符搅乱(用户的 "## 执行摘要 (TL;DR) + **结论：不换。**" 粘贴后
//      变成 heading 内嵌 strong 混 plain text)
//
// 走 fromMarkdown:文本进 unified 解析管线,产出规范的 heading / paragraph / list 等
// 块级序列,直接 dispatch 即可,不再触发 Fitter 错误合并。
//
// 边界:
// - code_block / math_block / mermaid(光标在 spec.code 容器内)→ return null,
//   让 ProseMirror 默认 inCode 分支接管,粘贴字面文本不变
// - 空文本 / 解析失败 → return null,让默认 fallback 兜底
// - 用户按 Shift 强制 plain paste(Velo 是 md 编辑器,plain 仍应是 md)→ 忽略 plain
//   参数,统一走 fromMarkdown
//
// text/html 路径不受影响:parseFromClipboard(:2824)的 asText 判断在有 html 时
// 走 DOMParser.fromSchema 路径,clipboardTextParser 只接管纯文本。

import { Plugin } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { Slice, type ResolvedPos } from 'prosemirror-model'
import { fromMarkdown } from '../editor/markdownIO'
import { schema } from '../editor/schema'

export const markdownPastePlugin = new Plugin({
  props: {
    // prosemirror-view 的 TS 类型把 clipboardTextParser 标成返回 Slice(不能 null),
    // 但运行时 `parseFromClipboard:2833` 用 `if (parsed)` 接住,允许 null/false 让
    // 默认 plain-text fallback 接管 —— 这里我们用 cast 打开 null 返回,在 code_block
    // 内粘贴 / 空文本 / 解析失败时主动 return null 让默认 fallback 兜底。
    clipboardTextParser: ((text: string, $context: ResolvedPos) => {
      // 代码类容器内粘贴 → 走 ProseMirror 默认 inCode fallback(整段塞 code 节点)
      if ($context.parent.type.spec.code) return null

      // 表格 cell 内粘贴 → 不接管,让 tableCellInputGuardPlugin 的 clipboardTextParser
      // 解析 tab 分隔文本为表格行,或让 handlePaste 走 HTML 路径。
      // 否则 fromMarkdown 会把 "A\nB\nC"(列复制的 tab 分隔文本)解析成段落,
      // pastedCells 返回 null,handlePaste 退化到单 cell fallback,行列错乱。
      for (let d = $context.depth; d > 0; d--) {
        if ($context.node(d).type.spec.tableRole === 'row') return null
      }

      const trimmed = text.trim()
      if (!trimmed) return null

      let doc
      try {
        doc = fromMarkdown(text, schema)
      }
      catch {
        return null
      }

      // fromMarkdown 在输入是空字符串 / 只有空白时产出空 doc 兜底(单空 paragraph)
      // —— 这种 case 没意义,让默认 fallback 处理
      if (doc.childCount === 0) return null

      // 构造封闭 slice(0/0)而不是 maxOpen:ProseMirror paste 在 paragraph 末尾的
      // 标准行为是"join"前后 paragraph,把当前空 paragraph 与 slice 的 blocks
      // merge 进 doc 顶层。Slice.maxOpen 会让两端 open(1/1),Fitter 在 paragraph
      // 边界 paste block content 时无法 fit,反而走 dropNode 把内容丢了。
      return new Slice(doc.content, 0, 0)
    }) as unknown as (this: Plugin, text: string, $context: ResolvedPos, plain: boolean, view: EditorView) => Slice,
  },
})