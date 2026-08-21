// Velo 单实例锁应对 + binary 路径解析。
//
// `tauri-plugin-single-instance` 把第二次启动的 argv 路由进第一个进程,
// 多 spec 之间残留进程 = 新 session 直接被路由 = spec 全错。三处兜底:
//   - wdio.conf.ts::onPrepare 头一次清(上次跑挂的)
//   - afterSession 收尾
//   - onComplete 兜底
// 加 spec 自己的 before() 进一步加保险。

import { execSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM 下无 __dirname,用 import.meta.url 推算
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Windows 下 taskkill 强杀 velo.exe 及其子进程(WebView2 host)。
 *  无残留时 /IM 会以非零退出,这里 try/catch 吞掉。 */
export function killStaleVelo(): void {
  try {
    execSync('taskkill /F /IM velo.exe /T', { stdio: 'ignore' })
  } catch {
    // 没残留 → 非 0,正常
  }
}

/** 优先环境变量 VELO_E2E_BINARY（CI 下载产物路径），其次 debug profile，不存在退到 release。两个都没有 → 抛清晰错误。 */
export function findVeloBinary(): string {
  const envBinary = process.env.VELO_E2E_BINARY
  if (envBinary && existsSync(envBinary)) return envBinary
  const repoRoot = path.resolve(__dirname, '..', '..')
  const debugPath = path.join(repoRoot, 'src-tauri', 'target', 'debug', 'velo.exe')
  const releasePath = path.join(repoRoot, 'src-tauri', 'target', 'release', 'velo.exe')
  if (existsSync(debugPath)) return debugPath
  if (existsSync(releasePath)) return releasePath
  throw new Error(
    `[velo-e2e] velo.exe not found. ` +
      `Set VELO_E2E_BINARY env or run 'npm run tauri:build:debug' first.`,
  )
}

/** 重起 session 把新工作区路径塞进 tauri:options.args。capability 级 args
 *  在 multi-session 间不能切换,这是绕开方式。 */
export async function restartWithArgs(browser: WebdriverIO.Browser, args: string[]): Promise<void> {
  try {
    await browser.deleteSession()
  } catch {
    // session 已挂掉或刚启动尚未握手 — 忽略
  }
  killStaleVelo()
  await browser.reloadSession({
    'tauri:options': {
      application: findVeloBinary(),
      args,
    },
    // wdio TS 类型对自定义 cap 不完美,as any 收口在这一处
  } as unknown as WebdriverIO.Capabilities)
}

/** 一次性预构建 debug binary;Cargo 自身有增量,无变动时秒级。
 *  CI 环境跳过构建,binary 由前置 job 下载提供（VELO_E2E_BINARY）。 */
export function buildDebugBinaryOnce(): void {
  if (process.env.VELO_E2E_BINARY) {
    console.log('[velo-e2e] VELO_E2E_BINARY set, skipping build')
    return
  }
  const repoRoot = path.resolve(__dirname, '..', '..')
  const res = spawnSync('npm', ['run', 'tauri:build:debug'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  })
  if (res.status !== 0) {
    throw new Error(`[velo-e2e] tauri:build:debug exited with ${res.status}`)
  }
}
