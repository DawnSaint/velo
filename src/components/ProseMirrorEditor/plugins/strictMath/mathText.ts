// 行内公式($ `$x$` / `$$x$$`)tokenizer。
//
// 逐字移植自 micromark-extension-math@3 的 `math-text.js`,**行为不做任何改动**。
// 之所以要一起搬过来:`strictMathSyntax()` 必须同时注册 flow 和 text 两个构造,
// 而两者共用 `codes.dollarSign` 这个入口,不能一半用自写一半用上游。
//
// 行内公式不存在"跨块吞并"问题 —— `between()` 撞到 EOF 直接 `nok`,
// 未闭合的 `$` 会退回普通文本,所以这里保持与上游一致最安全。

import { markdownLineEnding } from 'micromark-util-character'
import { codes, types } from 'micromark-util-symbol'

/**
 * @param options `singleDollarTextMath`(默认 true):是否允许单 `$` 行内公式。
 */
export function strictMathText(options?: { singleDollarTextMath?: boolean | null }): any {
  const settings = options || {}
  let single = settings.singleDollarTextMath

  if (single === null || single === undefined) {
    single = true
  }

  return {
    tokenize: tokenizeMathText,
    resolve: resolveMathText,
    previous,
    name: 'mathText',
  }

  function tokenizeMathText(this: any, effects: any, ok: any, nok: any) {
    const self = this
    let sizeOpen = 0
    let size = 0
    let token: any

    return start

    function start(code: any) {
      effects.enter('mathText')
      effects.enter('mathTextSequence')
      return sequenceOpen(code)
    }

    function sequenceOpen(code: any) {
      if (code === codes.dollarSign) {
        effects.consume(code)
        sizeOpen++
        return sequenceOpen
      }

      if (sizeOpen < 2 && !single) {
        return nok(code)
      }

      effects.exit('mathTextSequence')
      return between(code)
    }

    function between(code: any): any {
      if (code === codes.eof) {
        return nok(code)
      }

      if (code === codes.dollarSign) {
        token = effects.enter('mathTextSequence')
        size = 0
        return sequenceClose(code)
      }

      // Tabs don't work, and virtual spaces don't make sense.
      if (code === codes.space) {
        effects.enter('space')
        effects.consume(code)
        effects.exit('space')
        return between
      }

      if (markdownLineEnding(code)) {
        effects.enter(types.lineEnding)
        effects.consume(code)
        effects.exit(types.lineEnding)
        return between
      }

      effects.enter('mathTextData')
      return data(code)
    }

    function data(code: any): any {
      if (
        code === codes.eof ||
        code === codes.space ||
        code === codes.dollarSign ||
        markdownLineEnding(code)
      ) {
        effects.exit('mathTextData')
        return between(code)
      }

      effects.consume(code)
      return data
    }

    function sequenceClose(code: any): any {
      if (code === codes.dollarSign) {
        effects.consume(code)
        size++
        return sequenceClose
      }

      if (size === sizeOpen) {
        effects.exit('mathTextSequence')
        effects.exit('mathText')
        return ok(code)
      }

      // 闭合 `$` 个数不匹配 → 当成内容继续。
      token.type = 'mathTextData'
      return data(code)
    }

    // `self` 保留:与上游一致,tokenizer 内保留 context 引用。
    void self
  }
}

/** 与上游一致:处理 padding 与相邻空格/数据的合并。 */
function resolveMathText(events: any[]) {
  let tailExitIndex = events.length - 4
  let headEnterIndex = 3
  let index: number
  let enter: number | undefined

  if (
    (events[headEnterIndex][1].type === types.lineEnding ||
      events[headEnterIndex][1].type === 'space') &&
    (events[tailExitIndex][1].type === types.lineEnding ||
      events[tailExitIndex][1].type === 'space')
  ) {
    index = headEnterIndex

    while (++index < tailExitIndex) {
      if (events[index][1].type === 'mathTextData') {
        events[tailExitIndex][1].type = 'mathTextPadding'
        events[headEnterIndex][1].type = 'mathTextPadding'
        headEnterIndex += 2
        tailExitIndex -= 2
        break
      }
    }
  }

  index = headEnterIndex - 1
  tailExitIndex++

  while (++index <= tailExitIndex) {
    if (enter === undefined) {
      if (index !== tailExitIndex && events[index][1].type !== types.lineEnding) {
        enter = index
      }
    } else if (index === tailExitIndex || events[index][1].type === types.lineEnding) {
      events[enter][1].type = 'mathTextData'

      if (index !== enter + 2) {
        events[enter][1].end = events[index - 1][1].end
        events.splice(enter + 2, index - enter - 2)
        tailExitIndex -= index - enter - 2
        index = enter + 2
      }

      enter = undefined
    }
  }

  return events
}

/** 前置检查:`$$` 前一个字符也是 `$`(且非转义)时不在此处开启公式。 */
function previous(this: any, code: any) {
  return (
    code !== codes.dollarSign ||
    this.events[this.events.length - 1][1].type === types.characterEscape
  )
}
