// 工作区搜索编排(v0.6.x)
//
// 侧栏内嵌的 WorkspaceSearchPanel 的状态 ref + 替换编排 + 结果定位逻辑。
// 搜索面板的挂载/卸载由 workspaceStore.sidebarTab === 'search' 走 Sidebar
// 的 v-if 控制,本 composable 只持有"从选区带入的初始 query"语义 ref +
// 替换编排 + scope dir + 结果定位。

import { nextTick, ref, type Ref } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useWorkspaceStore } from '@/stores/workspace'
import { useNotifyStore } from '@/stores/notify'
import type { SidebarTab } from '@/stores/persistence'
import type { FindReplaceBackend } from '@/components/ProseMirrorEditor/findreplace/backend'
import {
  revealWorkspaceSearchMatch,
  applyWorkspaceReplace,
  type WorkspaceSearchHit,
  type ReplacePlan,
} from '@/utils/workspaceSearch'

export function useWorkspaceSearch(opts: {
  leftPanelView: Ref<'sidebar' | null>
  quickCommandOpen: Ref<boolean>
  findOpen: Ref<boolean>
  showSidebarTab: (tab: SidebarTab) => void
  getActiveBackend: () => FindReplaceBackend | null
  currentSelectionText: () => string
}) {
  const documentStore = useDocumentStore()
  const workspaceStore = useWorkspaceStore()
  const notify = useNotifyStore()

  // 工作区全文搜索(v0.6.x):改为侧栏内嵌 tab,本 ref 仅保留"从选区带入的
  // 初始 query"语义,挂载 / 卸载由 workspaceStore.sidebarTab === 'search'
  // 走 Sidebar 的 v-if 控制。
  const workspaceSearchInitialQuery = ref('')
  // 文件夹搜索 scope(v0.6.0):文件树右键菜单「在此文件夹中搜索」会把目录
  // 路径写进这里,Sidebar 透传给 WorkspaceSearchPanel 作为 BFS 起点。
  // 不持久化 —— 用户重开面板想"重新看全工作区",保留旧 scope 反直觉。
  const workspaceSearchScopeDir = ref<string | null>(null)
  // 替换反馈(v0.6.0):applyWorkspaceReplace 完成后写一次面板底部 status,
  // 由 prop watcher 显示一次性文案,然后用户后续搜索/输入清掉。
  const workspaceSearchReplaceStatus = ref<string>('')
  // 替换 / 全部替换后触发 panel 重跑搜索的计数器
  const workspaceSearchRerunToken = ref(0)

  function openWorkspaceSearch() {
    if (!workspaceStore.activeRoot) return
    // Ctrl+Shift+F 行为(v0.6.x 侧栏内嵌后):
    //   - 始终打开 search tab,不 toggle 关闭 —— 用户重复按也保持可见
    //   - 仅当编辑器有选区时,把内容写进 workspaceSearchInitialQuery 触发
    //     WorkspaceSearchPanel 的 watch 把内容写进搜索框;空选区不动
    //     initialQuery,保留用户已输入的搜索词
    const sel = opts.currentSelectionText()
    if (sel) workspaceSearchInitialQuery.value = sel
    opts.quickCommandOpen.value = false
    if (opts.leftPanelView.value !== 'sidebar' || workspaceStore.sidebarTab !== 'search') {
      opts.showSidebarTab('search')
    }
    // 始终 focus 搜索输入框:侧栏已在 search tab 且无选区时,initialQuery 不变 →
    // panel 的 watcher 不触发 → 输入框不会被 focus。这里 nextTick 后手动 focus,
    // 确保 Ctrl+Shift+F 从 FindReplace / 编辑器按下时搜索框都能获得焦点。
    nextTick(() => {
      document.querySelector<HTMLInputElement>('[data-testid="workspace-search-input"]')?.focus()
    })
  }

  // FindReplace 内的 Ctrl+Shift+F / Ctrl+H 不走 App.vue 的 onKeydown(capture 阶段
  // closest data-fr-panel 直接 return,把控制权让给面板),由面板 emit 出来后再走。
  // 关闭本面板 + 打开全局搜索,与外部按 Ctrl+Shift:F 行为一致。
  function openGlobalSearchFromFind() {
    openWorkspaceSearch()
  }

  function selectAndRevealWorkspaceSearchMatch(be: FindReplaceBackend, from: number, to: number) {
    revealWorkspaceSearchMatch(be, from, to)
  }

  async function selectWorkspaceSearchHit(hit: WorkspaceSearchHit): Promise<boolean> {
    const be = opts.getActiveBackend()
    if (!be) return false

    if (documentStore.sourceMode) {
      const matches = be.findMatches(hit.query, hit.options)
      const match = matches[hit.matchOrdinal]
      if (match) {
        selectAndRevealWorkspaceSearchMatch(be, match.from, match.to)
        return true
      }
      const rawText = be.getRangeText(hit.rawFrom, hit.rawTo)
      if (rawText === hit.matchText) {
        selectAndRevealWorkspaceSearchMatch(be, hit.rawFrom, hit.rawTo)
        return true
      }
      return false
    }

    // WYSIWYG: 直接信任 pmMatches[hit.matchOrdinal],不再校验
    // pmMatches.length === hit.fileMatchCount。raw scan 走 per-line 全串正则,
    // 命中包含 code_block / image / mermaid 等非 text 节点的源码内容;
    // PM findMatchesInDoc 只扫 text 节点,跳过这些节点;两边计数规则天然不一致,
    // 等式几乎永远不成立 —— 旧校验等价于"文件不能含任何特殊节点",导致含图 /
    // mermaid / 代码块的笔记 100% 报"结果已过期"。
    // raw ordinal 与 PM pmMatches 在 prose 节点(paragraph / heading / list)上
    // 对齐(text node 一次 exec 不跨节点,同段 N 个 match ordinal 0..N-1);raw 命中
    // 若落在 code_block / image / mermaid 节点里,PM pmMatches[ordinal] undefined
    // → 静默放弃,文件已 openPathInTab 打开,用户至少能浏览到目标行附近。
    // 不自动切 source mode:与 workspace-search 架构决策一致,避免劫持用户当前
    // 编辑模式;App.vue 的跨模式光标 / 滚动同步 watch 只服务主动 Ctrl+` 入口。
    const pmMatches = be.findMatches(hit.query, hit.options)
    const pmMatch = pmMatches[hit.matchOrdinal]
    if (pmMatch) {
      selectAndRevealWorkspaceSearchMatch(be, pmMatch.from, pmMatch.to)
      return true
    }

    return false
  }

  async function openWorkspaceSearchResult(hit: WorkspaceSearchHit) {
    const ok = await documentStore.openPathInTab(hit.fullPath)
    if (!ok) return
    workspaceStore.setLastFile(hit.fullPath)
    await nextTick()
    const selected = await selectWorkspaceSearchHit(hit)
    if (!selected) console.warn('[WorkspaceSearch] 结果已过期,无法定位选区:', hit)
    // v0.6.x:侧栏内嵌模式下**不**自动关闭面板 —— 用户可以连续点多个结果;
    // 关闭走 X / Esc / 再次点 ActivityBar 搜索图标。
  }

  // 文件树右键菜单「在此文件夹中搜索」:写 scope + 切到 search tab。
  // 不带 initialQuery —— 保留用户已输入的搜索词,只换 scope。
  function onSearchInFolder(dirPath: string) {
    workspaceSearchScopeDir.value = dirPath
    opts.showSidebarTab('search')
  }

  function onWorkspaceSearchClearScope() {
    workspaceSearchScopeDir.value = null
  }

  // 工作区搜索「替换」/「全部替换」编排(v0.6.0):
  //  - snapshot 当前所有脏盘 tab 的 path(替换开始瞬间,避免 race)
  //  - 调 applyWorkspaceReplace 拿 result(IO 已落盘)
  //  - 同步打开中的 clean tab(用 result.fileContents 免一次 readTextFile)
  //  - 触发 WorkspaceSearchPanel 重跑搜索
  async function onWorkspaceSearchApplyReplace(payload: {
    hits: WorkspaceSearchHit[]
    replacement: string
    scope: 'one' | 'all'
  }) {
    // snapshot 替换开始瞬间的 dirty tab 集合 —— 遍历过程不再重读,避免
    // race("开始前是 clean、跑到一半用户敲了键变成 dirty")。从 documents Map
    // 直接读:tabs computed 只返轻量摘要,没有 currentFilePath / content 字段。
    // dirty 是 derived(content !== lastSavedContent),在 store 内是 computed,
    // 在 DocState 数据结构上等价于此表达式。
    const dirtyPaths = new Set(
      [...documentStore.documents.values()]
        .filter(d => d.content !== d.lastSavedContent && d.currentFilePath)
        .map(d => d.currentFilePath as string),
    )
    // 替换的 query / options 从第一条 hit 拿 —— panel 在同一次搜索结果内点替换,
    // 所有 hit 共享 query / options(由 panel 的 runSearch 一致传入 searchWorkspaceMarkdown)。
    const first = payload.hits[0]
    if (!first) return
    const plan: ReplacePlan = {
      query: first.query,
      options: first.options,
      replacement: payload.replacement,
    }
    const result = await applyWorkspaceReplace(payload.hits, plan, dirtyPaths)

    // 同步打开中的 clean tab:写盘已完成,这里把 lastSavedContent + content 同步,
    // 让编辑器(PM/CM6)看到新内容。重置 dirty 基线,draft 也跟着清掉。
    for (const fullPath of result.changedFiles) {
      const newContent = result.fileContents.get(fullPath)
      if (!newContent) continue
      // 同 path 可能有多个 tab(中键 / openPathInNewTab),content 相同,
      // 只对第一个执行 loadContentInto 即可:loadContentInto 同步 content +
      // lastSavedContent + 重建 watch —— 其他 tab 重新激活时通过
      // documentStore 的 readTextOf fallback 拿到 disk 新内容。
      const d = [...documentStore.documents.values()].find(x => x.currentFilePath === fullPath)
      if (d) documentStore.loadContentInto(d, newContent, fullPath, false)
    }

    // 状态文案 + 触发 panel 重跑搜索
    workspaceSearchReplaceStatus.value = formatReplaceStatus(result)
    workspaceSearchRerunToken.value++

    // Toast 通知:即使用户已切离搜索面板也能看到替换结果
    const summary = formatReplaceStatus(result)
    if (result.failedFiles.length) {
      notify.warning(summary)
    }
    else if (result.replacedCount > 0) {
      notify.success(summary)
    }

    // 失败明细:进度回调里塞"读了/写了什么文件失败"信息(已经入 result,这里 console 留痕)
    if (result.failedFiles.length) {
      console.warn('[WorkspaceSearch] 替换部分失败:', result.failedFiles)
    }
  }

  function formatReplaceStatus(result: { replacedCount: number, skippedFiles: string[], failedFiles: { fullPath: string }[] }): string {
    const parts: string[] = []
    if (result.replacedCount) parts.push(`已替换 ${result.replacedCount} 处`)
    if (result.skippedFiles.length) parts.push(`${result.skippedFiles.length} 个文件因有未保存修改被跳过`)
    if (result.failedFiles.length) parts.push(`${result.failedFiles.length} 个文件读写失败`)
    return parts.length ? parts.join('，') : '替换完成'
  }

  return {
    workspaceSearchInitialQuery,
    workspaceSearchScopeDir,
    workspaceSearchReplaceStatus,
    workspaceSearchRerunToken,
    openWorkspaceSearch,
    openGlobalSearchFromFind,
    openWorkspaceSearchResult,
    onSearchInFolder,
    onWorkspaceSearchClearScope,
    onWorkspaceSearchApplyReplace,
  }
}
