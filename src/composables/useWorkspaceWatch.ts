// 工作区根目录 fs.watch(v0.5.0)
//
// 单 recursive 句柄挂在 activeRoot。回调拿 watch event 推断脏目录,
// 100ms debounce 后让 Sidebar.refreshDir 重拉那棵子树。**不做 path diff**,
// 重拉整 dir 简单可靠,目录中数十个文件 readDir < 5ms。
//
// 与"当前文件 watch"(documentStore.startWatchOf)共存:当前文件也落在根树
// 下,会收到两份事件 —— 但 documentStore 内 `disk === lastSavedContent`
// 短路 + externalCheckInFlight 重入保护已足够去重,不需要在此特殊处理。
//
// 网络盘 / 同步工具的 notify-rs 漏报:window-focus 兜底已覆盖当前文件;
// 工作区根侧没有等价兜底(代价高 —— 重新整树 walk),v0.5.0 接受这个限制,
// 用户切回应用时手动点工作区刷新按钮(后续版本再补)。

import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { watch as watchFs, type UnwatchFn as FsUnwatchFn } from '@/tauri/fs'
import {
  clearAll as clearQuickOpenIndex,
  invalidate as invalidateQuickOpenIndex,
} from '@/utils/quickOpenIndex'
import type Sidebar from '@/components/Sidebar/Sidebar.vue'

export function useWorkspaceWatch(opts: {
  tauri: boolean
  sidebarRef: Ref<InstanceType<typeof Sidebar> | null>
  leftPanelView: Ref<'sidebar' | null>
}): void {
  const workspaceStore = useWorkspaceStore()
  const { tauri, sidebarRef, leftPanelView } = opts

  let workspaceUnwatch: FsUnwatchFn | null = null
  const dirtyDirs = new Set<string>()
  const pendingSidebarDirtyDirs = new Set<string>()
  let dirtyFlushTimer: ReturnType<typeof setTimeout> | null = null

  async function flushPendingSidebarDirtyDirs() {
    if (leftPanelView.value !== 'sidebar' || workspaceStore.sidebarTab !== 'files') return
    if (pendingSidebarDirtyDirs.size === 0) return
    await nextTick()
    const sidebar = sidebarRef.value
    if (!sidebar) return
    const dirs = Array.from(pendingSidebarDirtyDirs)
    pendingSidebarDirtyDirs.clear()
    for (const d of dirs) {
      sidebar.refreshDir(d)
    }
  }

  function scheduleDirtyFlush() {
    if (dirtyFlushTimer) return
    dirtyFlushTimer = setTimeout(() => {
      dirtyFlushTimer = null
      const dirs = Array.from(dirtyDirs)
      dirtyDirs.clear()
      const sidebar = sidebarRef.value
      for (const d of dirs) {
        if (sidebar) sidebar.refreshDir(d)
        else pendingSidebarDirtyDirs.add(d)
      }
      void flushPendingSidebarDirtyDirs()
      // Ctrl+P 索引也作废 —— 任何脏目录事件视为索引失效,下次面板打开重扫(v0.5.2)
      invalidateQuickOpenIndex(workspaceStore.activeRoot)
    }, 120)
  }

  /** 从 fs.watch 事件中的路径反推所属目录,以便定位要刷新哪棵子树。 */
  function dirnameOf(p: string): string {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
    return i <= 0 ? p : p.slice(0, i)
  }

  // activeRoot 变化:重建 watch。先 stop 后 start,沿用 documentStore.startWatchOf
  // 的 race 容忍策略 —— 用户快速切换工作区时,新 watch 句柄会赢,旧的就算回调
  // 漏过来也只是多刷一次树,无副作用。
  async function startWorkspaceWatch(root: string) {
    await stopWorkspaceWatch()
    if (!tauri) return
    try {
      workspaceUnwatch = await watchFs(
        root,
        (event) => {
          const paths = Array.isArray(event.paths) ? event.paths : []
          for (const p of paths) {
            dirtyDirs.add(dirnameOf(p))
          }
          // 极端情况下没解析到 path,至少刷一下根
          if (paths.length === 0) dirtyDirs.add(root)
          scheduleDirtyFlush()
        },
        { recursive: true, delayMs: 150 },
      )
    }
    catch (e) {
      console.error('工作区 watch 启动失败', e)
    }
  }

  async function stopWorkspaceWatch() {
    if (!workspaceUnwatch) return
    try { workspaceUnwatch() }
    catch (e) { console.warn('工作区 watch 停止失败', e) }
    workspaceUnwatch = null
  }

  watch(() => workspaceStore.activeRoot, async (r) => {
    // 切工作区 → 清掉旧 root 的延迟目录刷新,Ctrl+P 缓存整张表清掉
    // (新工作区不复用旧索引,且旧路径上的 watch 已停)。
    pendingSidebarDirtyDirs.clear()
    clearQuickOpenIndex()
    if (r) await startWorkspaceWatch(r)
    else await stopWorkspaceWatch()
  })

  watch(
    [() => leftPanelView.value, () => workspaceStore.sidebarTab],
    () => { void flushPendingSidebarDirtyDirs() },
  )

  onBeforeUnmount(() => {
    if (dirtyFlushTimer) {
      clearTimeout(dirtyFlushTimer)
      dirtyFlushTimer = null
    }
    void stopWorkspaceWatch()
  })
}
