// gen-large-file-corpus.mjs — 大文件语料生成器
//
// 程序化生成不同尺寸的 markdown 测试语料（100KB / 500KB / 1MB），
// 包含混合语法（标题 / 表格 / 代码块 / 数学公式 / 列表 / 脚注 / 引用 / 链接 / 图片），
// 让 bench 有稳定的输入。
//
// 用法：node scripts/gen-large-file-corpus.mjs
// 输出：src/bench/corpus/{small.md, medium.md, large.md}
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const corpusDir = path.resolve(__dirname, '../src/bench/corpus')

// ── 语法块模板 ────────────────────────────────────────────
// 每个函数返回一段独立语法块，参数控制内容量

function headingBlock(i) {
  const levels = ['#', '##', '###', '####']
  const level = levels[i % levels.length]
  return `${level} 标题 ${i} — Section ${i}\n\n`
}

function paragraphBlock(i) {
  const sentences = [
    '这是一段用于性能测试的中文文本，包含足够多的字符来模拟真实笔记场景。',
    'Markdown 编辑器的核心价值在于所见即所得的写作体验，同时保留纯文本的可移植性。',
    '性能优化是一个持续的过程，需要基线来衡量每次改动的实际效果。',
    'ProseMirror 的 schema 系统允许精确控制文档结构，但解析复杂文档需要时间。',
    'CodeMirror 6 的源码模式提供了语法高亮和编辑能力，与 WYSIWYG 模式互补。',
    'Tauri 2 的架构让桌面应用可以使用 Web 技术开发，同时保持原生性能。',
    'Web Worker 解析是 Velo 的大文件优化方向之一，将主线程阻塞转移到后台线程。',
    '增量装饰系统通过视口感知来减少不必要的 DOM 操作，提升渲染性能。',
  ]
  const s1 = sentences[i % sentences.length]
  const s2 = sentences[(i + 1) % sentences.length]
  const s3 = sentences[(i + 2) % sentences.length]
  return `${s1}${s2}${s3}\n\n`
}

function codeBlock(i) {
  const langs = ['js', 'ts', 'python', 'rust', 'json', 'bash']
  const lang = langs[i % langs.length]
  const snippets = {
    js: `const result = items\n  .filter(x => x.active)\n  .map(x => x.value)\n  .reduce((sum, v) => sum + v, 0)\nconsole.log('total:', result)`,
    ts: `interface Config {\n  readonly name: string\n  readonly version: number\n}\nfunction loadConfig(path: string): Config {\n  return JSON.parse(readFileSync(path))\n}`,
    python: `def process(data):\n    results = []\n    for item in data:\n        if item.get('active'):\n            results.append(transform(item))\n    return results`,
    rust: `fn main() {\n    let items: Vec<i32> = (1..=100).collect();\n    let sum: i32 = items.iter().filter(|x| x % 2 == 0).sum();\n    println!("sum: {}", sum);\n}`,
    json: `{\n  "name": "project",\n  "version": "1.0.0",\n  "dependencies": {\n    "vue": "^3.5.0",\n    "pinia": "^4.0.0"\n  }\n}`,
    bash: `#!/bin/bash\nset -e\nfor file in src/**/*.ts; do\n  echo "processing $file"\n  npx eslint "$file" --fix\ndone`,
  }
  return '```' + lang + '\n' + snippets[lang] + '\n```\n\n'
}

function tableBlock(i) {
  const rows = 3 + (i % 5) // 3-7 行数据
  let md = '| 名称 | 类型 | 描述 | 状态 |\n| --- | --- | --- | --- |\n'
  const statuses = ['active', 'pending', 'done', 'archived']
  for (let r = 0; r < rows; r++) {
    const name = `项目-${i}-${r}`
    const type = r % 2 === 0 ? 'feature' : 'fix'
    const desc = `这是第 ${i} 个表格的第 ${r} 行数据描述`
    const status = statuses[r % statuses.length]
    md += `| ${name} | ${type} | ${desc} | ${status} |\n`
  }
  return md + '\n'
}

function listBlock(i) {
  let md = ''
  const isTask = i % 3 === 0
  if (isTask) {
    md += '- [ ] 待办事项 A\n'
    md += '- [x] 已完成事项 B\n'
    md += '- [ ] 待办事项 C\n'
  } else {
    md += '- 第一层列表项\n'
    md += '  - 第二层嵌套项\n'
    md += '    - 第三层嵌套项\n'
    md += '  - 第二层另一项\n'
    md += '- 第一层另一项\n'
  }
  return md + '\n'
}

function mathBlock(i) {
  if (i % 2 === 0) {
    // 块级公式
    return '$$\nE = mc^2\n\\\\\nF = ma\n\\\\\n\\\\int_0^\\\\infty e^{-x^2} dx = \\\\frac{\\\\sqrt{\\\\pi}}{2}\n$$\n\n'
  } else {
    // 行内公式
    return `能量公式 $E=mc^2$ 和勾股定理 $a^2+b^2=c^2$ 是常见的数学表达式。\n\n`
  }
}

function quoteBlock(i) {
  if (i % 4 === 0) {
    return '> [!NOTE]\n> 这是一个 GFM alert 提示框，用于测试 alert 解析性能。\n>\n> 多行内容。\n\n'
  }
  return '> 这是一段引用文本，用于测试 blockquote 的解析和序列化。\n>\n> 引用可以包含多行。\n\n'
}

function linkImageBlock(i) {
  let md = ''
  // 链接
  md += `[链接文本 ${i}](https://example.com/article-${i})\n\n`
  // 图片
  md += `![图片描述 ${i}](https://example.com/image-${i}.png)\n\n`
  return md
}

function footnoteBlock(i) {
  return `正文引用脚注[^fn-${i}]。\n\n[^fn-${i}]: 这是脚注 ${i} 的内容，提供补充说明。\n\n`
}

// ── 生成器 ────────────────────────────────────────────────
// 按顺序循环所有语法块类型，生成指定大小（字节数）的文档
function generateMarkdown(targetSize) {
  const blocks = [
    headingBlock,
    paragraphBlock,
    codeBlock,
    tableBlock,
    listBlock,
    mathBlock,
    quoteBlock,
    linkImageBlock,
    footnoteBlock,
    paragraphBlock, // 段落多来一轮
  ]

  let content = ''
  let i = 0
  while (Buffer.byteLength(content, 'utf8') < targetSize) {
    const fn = blocks[i % blocks.length]
    content += fn(i)
    i++
  }
  return content
}

// ── 主逻辑 ────────────────────────────────────────────────
const targets = [
  { name: 'small.md', size: 100 * 1024 }, // 100KB
  { name: 'medium.md', size: 500 * 1024 }, // 500KB
  { name: 'large.md', size: 1024 * 1024 }, // 1MB
]

fs.mkdirSync(corpusDir, { recursive: true })

for (const { name, size } of targets) {
  const md = generateMarkdown(size)
  const filePath = path.join(corpusDir, name)
  fs.writeFileSync(filePath, md, 'utf8')
  const actualSize = Buffer.byteLength(md, 'utf8')
  const kb = (actualSize / 1024).toFixed(0)
  console.log(`  ✓ ${name} — ${kb} KB`)
}

console.log(`\n  Corpus written to ${path.relative(path.resolve(__dirname, '..'), corpusDir)}/\n`)
