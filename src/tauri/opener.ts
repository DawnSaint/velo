// `@tauri-apps/plugin-opener` 的薄封装层 —— 见 `./fs.ts` 同款注释。
//
// 当前只透传 `revealItemInDir`(v0.5.1 文件树右键"在资源管理器中显示"
// 走这条 —— plugin-shell.open 只能"用默认应用打开",不能在文件管理器里
// 高亮该文件;plugin-opener 专门补这条,跨 Win/Mac/Linux 都给原生 reveal)。
// `openPath` / `openUrl` 在本项目里尚未用上,用到时再补,不预先填空壳。

export { revealItemInDir } from '@tauri-apps/plugin-opener'
