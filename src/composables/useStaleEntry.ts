// 历史记录失效守卫(v0.7.15)—— 工作区目录 / 全局最近文件 / Ctrl+P 最近打开共用一套判定与弹窗。
//
// 背景:用户在资源管理器里删掉目录或文件后,应用内的历史记录不会自动消失。
// 旧行为是点击后走到 readDir / readTextFile 才报错(文件树「读取目录失败」/
// Toast「无法打开」),记录却一直留在列表里。现在统一在**访问记录前**做一次 exists,
// 明确返回 false 才判定失效,弹自绘确认框,用户确认后由各自 store 精确移除并落盘。
//
// 两条硬约束:
//  1. exists 抛错(权限不足 / 网络盘抖动 / 盘符下线)**不等于**路径不存在 ——
//     一律按有效处理,绝不能因一次 IO 抖动误删用户记录。
//  2. 启动期不批量扫全部历史记录(IO 风暴),只探测恢复真正要用的那几条,
//     且静默清理不弹框(冷启动弹窗会吓到用户)。

import { exists } from '@/tauri/fs'
import { useConfirmStore } from '@/stores/confirm'

/** exists 明确返回 false 才算失效;抛错按有效处理,避免误删记录。 */
export async function isMissingPath(path: string): Promise<boolean> {
  try {
    return (await exists(path)) === false
  }
  catch {
    return false
  }
}

/**
 * 启动恢复用:从候选路径里找第一条仍存在的,并把探测途中确认失效的收进
 * `missing` 供调用方一次性批量清理(逐条落盘会互相覆盖,见 recentFiles.removePaths)。
 * 只探测前 `limit` 条,避免开机对整份历史(上限 50)做 IO 风暴。
 */
export async function probeExistingPath(
  paths: string[],
  limit = 5,
): Promise<{ found: string | null, missing: string[] }> {
  const missing: string[] = []
  for (const path of paths.slice(0, limit)) {
    if (!(await isMissingPath(path))) return { found: path, missing }
    missing.push(path)
  }
  return { found: null, missing }
}

/** 统一的「目录 / 文件已失效」确认框 —— 与 ①历史工作区同款文案结构。 */
export function useStaleEntry() {
  const confirmStore = useConfirmStore()

  function confirmRemove(title: string, message: string, path: string): Promise<boolean> {
    return confirmStore.ask({
      title,
      message,
      detail: path,
      confirmText: '从列表移除',
      cancelText: '取消',
      kind: 'warning',
    })
  }

  return { isMissingPath, confirmRemove }
}
