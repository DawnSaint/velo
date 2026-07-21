// 统一命令面板项(v0.6.2)
//
// 合并原 Ctrl+P 查找文件 + Ctrl+Shift+P 命令面板:单一浮层,首字符分发模式
// ('' = file,'>' = command;后续 @ / # / : 各自提交接入)。无工作区时 Ctrl+P
// 仍静默(对齐原 ROADMAP 问答约定),Ctrl+Shift+P 命令面板在无工作区时仍可开
// (workspace 类命令 disabled 保留可见)。

import { computed, type ComputedRef, type Ref } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useExportStore } from '@/stores/export'
import { useWorkspaceStore } from '@/stores/workspace'
import { useRecentFilesStore } from '@/stores/recentFiles'
import type { CommandPaletteItem } from '@/utils/commandPalette'
import type { SidebarTab } from '@/stores/persistence'
import { basenameOfPath, normalizeDisplayPath } from '@/utils/statusPath'

export function useCommandPaletteItems(opts: {
  tauri: boolean
  isFullscreen: Ref<boolean>
  isAlwaysOnTop: Ref<boolean>
  focusMode: Ref<boolean>
  typewriterMode: Ref<boolean>
  createNewAppWindow: () => void
  toggleFullscreen: () => void
  toggleAlwaysOnTop: () => void
  toggleFocusMode: () => void
  toggleTypewriterMode: () => void
  openFind: () => void
  openReplace: () => void
  showSettingsPanel: () => void
  openFolderAsWorkspace: () => void
  openQuickOpen: () => void
  openWorkspaceSearch: () => void
  showSidebarTab: (tab: SidebarTab) => void
  openRecentFile: (path: string) => void | Promise<unknown>
}): ComputedRef<CommandPaletteItem[]> {
  const documentStore = useDocumentStore()
  const exportStore = useExportStore()
  const workspaceStore = useWorkspaceStore()
  const recentFilesStore = useRecentFilesStore()

  return computed<CommandPaletteItem[]>(() => {
    const needWorkspace = !workspaceStore.activeRoot
    const items: CommandPaletteItem[] = [
      {
        id: 'file.new',
        title: '新建文件',
        subtitle: '创建一份未保存的新 Markdown 文档',
        shortcut: 'Ctrl+N',
        group: 'app',
        keywords: ['new file', 'new document', 'markdown'],
        run: () => documentStore.newDoc(),
      },
      ...(opts.tauri ? [{
        id: 'window.new',
        title: '新窗口',
        subtitle: '打开一个独立的 Velo 窗口',
        shortcut: 'Ctrl+Shift+N',
        group: 'app' as const,
        keywords: ['new window'],
        run: () => opts.createNewAppWindow(),
      }] : []),
      ...(opts.tauri ? [{
        id: 'window.fullscreen',
        title: opts.isFullscreen.value ? '退出全屏' : '全屏模式',
        subtitle: '切换窗口全屏',
        shortcut: 'F11',
        group: 'app' as const,
        keywords: ['fullscreen', '全屏'],
        run: () => opts.toggleFullscreen(),
      }] : []),
      ...(opts.tauri ? [{
        id: 'window.alwaysOnTop',
        title: opts.isAlwaysOnTop.value ? '取消窗口最前' : '保持窗口最前',
        subtitle: '窗口浮在所有普通窗口之上',
        group: 'app' as const,
        keywords: ['always on top', 'pin', '置顶', '最前'],
        run: () => opts.toggleAlwaysOnTop(),
      }] : []),
      {
        id: 'editor.focusMode',
        title: opts.focusMode.value ? '退出专注模式' : '专注模式',
        subtitle: '当前段落外内容降透明度',
        shortcut: 'F8',
        group: 'app',
        keywords: ['focus mode', '专注', 'focus'],
        run: () => opts.toggleFocusMode(),
      },
      {
        id: 'editor.typewriterMode',
        title: opts.typewriterMode.value ? '退出打字机模式' : '打字机模式',
        subtitle: '光标锁定在视口中线',
        shortcut: 'F9',
        group: 'app',
        keywords: ['typewriter mode', '打字机', 'typewriter', '锁屏'],
        run: () => opts.toggleTypewriterMode(),
      },
      {
        id: 'file.open',
        title: '打开文件',
        subtitle: '从磁盘选择一个 Markdown 文件',
        shortcut: 'Ctrl+O',
        group: 'app',
        keywords: ['open file'],
        run: () => documentStore.open(),
      },
      {
        id: 'file.save',
        title: '保存',
        subtitle: documentStore.currentFilePath ? normalizeDisplayPath(documentStore.currentFilePath) : '未命名文件会进入另存为',
        shortcut: 'Ctrl+S',
        group: 'app',
        keywords: ['save file'],
        run: () => documentStore.save(),
      },
      {
        id: 'file.saveAs',
        title: '另存为',
        subtitle: '选择新位置保存当前文档',
        shortcut: 'Ctrl+Shift+S',
        group: 'app',
        keywords: ['save as'],
        run: () => documentStore.saveAs(),
      },
      {
        id: 'file.export',
        title: exportStore.exporting ? '导出中…' : '导出',
        subtitle: '导出为 HTML 或 PDF',
        shortcut: 'Ctrl+Shift+E',
        group: 'app',
        keywords: ['export', 'html', 'pdf'],
        disabled: exportStore.exporting,
        disabledReason: '导出中…',
        run: () => exportStore.exportDocument(),
      },
      {
        id: 'edit.find',
        title: '查找',
        subtitle: '在当前文档中查找',
        shortcut: 'Ctrl+F',
        group: 'app',
        keywords: ['find', 'search current file'],
        run: () => opts.openFind(),
      },
      {
        id: 'edit.replace',
        title: '替换',
        subtitle: '在当前文档中查找并替换',
        shortcut: 'Ctrl+H',
        group: 'app',
        keywords: ['replace'],
        run: () => opts.openReplace(),
      },
      {
        id: 'editor.toggleSource',
        title: documentStore.sourceMode ? '切换到所见即所得' : '切换源码模式',
        subtitle: documentStore.sourceMode ? '返回 ProseMirror 所见即所得编辑器' : '使用源码模式编辑 Markdown',
        shortcut: 'Ctrl+`',
        group: 'app',
        keywords: ['source mode', 'wysiwyg', 'markdown source'],
        run: () => documentStore.toggleSourceMode(),
      },
      {
        id: 'settings.open',
        title: '打开设置',
        subtitle: '调整编辑器外观和行为',
        group: 'app',
        keywords: ['settings', 'preferences'],
        run: () => opts.showSettingsPanel(),
      },
      {
        id: 'workspace.openFolder',
        title: '打开文件夹作为工作区',
        subtitle: '选择一个目录作为当前工作区',
        group: 'workspace',
        keywords: ['open folder', 'workspace'],
        run: () => opts.openFolderAsWorkspace(),
      },
      {
        id: 'workspace.quickOpen',
        title: '快速打开文件',
        subtitle: '在当前工作区中按文件名查找 Markdown',
        shortcut: 'Ctrl+P',
        group: 'workspace',
        keywords: ['quick open', 'file search'],
        disabled: needWorkspace,
        disabledReason: '需要先打开工作区',
        run: () => opts.openQuickOpen(),
      },
      {
        id: 'workspace.search',
        title: '搜索工作区',
        subtitle: '全文搜索当前工作区中的 Markdown',
        shortcut: 'Ctrl+Shift+F',
        group: 'workspace',
        keywords: ['workspace search', 'search all files'],
        disabled: needWorkspace,
        disabledReason: '需要先打开工作区',
        run: () => opts.openWorkspaceSearch(),
      },
      {
        id: 'workspace.files',
        title: '显示工作区文件',
        subtitle: '打开左侧文件树',
        group: 'workspace',
        keywords: ['file tree', 'explorer', 'workspace files'],
        disabled: needWorkspace,
        disabledReason: '需要先打开工作区',
        run: () => opts.showSidebarTab('files'),
      },
      {
        id: 'workspace.outline',
        title: '显示大纲',
        subtitle: '打开当前文档的大纲视图',
        group: 'workspace',
        keywords: ['outline', 'headings'],
        run: () => opts.showSidebarTab('outline'),
      },
      {
        id: 'workspace.assets',
        title: '显示资产面板',
        subtitle: '查看当前文档的图片资产',
        group: 'workspace',
        keywords: ['assets', 'images', 'pictures'],
        run: () => opts.showSidebarTab('assets'),
      },
      {
        id: 'workspace.close',
        title: '关闭工作区',
        subtitle: workspaceStore.activeRoot ? normalizeDisplayPath(workspaceStore.activeRoot) : '当前没有打开的工作区',
        group: 'workspace',
        keywords: ['close workspace'],
        disabled: needWorkspace,
        disabledReason: '当前没有打开的工作区',
        run: () => workspaceStore.closeWorkspace(),
      },
    ]

    for (const entry of recentFilesStore.entries.slice(0, 12)) {
      const displayPath = normalizeDisplayPath(entry.path)
      items.push({
        id: `recent:${entry.path}`,
        title: `打开最近文件: ${basenameOfPath(entry.path)}`,
        subtitle: displayPath,
        group: 'recent',
        keywords: ['recent file', entry.path, displayPath],
        run: () => opts.openRecentFile(entry.path),
      })
    }

    return items
  })
}
