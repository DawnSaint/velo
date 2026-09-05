// 严格版块级公式($ `$` 围栏)tokenizer。
//
// 移植自 micromark-extension-math@3 的 `math-flow.js`,**只改了两处判定**,
// 其余状态机逐字保留,确保缩进 / meta / lazy continuation 等边缘行为与上游一致。
//
// ## 为什么要自己写
//
// 上游 micromark-extension-math 没有任何 "非贪婪 / 必须闭合" 的配置项
// (remark-math 只有 `singleDollarTextMath` 一个开关),而它的默认行为会**吞掉后文**:
//
//   ```
//   $$          ← 开围栏
//   xxx \\
//   $           ← 用户删掉一个 $,围栏不再闭合
//
//   next paragraph
//   ```
//   上游解析结果:math_block = "$$\nxxx \\\n$\n\nnext paragraph\n"
//               ↑ 后续整个段落被吞进公式块 —— 真实数据损坏
//
// 根因在上游 `beforeContentChunk`:`if (code === codes.eof) return after(code)`
// —— 撞到 EOF 也算**成功闭合**。且内容里的空行是合法内容,围栏会一路贪婪匹配到
// 文档里下一个 `$$`(比如下一个公式块的闭合行)。
//
// ## 两处改动(A1 / A2)
//
// A1 **EOF 未闭合 → 整个构造失败**(不再 `after`,改 `nok`)。
// A2 **遇到空行 → 整个构造失败**。
//    只做 A1 不够:`$$\nA\n$\n\ntext\n\n$$\nB\n$$` 里,第 1 行的开围栏会一路
//    匹配到第 7 行(第 2 个公式块的闭合行),把 A / $ / text 全吞掉。
//    空行终止能把这个范围限制在一个段落内,杜绝跨块吞并。
//
// 失败(`nok`)后 micromark 会回退事件栈,把这一行当普通段落重新解析 —— 即
// "开围栏当作普通文本,而不是贪婪消费"。节点类型 / token 名与上游完全一致,
// 因此 mdast-util-math 的 `mathFromMarkdown()` 可以原样复用。
//
// ## A2 的代价
//
// `$$\nx\n\n$$`(公式块内含空行)不再识别为公式块。这是有意为之:
// LaTeX display math 里空行(段落分隔)本身非法,katex 也渲染不出来,
// 且编辑器序列化 math_block 时会 trim 首尾换行,不会自己产出这种结构。
// 退化结果是"内容保留、只是不当公式渲染",不会丢数据。

import { factorySpace } from 'micromark-factory-space'
import { markdownLineEnding } from 'micromark-util-character'
import { codes, constants, types } from 'micromark-util-symbol'

/** 块级公式构造。concrete 与上游保持一致。 */
export const strictMathFlow: any = {
  tokenize: tokenizeMathFenced,
  concrete: true,
  name: 'mathFlow',
}

/**
 * 严格续行构造。
 *
 * 需要访问外层 tokenizer 的 `self`(读 `parser.lazy` / `now()`),所以做成工厂,
 * 在 `tokenizeMathFenced` 里绑定 `self` 后使用。
 */
function createStrictContinuation(self: any): any {
  return { tokenize: tokenizeStrictContinuation, partial: true }

  /**
   * 上游叫 nonLazyContinuation,只挡 lazy continuation,空行和 EOF 都放行,
   * 于是围栏能一路跨段落吞内容。这里补上两个失败条件。
   */
  function tokenizeStrictContinuation(effects: any, ok: any, nok: any) {
    return start

    function start(code: any) {
      // EOF:围栏到文件尾都没闭合 → 失败。
      if (code === null) {
        return nok(code)
      }

      effects.enter(types.lineEnding)
      effects.consume(code)
      effects.exit(types.lineEnding)
      return lineStart
    }

    function lineStart(code: any) {
      // lazy continuation(在段落里被后续行"续写"出来)→ 失败。
      if (self.parser.lazy[self.now().line]) {
        return nok(code)
      }

      // 空行(下一行开头紧接换行或 EOF)→ 围栏到此仍未闭合 → 失败。
      // 这是防止跨块吞并的关键:搜索范围被限制在单个段落内。
      if (code === codes.eof || markdownLineEnding(code)) {
        return nok(code)
      }

      return ok(code)
    }
  }
}

function tokenizeMathFenced(this: any, effects: any, ok: any, nok: any) {
  // eslint-disable-next-line @typescript-eslint/no-this-alias -- micromark tokenizer 惯例:self 在嵌套函数中引用 tokenizer context
  const self = this
  const tail = self.events[self.events.length - 1]
  const initialSize =
    tail && tail[1].type === types.linePrefix
      ? tail[2].sliceSerialize(tail[1], true).length
      : 0
  let sizeOpen = 0
  const strictContinuation = createStrictContinuation(self)

  return start

  function start(code: any) {
    effects.enter('mathFlow')
    effects.enter('mathFlowFence')
    effects.enter('mathFlowFenceSequence')
    return sequenceOpen(code)
  }

  /** 数开围栏的 `$` 个数,少于 2 个不构成块级公式。 */
  function sequenceOpen(code: any) {
    if (code === codes.dollarSign) {
      effects.consume(code)
      sizeOpen++
      return sequenceOpen
    }

    if (sizeOpen < 2) {
      return nok(code)
    }

    effects.exit('mathFlowFenceSequence')
    return factorySpace(effects, metaBefore, types.whitespace)(code)
  }

  function metaBefore(code: any) {
    if (code === codes.eof || markdownLineEnding(code)) {
      return metaAfter(code)
    }

    effects.enter('mathFlowFenceMeta')
    effects.enter(types.chunkString, { contentType: constants.contentTypeString })
    return meta(code)
  }

  function meta(code: any) {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit(types.chunkString)
      effects.exit('mathFlowFenceMeta')
      return metaAfter(code)
    }

    if (code === codes.dollarSign) {
      return nok(code)
    }

    effects.consume(code)
    return meta
  }

  function metaAfter(code: any) {
    effects.exit('mathFlowFence')

    if (self.interrupt) {
      return ok(code)
    }

    // A2 / A1:开围栏之后紧接着就是空行或 EOF → 未闭合 → 整个构造失败。
    // 上游这里是 `after`(成功闭合),会产出空公式块并把 `$$` 吃掉。
    return effects.attempt(strictContinuation, beforeNonLazyContinuation, nok)(code)
  }

  function beforeNonLazyContinuation(code: any) {
    return effects.attempt(
      { tokenize: tokenizeClosingFence, partial: true },
      after,
      contentStart,
    )(code)
  }

  function contentStart(code: any) {
    return (
      initialSize
        ? factorySpace(effects, beforeContentChunk, types.linePrefix, initialSize + 1)
        : beforeContentChunk
    )(code)
  }

  function beforeContentChunk(code: any): any {
    // A1:EOF 仍未闭合 → 失败(上游是 `after`,即"EOF 也算闭合")。
    if (code === codes.eof) {
      return nok(code)
    }

    if (markdownLineEnding(code)) {
      // A2:空行 → 失败;正常续行 → 继续找闭合围栏。
      return effects.attempt(strictContinuation, beforeNonLazyContinuation, nok)(code)
    }

    effects.enter('mathFlowValue')
    return contentChunk(code)
  }

  function contentChunk(code: any) {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit('mathFlowValue')
      return beforeContentChunk(code)
    }

    effects.consume(code)
    return contentChunk
  }

  function after(code: any) {
    effects.exit('mathFlow')
    return ok(code)
  }

  /** 闭合围栏:`$` 个数不少于开围栏,且独占一行。 */
  function tokenizeClosingFence(effects: any, ok: any, nok: any) {
    let size = 0

    return factorySpace(effects, beforeSequenceClose, types.linePrefix,
      self.parser.constructs.disable.null.includes('codeIndented')
        ? undefined
        : constants.tabSize,
    )

    function beforeSequenceClose(code: any) {
      effects.enter('mathFlowFence')
      effects.enter('mathFlowFenceSequence')
      return sequenceClose(code)
    }

    function sequenceClose(code: any) {
      if (code === codes.dollarSign) {
        size++
        effects.consume(code)
        return sequenceClose
      }

      if (size < sizeOpen) {
        return nok(code)
      }

      effects.exit('mathFlowFenceSequence')
      return factorySpace(effects, afterSequenceClose, types.whitespace)(code)
    }

    function afterSequenceClose(code: any) {
      if (code === codes.eof || markdownLineEnding(code)) {
        effects.exit('mathFlowFence')
        return ok(code)
      }

      return nok(code)
    }
  }
}
