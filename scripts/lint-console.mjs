// lint:console — 检测 src/ 下遗留的 console.log / console.debug
//
// 规则：
// - console.log / console.debug = 违规（调试日志不应进提交）
// - console.warn / console.error / console.info / console.group / console.table / console.groupEnd = 允许
// - 尊重 eslint-disable 指令（eslint-disable-next-line no-console / eslint-disable no-console）
// - 跳过测试文件（__tests__/ / *.test.ts / *.spec.ts）和字符串字面量中的 console.log
//
// 用法：node scripts/lint-console.mjs
// 退出码：0 = 通过，1 = 发现违规
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const srcDir = path.resolve(__dirname, '../src')

const FORBIDDEN = ['console.log', 'console.debug']

// 跳过的目录 / 文件后缀
function isTestFile(filePath) {
  return (
    filePath.includes('__tests__') ||
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.spec.ts')
  )
}

// 递归收集 .ts / .vue 文件
function collectFiles(dir) {
  const results = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectFiles(full))
    } else if (entry.isFile() && (full.endsWith('.ts') || full.endsWith('.vue'))) {
      results.push(full)
    }
  }
  return results
}

// 检查某一行是否被 eslint-disable 覆盖
function isEslintDisabled(lines, lineIndex) {
  // 同行 eslint-disable
  if (/eslint-disable.*no-console/.test(lines[lineIndex])) return true
  // 上一行 eslint-disable-next-line
  if (lineIndex > 0 && /eslint-disable-next-line.*no-console/.test(lines[lineIndex - 1])) return true
  // 向上找 eslint-disable（块级），遇到 eslint-enable 停止
  for (let i = lineIndex - 1; i >= 0; i--) {
    const line = lines[i]
    if (/eslint-enable.*no-console/.test(line)) return false
    if (/\/\*\s*eslint-disable[^*]*no-console/.test(line)) return true
  }
  return false
}

// 判断 console.log 是否在字符串字面量中（简易启发式）
function isInString(line, matchIndex) {
  // 检查 match 前面的引号 / 反引号是否未闭合
  const before = line.substring(0, matchIndex)
  const singleQuotes = (before.match(/(?<!\\)'/g) || []).length
  const doubleQuotes = (before.match(/(?<!\\)"/g) || []).length
  const backticks = (before.match(/`/g) || []).length
  // 奇数个引号 = 在字符串内
  return singleQuotes % 2 === 1 || doubleQuotes % 2 === 1 || backticks % 2 === 1
}

const violations = []
const files = collectFiles(srcDir)

for (const file of files) {
  if (isTestFile(file)) continue

  const content = fs.readFileSync(file, 'utf8')
  const lines = content.split('\n')
  const relPath = path.relative(path.resolve(__dirname, '..'), file)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // 跳过注释行
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

    // 跳过 eslint-disable 覆盖的行
    if (isEslintDisabled(lines, i)) continue

    for (const pattern of FORBIDDEN) {
      let searchFrom = 0
      while (true) {
        const idx = line.indexOf(pattern, searchFrom)
        if (idx === -1) break

        // 跳过字符串字面量中的匹配
        if (!isInString(line, idx)) {
          violations.push({
            file: relPath,
            line: i + 1,
            col: idx + 1,
            pattern,
            content: trimmed,
          })
        }
        searchFrom = idx + pattern.length
      }
    }
  }
}

// 输出
if (violations.length === 0) {
  console.log('\n  \x1b[32m✓\x1b[0m lint:console — no console.log / console.debug found\n')
  process.exit(0)
} else {
  console.error(`\n  \x1b[31m✖\x1b[0m lint:console — ${violations.length} violation(s)\n`)
  for (const v of violations) {
    console.error(`  \x1b[31m${v.file}:${v.line}:${v.col}\x1b[0m  ${v.pattern}  \x1b[90m${v.content}\x1b[0m`)
  }
  console.error('')
  process.exit(1)
}
