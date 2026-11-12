// `@tauri-apps/plugin-dialog` 的薄封装层 —— 见 `./fs.ts` 同款注释。
//
// 系统对话框只剩「选文件 / 选保存位置」两个入口;所有二选一确认已改为自绘弹窗
// (`useConfirmStore` + `VeloConfirmDialog.vue`,E2E 自动放行钩子也在 store 侧),
// 所以本模块不再包装 confirm。
//
// 当前 thin re-export,后续如要在 dialog 周围统一加 "弹窗时暂停 fs:watch
// 防 saveAs 弹出触发自身 blur 二次写盘" 这类横切关心,集中改这里。

import { open, save } from '@tauri-apps/plugin-dialog'

export { open, save }
