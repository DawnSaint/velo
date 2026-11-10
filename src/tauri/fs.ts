// `@tauri-apps/plugin-fs` 的薄封装层 —— 业务侧只 import 它。
//
// 为什么有这一层(v0.5.0):
//   1. 测试 mock 单一入口(后续 mock 打 `@/tauri/fs`,不再散布 `@tauri-apps/plugin-fs`)
//   2. tauri-driver / Playwright E2E 接入时,本层是唯一的 fs 边界,可一处插桩
//   3. 工作区时代起 fs 调用点会成倍增长(目录遍历、批量重命名、资产移动),
//      不收敛后续返工成本高
//
// 当前(v0.5.0)实现策略:thin re-export + 一个 `tauriOnly` 守门 helper。
// 错误形态保持原样(plugin-fs 自家:writeTextFile reject 是 Error,readTextFile
// reject 可能是 string),不在封装层强行统一 —— 各调用方有自己的降级策略
// (persistence: 静默落到默认值;document.save: 弹原生 message;imageStorage:
// throw 透传)。统一形态会破坏现有降级语义,见 v0.5-research §2。
//
// 已迁的调用点:`persistence.ts` / `document.ts` / `imageStorage.ts` /
// `export.ts` / `App.vue` / `workspaceStore`。新增 fs 调用必须走本层。

import { isTauri } from '@tauri-apps/api/core'
import {
  readTextFile as _readTextFile,
  writeTextFile as _writeTextFile,
  readFile as _readFile,
  writeFile as _writeFile,
  exists as _exists,
  mkdir as _mkdir,
  readDir as _readDir,
  remove as _remove,
  rename as _rename,
  copyFile as _copyFile,
  watch as _watch,
  watchImmediate as _watchImmediate,
  type UnwatchFn,
  type DirEntry,
} from '@tauri-apps/plugin-fs'

export type { UnwatchFn, DirEntry }

/**
 * dev web 端(纯 `npm run dev` 无 Tauri 进程)调 plugin-fs 任一函数会 throw
 * `Cannot read properties of undefined (reading 'invoke')`,因为
 * `__TAURI_INTERNALS__` 没注入。调用方应先 `tauriOnly()` 守门,web 端走
 * 默认值 / noop / 空数组等降级。
 */
export function tauriOnly(): boolean {
  return isTauri()
}

export const readTextFile = _readTextFile
export const writeTextFile = _writeTextFile
export const readFile = _readFile
export const writeFile = _writeFile
export const exists = _exists
export const mkdir = _mkdir
export const readDir = _readDir
export const remove = _remove
export const rename = _rename
/** 单文件复制(二进制安全,不走文本编解码)。目录复制需上层递归 readDir + copyFile 拼。 */
export const copyFile = _copyFile
export const watch = _watch

/**
 * 无去抖版本 —— 工作区根(递归监听)**必须**用这个,不要直接用 `watch`。
 *
 * plugin-fs 的 JS `watch()` 内部是 `{ delayMs: 2000, ...options }`:调用方
 * 即便不传 delayMs,Rust 侧 `WatchOptions.delay_ms` 仍是 Some,会走
 * notify-debouncer-full 分支。该分支在 `watch()` 里用 FileIdMap 对整棵目录树
 * WalkDir 逐路径取 file id,而 `watch` 是同步 command 跑在 Tauri 主线程 ——
 * 打开含 node_modules 的大目录会占死主线程,所有 IPC(含关闭窗口)排队,
 * 表现为整个窗口「未响应」。
 *
 * `watchImmediate()` 是 `{ ...options, delayMs: undefined }`,强制走
 * RecommendedWatcher:Windows 单个 ReadDirectoryChangesW 句柄即递归,注册 O(1)。
 * 去抖交给前端 dirtyDirs + 120ms timer 承担。
 *
 * 单文件监听(非递归)继续用 `watch({ delayMs: 100 })`:其 FileIdMap 只扫 1 个
 * 文件,开销可忽略,保留去抖可合并编辑器的连续写入事件。
 */
export const watchImmediate = _watchImmediate
