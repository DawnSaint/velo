// `@tauri-apps/plugin-dialog` 的薄封装层 —— 见 `./fs.ts` 同款注释。
//
// 当前 thin re-export,后续如要在 dialog 周围统一加 "弹窗时暂停 fs:watch
// 防 saveAs 弹出触发自身 blur 二次写盘" 这类横切关心,集中改这里。

export {
  open,
  save,
  confirm,
  message,
} from '@tauri-apps/plugin-dialog'
