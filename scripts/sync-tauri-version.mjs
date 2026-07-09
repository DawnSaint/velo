#!/usr/bin/env node
// 把 package.json 的 version 同步到 Tauri 那一侧的三份文件：
//   src-tauri/Cargo.toml      （[package].version）
//   src-tauri/Cargo.lock      （name = "velo" 这一节的 version）
//   src-tauri/tauri.conf.json （顶层 "version"）
//
// 发版流程已切换到 release-please（CI 自动 bump Cargo.toml / tauri.conf.json），
// 此脚本降级为本地辅助工具——手动发版或本地版本同步时使用。
// release-please 不处理 Cargo.lock（锁文件在 cargo build 时自动更新），
// 手动发版时跑此脚本可一并同步 Cargo.lock。
//
// 单独手跑：node scripts/sync-tauri-version.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version: newVersion } = JSON.parse(
  readFileSync(resolve(root, 'package.json'), 'utf8'),
)

// 允许 SemVer 主体 + 可选的 pre-release / build 元数据，比如 0.2.0 / 0.2.0-rc.1 / 0.2.0+sha.abc
if (!/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(newVersion)) {
  console.error(`[sync-tauri-version] package.json 里的 version 不是合法 SemVer: ${newVersion}`)
  process.exit(1)
}

function updateFile(relPath, regex, replacement) {
  const path = resolve(root, relPath)
  const before = readFileSync(path, 'utf8')
  if (!regex.test(before)) {
    console.error(`[sync-tauri-version] ${relPath}: 没匹到 version 字段（文件结构变了？）`)
    process.exit(1)
  }
  const after = before.replace(regex, replacement)
  if (before === after) {
    console.log(`[sync-tauri-version] ${relPath}: 已是 ${newVersion}，跳过`)
    return
  }
  writeFileSync(path, after)
  console.log(`[sync-tauri-version] ${relPath} → ${newVersion}`)
}

// src-tauri/Cargo.toml: 只动 [package] 节里的 version，绕开依赖块里的 version = "..."
updateFile(
  'src-tauri/Cargo.toml',
  /(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]*"/,
  `$1"${newVersion}"`,
)

// src-tauri/Cargo.lock: 锁文件里 name = "velo" 那一节的 version
updateFile(
  'src-tauri/Cargo.lock',
  /(name\s*=\s*"velo"\s*\nversion\s*=\s*)"[^"]*"/,
  `$1"${newVersion}"`,
)

// src-tauri/tauri.conf.json: 顶层 "version" 字段（第一处出现）
updateFile(
  'src-tauri/tauri.conf.json',
  /"version"\s*:\s*"[^"]*"/,
  `"version": "${newVersion}"`,
)
