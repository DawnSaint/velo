// 临时工作区 fixture helper —— Node 内置 fs / os / path,不引入 tmp / uuid。
//
// 每个 spec 走 mkTempWorkspace 拿一个干净 dir,跑完 cleanupWorkspace 兜底删干净。
// spec fail 时也尽量清理(rmSync recursive force),但 Windows 上有时被 WebView2
// 进程 lock 住的 logs 文件会让 rmSync 抛 EBUSY — 那一类文件不会进 fixture 目录,
// 实际只清"测试自己生的"alpha.md / beta.md / seed.md,绝大多数情况下能成功。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function mkTempWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'velo-e2e-'))
}

export function cleanupWorkspace(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    console.warn('[velo-e2e] cleanupWorkspace failed', dir, e)
  }
}

export function seedFile(absPath: string, content: string): void {
  writeFileSync(absPath, content, 'utf8')
}
