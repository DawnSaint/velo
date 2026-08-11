// 轻量 Mermaid tokenizer —— 绕过 shiki mermaid grammar(上游 grammar 几乎是
// 摆设:codeToTokens 输出全是 defaultText 默认色,无 scope/explanation)。
//
// 自写一套粗粒度正则 tokenizer,输出跟 shiki ThemedToken 同形(offset 是相对
// code 开头的全局偏移),CodeHighlightWidget.buildDecorations 走 mermaid 旁路
// 分支。**颜色不在本模块管**:本模块只输出 token type,buildDecorations 再用
// getMermaidColors 从当前代码块主题(light/dark theme)的 settings 按 scope
// 提取代表性 hex,写进 inline `--shiki-light:${hex};--shiki-dark:${hex}` 局部
// CSS 变量 —— 跟 shiki token **完全同形**,SCSS `color: var(--shiki-light)`
// 接管选色。这样:
//   - 代码块主题切换(App.vue watch → dispatch setMeta → rebuild)→ 新 hex
//   - dark/light 切换(纯 CSS cascade,零重渲)
// 两条路径都不用额外处理(跟 shiki 普通代码块完全一致)。
//
// 设计取舍:
// - **粗粒度 6 类**:keyword / direction / shape / edge / label / comment。
//   覆盖 sample.md 真实样本(graph LR / graph TD / pie)+ 用户常见写法
//   (节点形状 []/()/{}/(())、边 -->/-.->、edge label |...|、%% 注释)。
// - **offset 用 JS string.length(UTF-16 code unit)**:跟 ProseMirror doc 的
//   pos 体系一致,不能用码点数(多字节 CJK 也不影响,length 已经是 2)。
// - **按行扫描**:mermaid 没有跨行 token(边/节点都在单行内),按行切最稳。
// - **plain 兜底**:未匹配的空白 / 普通字符不产出 token(让 shiki pre 默认色
//   `--shiki-light` 接管,跟普通代码块视觉一致),只对有语义的部分上色。

// ============================================================
//  Token 类型(6 类,颜色映射见 CodeHighlightWidget.MERMAID_TYPE_TO_SCOPE)
// ============================================================

type MermaidTokenType =
  | 'keyword'   // 图类型词:graph / flowchart / subgraph / end / pie / title /
  // sequenceDiagram / classDiagram / stateDiagram / erDiagram / gantt /
  // journey / gitGraph / mindmap / timeline / style / classDef / class / linkStyle
  | 'direction' // 方向:TD / LR / RL / BT / TB
  | 'shape'     // 节点形状成对符号:[ ] ( ) { } (( )) [[ ]] > ] {{ }} [/ \]
  | 'edge'      // 边箭头:--> --- -.-> ==> -.- 以及 ; 行终止符
  | 'label'     // edge label |...| / 字符串 "..." / pie 数字 / 节点 label 文字
  | 'comment'   // %% 注释(整行)

export interface MermaidToken {
  /** token 原文。 */
  content: string
  /** 相对整个 code 字符串开头的全局偏移(跨行累加,含前面行的 \n)。 */
  offset: number
  /** token 语义类型。 */
  type: MermaidTokenType
}

// ============================================================
//  关键字 / 方向清单
// ============================================================

// 行首(允许前导空白)的图类型词 + 指令词。顺序敏感:长串放前面,避免 `class`
// 先于 `classDef` / `classDiagram` 命中。
const KEYWORDS = [
  'sequenceDiagram', 'classDiagram', 'stateDiagram', 'stateDiagram-v2',
  'erDiagram', 'gitGraph', 'mindmap', 'timeline', 'journey',
  'subgraph', 'classDef', 'linkStyle', 'flowchart',
  'graph', 'pie', 'gantt', 'title', 'style', 'class', 'end',
] as const

const DIRECTIONS = ['TB', 'TD', 'BT', 'RL', 'LR'] as const

// ============================================================
//  单行正则表(按优先级从高到低)
// ============================================================

// 每个 entry:[正则(必须 sticky `y` + 从 lastIndex 起匹配),type]。
// sticky 标志确保正则只在当前游标位置匹配,不前窜。
//
// **顺序敏感**:长串 / 易冲突的放前面:
//  1. comment `%%` → 整行剩余
//  2. shape 成对符号(先 (( )) 再 ( ),先 [[ ]] 再 [ ],先 {{ }} 再 { })
//  3. edge(先 -.-> 再 --> 再 ---,先 ==> 再 ==)
//  4. label(管道 |...|、字符串 "..."、pie 数字)
//  5. keyword / direction(行首词,单独函数处理)
interface Rule {
  re: RegExp
  type: MermaidTokenType
}

const LINE_RULES: Rule[] = [
  // comment —— `%%` 后整行
  { re: /%%.*/y, type: 'comment' },

  // shape —— 成对节点形状符号(注意长串优先)
  // 双括号 (( )) 必须在单括号 ( ) 之前,否则 ((X)) 会被 (X) 切坏
  { re: /\(\([\s\S]*?\)\)/y, type: 'shape' }, // ((圆形))
  { re: /\[\[[\s\S]*?\]\]/y, type: 'shape' }, // [[子例程]]
  { re: /\{\{[\s\S]*?\}\}/y, type: 'shape' }, // {{六边形}}
  { re: /\[\s*\/[\s\S]*?\/\s*\]/y, type: 'shape' }, // [/平行四边形/]
  { re: /\[\s*\\[\s\S]*?\\\s*\]/y, type: 'shape' }, // [\反向平行四边形\]
  { re: /\[[\s\S]*?\]/y, type: 'shape' }, // [矩形]
  { re: /\([\s\S]*?\)/y, type: 'shape' }, // (圆角)
  { re: /\{[\s\S]*?\}/y, type: 'shape' }, // {菱形}
  // >不对称形状]:只在行内遇到 `>` 且后续有 `]` 时匹配;保守起见要求中间无换行
  // (单行扫描本身已保证无换行,这里 [\s\S] 等价于 . 的非贪婪)。
  { re: />[^[\]]*?\]/y, type: 'shape' },

  // edge —— 边箭头(长串优先)。用 alternation 单条正则,sticky + lastIndex
  // 保证只在游标处匹配;按从长到短排列,避免 --- 先于 -.-> 命中。
  // 支持:<--> / -.-> / --> / ==> / --- / === / -- / == / -. / ;(行终止)
  { re: /<-\.->|<-->|-\.->|-->|==>|===|---|--|==|-\.|;/y, type: 'edge' },

  // label —— edge label |...|(管道里可有空格,用 [^|] 非贪婪)
  { re: /\|[^|]*\|/y, type: 'label' },
  // label —— 字符串 "..."(双引号,可含转义)
  { re: /"(?:[^"\\]|\\.)*"/y, type: 'label' },
]

// ============================================================
//  单行 tokenize
// ============================================================

/**
 * 把单行(不含 `\n`)切成 token 列表。
 * @param line      单行文本(已剥离 `\n`)
 * @param lineBase  该行起始相对整个 code 的全局偏移
 * @returns         该行的 token 数组(可能为空 —— 整行都是空白兜底)
 */
function tokenizeLine(line: string, lineBase: number): MermaidToken[] {
  const tokens: MermaidToken[] = []
  let i = 0

  // 行首 keyword(允许前导空白):keyword 必须是独立词(后跟空白 / 行尾 / 分号)
  // —— 否则 `classDef` 会被当成普通标识符的一部分。
  const leadingMatch = line.match(/^\s*/)
  const kwStart = leadingMatch ? leadingMatch[0].length : 0

  if (kwStart < line.length) {
    const rest = line.slice(kwStart)
    // keyword:精确匹配关键字清单中的一个,后跟单词边界
    for (const kw of KEYWORDS) {
      if (rest.startsWith(kw)) {
        const after = rest[kw.length]
        // 后面必须是空白 / 行尾 / 分号 / 非单词字符才算 keyword
        if (after === undefined || /[\s;]/.test(after)) {
          tokens.push({
            content: kw,
            offset: lineBase + kwStart,
            type: 'keyword',
          })
          i = kwStart + kw.length
          // keyword 后面紧跟的方向(TD/LR 等):graph LR / flowchart TD
          const dirRest = line.slice(i).match(/^\s+([A-Z]{2})\b/)
          if (dirRest) {
            const dir = dirRest[1]
            if ((DIRECTIONS as readonly string[]).includes(dir)) {
              // 中间的空白不产出 token(默认色接管)
              tokens.push({
                content: dir,
                offset: lineBase + i + dirRest[0].length - dir.length,
                type: 'direction',
              })
              i = i + dirRest[0].length
            }
          }
          break
        }
      }
    }
  }

  // 行剩余部分按 LINE_RULES 扫描
  while (i < line.length) {
    let matched = false

    // 跳过空白(不产出 token,让默认色接管)
    const ws = line.slice(i).match(/^\s+/)
    if (ws) {
      i += ws[0].length
      continue
    }

    for (const rule of LINE_RULES) {
      rule.re.lastIndex = i
      const m = rule.re.exec(line)
      if (m && m.index === i && m[0].length > 0) {
        tokens.push({
          content: m[0],
          offset: lineBase + i,
          type: rule.type,
        })
        i += m[0].length
        matched = true
        break
      }
    }

    if (!matched) {
      // 未匹配 —— 跳过 1 字符(让默认色接管)。这里**不**产出 plain token,
      // 避免跟 shiki 默认色 span 重叠(inline decoration 重叠在同一位置
      // 会后者覆盖前者,但不影响显示 —— 不产出更干净)。
      i += 1
    }
  }

  return tokens
}

// ============================================================
//  入口:tokenizeMermaid
// ============================================================

/**
 * 把整段 mermaid 源码切成 `MermaidToken[][]`(行数组,每行 token 数组)。
 * 跟 shiki `codeToTokensWithThemes` 返回的 `tokens: ThemedToken[][]` 同形,
 * buildDecorations 可以用同一套 `for line of tokens` 循环消费。
 *
 * @param code  mermaid 源码(含 `\n`)
 * @returns     按行切分的 token 二维数组;空字符串返回 `[[]]`(跟 shiki 一致)
 */
export function tokenizeMermaid(code: string): MermaidToken[][] {
  if (!code) return [[]]
  // 用 split 保留行数:注意 code 末尾若有 \n,split 会产生末尾空串元素,
  // 对应"最后一行空",与 shiki 行为一致。
  const lines = code.split('\n')
  const result: MermaidToken[][] = []
  let lineBase = 0 // 当前行起始相对整个 code 的全局偏移
  for (const line of lines) {
    result.push(tokenizeLine(line, lineBase))
    // +line.length(本行字符数) + 1(行尾 \n,split 已剥离但偏移要算上)
    lineBase += line.length + 1
  }
  return result
}
