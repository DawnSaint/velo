// WebdriverIO 主配置 — Velo E2E。
//
// 工具链:WebdriverIO 9 + Mocha + spec-reporter + tauri-driver(WD Classic)
//   -> msedgedriver(WebView2 后端)
//
// 关键约束:
//   - Windows only — 非 Windows 在 onPrepare 直接 exit 0(详 helpers/platform)
//   - maxInstances: 1 — `tauri-plugin-single-instance` 让多 session 互相路由,
//     并行会立刻死;`taskkill /F /IM velo.exe /T` 三处兜底
//   - capabilities 里 application 用 helpers.findVeloBinary() debug 优先;
//     per-spec 工作区路径走 helpers.restartWithArgs 重起 session 改 args
//
// 不引入 ts-node:WDIO 9 内置 autoCompile,走 @wdio/cli 的 ts 入口足够。

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { assertWindows } from './helpers/platform.js'
import { killStaleVelo, findVeloBinary, buildDebugBinaryOnce } from './helpers/process.js'

// ESM 下无 __dirname,用 import.meta.url 推算
const __dirname = path.dirname(fileURLToPath(import.meta.url))

let tauriDriver: ChildProcess | null = null

function findTauriDriverBin(): string {
  // 默认 cargo install 到 ~/.cargo/bin
  const cargoBin = path.join(os.homedir(), '.cargo', 'bin', 'tauri-driver.exe')
  if (existsSync(cargoBin)) return cargoBin
  // fallback: 依赖 $PATH
  return 'tauri-driver.exe'
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  framework: 'mocha',
  reporters: ['spec'],

  hostname: '127.0.0.1',
  port: 4444,
  path: '/',

  specs: [path.resolve(__dirname, 'specs', '**', '*.spec.ts')],
  maxInstances: 1,
  logLevel: 'warn',
  waitforTimeout: 10_000,
  connectionRetryTimeout: 30_000,
  connectionRetryCount: 1,

  capabilities: [
    {
      maxInstances: 1,
      // tauri-driver Windows 分支识别 'wry' / 'webview2',前者按 Selenium 示例
      browserName: 'wry',
      // 类型上没 'tauri:options' — wdio Capabilities 是 strict;as 收口
      'tauri:options': {
        application: '__will_be_set_in_onPrepare__',
      },
    } as unknown as WebdriverIO.Capabilities,
  ],

  mochaOpts: {
    ui: 'bdd',
    timeout: 60_000,
  },

  // ---- 生命周期 ----

  onPrepare(_config, capabilities) {
    try {
      assertWindows()
      killStaleVelo()
      buildDebugBinaryOnce()
      const binary = findVeloBinary()
      // capabilities 在 onPrepare 是数组(local runner),回填真实路径
      for (const cap of capabilities as Array<Record<string, unknown>>) {
        const tauriOpts = cap['tauri:options'] as { application: string } | undefined
        if (tauriOpts) tauriOpts.application = binary
      }
      console.log(`[velo-e2e] using binary: ${binary}`)
    } catch (err) {
      // WDIO 默认会"hook 失败也照跑 session" — 给的 capability 还是占位字符串,
      // 报"no msedge binary at __will_be_set_in_onPrepare__.exe"误导人。
      // 直接 exit,让真实错误是 stack 的第一条。
      console.error('[velo-e2e] onPrepare failed:', err)
      process.exit(1)
    }
  },

  beforeSession() {
    const driverBin = findTauriDriverBin()
    console.log(`[velo-e2e] spawning tauri-driver from ${driverBin}`)
    tauriDriver = spawn(driverBin, [], { stdio: ['ignore', 'inherit', 'inherit'] })
    tauriDriver.on('error', err => {
      console.error('[velo-e2e] tauri-driver failed to start. Did you `cargo install tauri-driver`?', err)
    })
  },

  afterSession() {
    tauriDriver?.kill('SIGTERM')
    tauriDriver = null
    killStaleVelo()
  },

  onComplete() {
    tauriDriver?.kill('SIGKILL')
    killStaleVelo()
  },
}
