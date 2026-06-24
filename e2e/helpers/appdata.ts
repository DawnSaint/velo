// Velo appData 持久化文件备份/还原。
//
// 问题:debug build 跟 dev / release 共用 `%APPDATA%/com.velo.editor/`。E2E spec
// `setActiveRoot(tempWs)` 会触发 App.vue 的 debounce watch 落盘到这个目录的
// `velo-workspaces.json`,**永久污染**用户真实数据(active 指向已删的 tempWs,
// 用户下次 dev 启动看到"读取目录失败")。
//
// 修法:spec `before()` 调 snapshotAppData() 把三份 JSON 整体备份到临时文件,
// `after()` 调 restoreAppData() 全量回写。E2E 写盘任你飞,跑完原样不动。
//
// 不改 tauri.conf.json product name 拆 debug profile 的 appDataDir —— 那会
// 影响 npm run tauri:dev 的真实数据隔离行为(用户期望 dev 跟 release 同份)。

import { copyFileSync, existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_DATA = path.join(os.homedir(), 'AppData', 'Roaming', 'com.velo.editor')
const FILES = [
  'velo-workspaces.json',
  'velo-outline-state.json',
  'velo-settings.json',
] as const

/** snapshot 落到独立 dir,避免和 appData 同目录串扰 */
const SNAPSHOT_DIR = path.join(os.tmpdir(), 'velo-e2e-appdata-snapshot')

/** before(): 把当前 appData 三件 JSON 备份,记录每份"原本是否存在"。 */
export function snapshotAppData(): void {
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true })
  mkdirSync(SNAPSHOT_DIR, { recursive: true })
  for (const name of FILES) {
    const src = path.join(APP_DATA, name)
    if (existsSync(src)) {
      copyFileSync(src, path.join(SNAPSHOT_DIR, name))
    }
    else {
      // 标记空文件 = "原本不存在",restore 时删 E2E 新生的版本
      writeFileSync(path.join(SNAPSHOT_DIR, `${name}.missing`), '')
    }
  }
}

/** after(): 把 snapshot 全量回写;原本不存在的文件 → 删除 E2E 残留。 */
export function restoreAppData(): void {
  if (!existsSync(SNAPSHOT_DIR)) return
  for (const name of FILES) {
    const dst = path.join(APP_DATA, name)
    const snapshot = path.join(SNAPSHOT_DIR, name)
    const missing = path.join(SNAPSHOT_DIR, `${name}.missing`)
    if (existsSync(missing)) {
      if (existsSync(dst)) {
        try { unlinkSync(dst) } catch { /* 忽略 */ }
      }
    }
    else if (existsSync(snapshot)) {
      try { copyFileSync(snapshot, dst) } catch (e) {
        console.warn('[velo-e2e] restore failed', name, e)
      }
    }
  }
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true })
}

