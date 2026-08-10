// lint:design-tokens — 检测 SCSS / Vue <style> 中的硬编码颜色
//
// 规则（见 docs/architecture/styles.md）：
// - UI chrome 背景色应走海拔变量 var(--surface-N)，不硬编码
// - 主题色应走 var(--md-primary-color) / var(--md-doc-primary-color)
// - 允许：var(--xxx, #fallback) 中的 fallback 值（CSS 变量降级）
// - 允许：color-mix(in srgb, var(--xxx, #fallback) ...) 中的 fallback
// - 允许：rgba(0,0,0,0.08) 等海拔配套叠加层（--surface-border / --surface-hover 等
//   已定义为变量，但部分局部覆盖仍用直写 rgba，属存量技术债，baseline 记录）
//
// 检测对象：src/**/*.scss + src/**/*.vue 的 <style> 块
// 退出码：0 = 通过（或仅 baseline 内的违规），1 = 发现 baseline 外的新违规
//
// 初次运行用 --baseline 生成 baseline 文件，后续运行对比 baseline 防新增
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const srcDir = path.resolve(projectRoot, 'src')
const baselineFile = path.resolve(projectRoot, 'scripts/lint-design-tokens-baseline.json')

// ── 颜色正则 ──────────────────────────────────────────────
const COLOR_PATTERNS = [
  // #hex / #hexhex / #hexhexhex / #hexhexhexhex (4/6/8位)
  { regex: /#([0-9a-fA-F]{3,8})\b/g, label: 'hex' },
  // rgb() / rgba()
  { regex: /\brgba?\(\s*[\d.]+/g, label: 'rgb' },
  // hsl() / hsla()
  { regex: /\bhsla?\(\s*[\d.]+/g, label: 'hsl' },
]

// ── 文件收集 ──────────────────────────────────────────────
function collectFiles(dir, ext) {
  const results = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, ext))
    } else if (entry.isFile() && full.endsWith(ext)) {
      results.push(full)
    }
  }
  return results
}

// 从 Vue SFC 中提取 <style> 块的内容及其起始行号
function extractStyleBlocks(content) {
  const blocks = []
  const styleRegex = /<style[^>]*>/g
  let match
  while ((match = styleRegex.exec(content)) !== null) {
    const startTagEnd = match.index + match[0].length
    const closeTag = content.indexOf('</style>', startTagEnd)
    if (closeTag === -1) break
    const styleContent = content.substring(startTagEnd, closeTag)
    const startLine = content.substring(0, startTagEnd).split('\n').length
    blocks.push({ content: styleContent, startLine })
  }
  return blocks
}

// 移除 var(...) 调用（含嵌套），返回移除后的文本 + 被移除的字符范围
function stripVarCalls(line) {
  const ranges = []
  let result = line
  // 反复移除最内层的 var(...)（没有嵌套括号的）
  let changed = true
  while (changed) {
    changed = false
    const match = result.match(/var\(\s*[^()]*\)/)
    if (match) {
      const start = match.index
      const end = start + match[0].length
      ranges.push([start, end])
      result = result.substring(0, start) + ' '.repeat(match[0].length) + result.substring(end)
      changed = true
    }
  }
  // 也移除嵌套的 var(...)（移除内层后外层可能变成无嵌套）
  while (true) {
    const match = result.match(/var\(\s*[^()]*\)/)
    if (!match) break
    const start = match.index
    const end = start + match[0].length
    ranges.push([start, end])
    result = result.substring(0, start) + ' '.repeat(match[0].length) + result.substring(end)
  }
  return { stripped: result, ranges }
}

// 检查某位置是否在 var() 范围内
function isInsideVar(pos, varRanges) {
  return varRanges.some(([start, end]) => pos >= start && pos < end)
}

// 检查某位置是否在注释中
function isInComment(line, pos) {
  const before = line.substring(0, pos)
  // 行内注释 /* ... */ 或 //
  const blockComment = before.lastIndexOf('/*')
  if (blockComment !== -1 && before.indexOf('*/', blockComment) === -1) return true
  const lineComment = before.lastIndexOf('//')
  if (lineComment !== -1) return true
  return false
}

// ── 主逻辑 ────────────────────────────────────────────────
function findViolations() {
  const violations = []

  // 扫描 SCSS 文件
  const scssFiles = collectFiles(srcDir, '.scss')
  for (const file of scssFiles) {
    const content = fs.readFileSync(file, 'utf8')
    const lines = content.split('\n')
    const relPath = path.relative(projectRoot, file).replace(/\\/g, '/')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const { stripped, ranges } = stripVarCalls(line)

      for (const { regex, label } of COLOR_PATTERNS) {
        const localRegex = new RegExp(regex.source, regex.flags)
        let match
        while ((match = localRegex.exec(stripped)) !== null) {
          const pos = match.index
          if (isInsideVar(pos, ranges)) continue
          if (isInComment(line, pos)) continue
          violations.push({
            file: relPath,
            line: i + 1,
            col: pos + 1,
            color: match[0],
            type: label,
            content: line.trim(),
          })
        }
      }
    }
  }

  // 扫描 Vue <style> 块
  const vueFiles = collectFiles(srcDir, '.vue')
  for (const file of vueFiles) {
    const content = fs.readFileSync(file, 'utf8')
    const blocks = extractStyleBlocks(content)
    const relPath = path.relative(projectRoot, file).replace(/\\/g, '/')

    for (const block of blocks) {
      const lines = block.content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const { stripped, ranges } = stripVarCalls(line)

        for (const { regex, label } of COLOR_PATTERNS) {
          const localRegex = new RegExp(regex.source, regex.flags)
          let match
          while ((match = localRegex.exec(stripped)) !== null) {
            const pos = match.index
            if (isInsideVar(pos, ranges)) continue
            if (isInComment(line, pos)) continue
            violations.push({
              file: relPath,
              line: block.startLine + i,
              col: pos + 1,
              color: match[0],
              type: label,
              content: line.trim(),
            })
          }
        }
      }
    }
  }

  return violations
}

// 生成 violation 的唯一 key — 用 file:normalizedColor 而非 file:line:col
// 这样行号变动（插入 / 删除行）不会导致 baseline 漂移
// 代价：同一文件加一个已有颜色值不会被报（可接受，目标是最小化颜色种类）
function violationKey(v) {
  const normalizedColor = v.color.toLowerCase()
  return `${v.file}:${normalizedColor}`
}

// ── baseline 模式 ─────────────────────────────────────────
const isBaselineMode = process.argv.includes('--baseline')

const violations = findViolations()

if (isBaselineMode) {
  // baseline 按 file:color 记录，行号变动不影响
  const baseline = {}
  for (const v of violations) {
    const key = violationKey(v)
    if (!baseline[key]) {
      baseline[key] = { color: v.color, type: v.type }
    }
  }
  const sorted = Object.keys(baseline)
    .sort()
    .reduce((obj, key) => {
      obj[key] = baseline[key]
      return obj
    }, {})
  const fileCount = new Set(violations.map((v) => v.file)).size
  const colorCount = Object.keys(baseline).length
  fs.writeFileSync(baselineFile, JSON.stringify(sorted, null, 2) + '\n', 'utf8')
  console.log(
    `\n  \x1b[32m✓\x1b[0m lint:design-tokens — baseline written: ${colorCount} color(s) across ${fileCount} file(s) → ${path.relative(projectRoot, baselineFile)}\n`,
  )
  process.exit(0)
}

// ── 正常模式：对比 baseline ────────────────────────────────
// baseline key = file:normalizedColor，只防"新颜色值出现在新文件"，
// 不防"同文件同颜色加一个新位置"（可接受）
let baseline = {}
if (fs.existsSync(baselineFile)) {
  baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
}

// 按 key 去重当前 violations（同一 file+color 只报一次）
const currentKeys = new Set(violations.map(violationKey))
const baselineKeys = new Set(Object.keys(baseline))
const newKeys = [...currentKeys].filter((k) => !baselineKeys.has(k))

// 收集新违规的具体位置（取每个新 key 的第一个出现位置）
const newViolations = []
const seenKeys = new Set()
for (const v of violations) {
  const key = violationKey(v)
  if (newKeys.includes(key) && !seenKeys.has(key)) {
    newViolations.push(v)
    seenKeys.add(key)
  }
}

if (newViolations.length === 0) {
  console.log(
    `\n  \x1b[32m✓\x1b[0m lint:design-tokens — no new hardcoded colors (${currentKeys.size} baseline color(s) across ${new Set(violations.map((v) => v.file)).size} file(s))\n`,
  )
  process.exit(0)
} else {
  console.error(
    `\n  \x1b[31m✖\x1b[0m lint:design-tokens — ${newViolations.length} new hardcoded color(s) outside baseline\n`,
  )
  for (const v of newViolations) {
    console.error(`  \x1b[31m${v.file}:${v.line}:${v.col}\x1b[0m  ${v.color}  \x1b[90m${v.content}\x1b[0m`)
  }
  console.error('')
  console.error('  \x1b[90mRun `npm run lint:design-tokens:baseline` to update baseline after review.\x1b[0m\n')
  process.exit(1)
}
