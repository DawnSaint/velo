// `@tauri-apps/api/path` 的薄封装层 —— 见 `./fs.ts` 同款注释。
//
// 业务里高频用的 `appDataDir` / `join` / `dirname` / `basename` / `sep` 在此
// 汇总;其余(`resolveResource` / `homeDir` 等)用到再补,不预先填空壳。

export {
  appDataDir,
  join,
  dirname,
  basename,
  sep,
} from '@tauri-apps/api/path'
