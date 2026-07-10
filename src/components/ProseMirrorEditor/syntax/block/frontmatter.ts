// `---`(yaml) / `+++(toml)` 独占段落(文档首段)→ frontmatter 节点
//
// 与 hr 的关键差异:hr 在文档任意位置都生效(`---`/`***`/`___`),frontmatter 仅在
// 文档首段(doc 的第一个子节点,且当前无 frontmatter)触发,且只认 `---`(yaml) 与
// `+++(toml)` 两种 fence。frontmatterEnterCommand 插在 Enter keymap 链中
// hrEnterCommand 之前,优先拦截首段 `---`/`+++`+Enter;frontmatterSyntax 插在
// hrSyntax 之前,优先拦截首段 `--- `/`+++ `(空格触发)。
//
// 触发后:段落 → frontmatter 空节点(带 lang 属性标记种类)+ 尾随 paragraph,
// 光标进入 frontmatter 内容区供用户编辑。lang 决定序列化分隔符和 shiki grammar。

import { TextSelection } from 'prosemirror-state'
import type { Command, Transaction } from 'prosemirror-state'
import type { Schema } from 'prosemirror-model'
import type { BlockSyntax } from '../../editor/syntaxRegistry'

// frontmatter 种类 —— `---` → yaml,`+++` → toml。
export type FrontmatterLang = 'yaml' | 'toml'

// 与 hr 的 fence 规则差异:
//   hr 接受 3+ 的 -/-/*(如 `----`,`***`),frontmatter 只接受恰好 3 的 `---`(yaml)
//   或 `+++(toml)`,前导空格 ≤3,尾部可跟空白 —— 与 remark-frontmatter 的 micromark
//   解析规则(3-char buffer,第 4 字符须为空白/eol)一致,避免 `++++` 误转 frontmatter
//   后序列化回 `+++` 的 round-trip 丢失。
const FRONTMATTER_FENCE_RE = /^ {0,3}(-{3}|\+{3})[ \t]*$/

/** 检测段落文本是否为 frontmatter fence;是则返回种类(yaml / toml),否则 null。 */
export function frontmatterFenceKind(text: string): FrontmatterLang | null {
  if (!FRONTMATTER_FENCE_RE.test(text)) return null
  return text.trim()[0] === '+' ? 'toml' : 'yaml'
}

export function isFrontmatterFenceLine(text: string): boolean {
  return frontmatterFenceKind(text) !== null
}

export function isFrontmatterFenceSpaceTrigger(text: string): boolean {
  return /[ \t]$/.test(text) && isFrontmatterFenceLine(text)
}

function replaceParagraphWithFrontmatter(
  tr: Transaction,
  schema: Schema,
  blockStart: number,
  blockEnd: number,
  lang: FrontmatterLang,
): boolean {
  const fmType = schema.nodes.frontmatter
  if (!fmType) return false

  const $start = tr.doc.resolve(blockStart)
  const parent = $start.parent
  if (parent.type.name !== 'paragraph') return false

  const paraOuterStart = blockStart - 1
  const paraOuterEnd = blockEnd + 1

  // 创建空 frontmatter 节点(带 lang 属性)+ 尾随 paragraph。
  // lang 序列化时决定 fence 种类 + shiki grammar,不可省略。
  const fmNode = fmType.create({ lang }, [])
  const paraNode = schema.nodes.paragraph.create(null, [])

  tr.replaceRangeWith(paraOuterStart, paraOuterEnd, fmNode)
  // 在 frontmatter 后插入 paragraph
  const insertPos = tr.mapping.map(paraOuterEnd)
  tr.insert(insertPos, paraNode)

  // 光标进入 frontmatter 内容区
  const fmContentStart = paraOuterStart + 1
  tr.setSelection(TextSelection.create(tr.doc, fmContentStart))
  return true
}

/** `---`/`+++` + Enter(文档首段)→ frontmatter 节点(yaml / toml) */
export const frontmatterEnterCommand: Command = (state, dispatch) => {
  const { selection } = state
  if (!selection.empty) return false

  const { $from } = selection
  if ($from.parent.type.name !== 'paragraph') return false
  if ($from.parentOffset !== $from.parent.content.size) return false

  // 必须是 doc 的第一个子节点
  if ($from.depth !== 1) return false
  if ($from.index(0) !== 0) return false

  // doc 中不能已有 frontmatter($from.node(0) 才是 doc,$from.parent 是 paragraph)
  const doc = $from.node(0)
  for (let i = 0; i < doc.childCount; i++) {
    if (doc.child(i).type.name === 'frontmatter') return false
  }

  const blockStart = $from.start()
  const blockEnd = $from.end()
  const text = state.doc.textBetween(blockStart, blockEnd, '\n', '\n')
  const lang = frontmatterFenceKind(text)
  if (!lang) return false

  if (dispatch) {
    const tr = state.tr
    replaceParagraphWithFrontmatter(tr, state.schema, blockStart, blockEnd, lang)
    dispatch(tr)
  }
  return true
}

/** `--- `/`+++ ` + 空格(文档首段)→ frontmatter 节点(block syntax,空格触发) */
export const frontmatterSyntax: BlockSyntax = {
  name: 'frontmatter',
  // 段首快速预筛:① `-_*` 给 hr 留路(apply 内再用 frontmatterFenceKind 精确判断);
  // ② `+` 给 toml 留路。frontmatter 仅在前导 + 恰好 3 根时触发,见 apply。
  pattern: /^ {0,3}[-*_+ \t]+$/,
  apply(tr, { schema, blockStart, blockEnd }) {
    const text = tr.doc.textBetween(blockStart, blockEnd, '\n', '\n')
    const lang = frontmatterFenceKind(text)
    if (!lang) return false

    const $start = tr.doc.resolve(blockStart)
    if ($start.parent.type.name !== 'paragraph') return false

    // 必须是 doc 的第一个子节点
    if ($start.depth !== 1) return false
    if ($start.index(0) !== 0) return false

    // doc 中不能已有 frontmatter($start.node(0) 才是 doc)
    const doc = $start.node(0)
    for (let i = 0; i < doc.childCount; i++) {
      if (doc.child(i).type.name === 'frontmatter') return false
    }

    return replaceParagraphWithFrontmatter(tr, schema, blockStart, blockEnd, lang)
  },
}

// frontmatter 首位 Backspace:有内容吞掉事件(隔离),空 frontmatter 删除节点。
// 同 codeBlockBackspaceCommand 的隔离范式,但 frontmatter 是 doc 首子 + content:'text*',
// 删除时直接 replace 成空 paragraph(不能 setBlockType,因为 frontmatter 不属于 block 组)。
export const frontmatterBackspaceCommand: Command = (state, dispatch) => {
  const { selection } = state
  if (!selection.empty) return false

  const { $from } = selection
  if ($from.parent.type.name !== 'frontmatter') return false
  if ($from.parentOffset !== 0) return false

  // 有内容:吞掉事件,不做任何操作
  if ($from.parent.content.size > 0) {
    return true
  }

  // 空 frontmatter:删除节点,替换为空 paragraph,光标落在新段落起点
  if (dispatch) {
    const paragraphType = state.schema.nodes.paragraph
    if (!paragraphType) return false
    const tr = state.tr
    const fmStart = $from.before()
    const fmEnd = $from.after()
    tr.replaceRangeWith(fmStart, fmEnd, paragraphType.create(null, []))
    tr.setSelection(TextSelection.create(tr.doc, fmStart + 1))
    dispatch(tr)
  }
  return true
}
