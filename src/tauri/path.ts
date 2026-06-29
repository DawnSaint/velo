// `@tauri-apps/api/path` 的薄封装层 —— 见 `./fs.ts` 同款注释。
//
// 高频用的 `appDataDir` / `resourceDir` / `resolveResource` / `join` /
// `dirname` / `basename` / `sep` 在此汇总;其余(`homeDir` / `appLocalDataDir` 等)
// 用到再补。

export {
  appDataDir,
  resourceDir,
  resolveResource,
  join,
  dirname,
  basename,
  sep,
} from '@tauri-apps/api/path'
