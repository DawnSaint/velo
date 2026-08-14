// 统一命令面板项(v0.6.2)
//
// 合并原 Ctrl+P 查找文件 + Ctrl+Shift+P 命令面板:单一浮层,首字符分发模式
// ('' = file,'>' = command;@ 标题跳转,: 行号跳转 已接入;# 待接入)。无工作区时 Ctrl+P
// 仍静默(对齐原 ROADMAP 问答约定),Ctrl+Shift+P 命令面板在无工作区时仍可开
// (workspace 类命令 disabled 保留可见)。

import { computed, type ComputedRef, type Ref } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useExportStore } from '@/stores/export'
import { useWorkspaceStore } from '@/stores/workspace'
import { useRecentFilesStore } from '@/stores/recentFiles'
import type { CommandPaletteItem } from '@/utils/commandPalette'
import { useEditorStore } from '@/stores/editor'
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
  openVersionHistory: () => void
  showSettingsPanel: () => void
  openFolderAsWorkspace: () => void
  openQuickOpen: () => void
  openWorkspaceSearch: () => void
  showSidebarTab: (tab: SidebarTab) => void
  openRecentFile: (path: string) => void | Promise<unknown>
  formatCJK: () => void
}): ComputedRef<CommandPaletteItem[]> {
  const documentStore = useDocumentStore()
  const exportStore = useExportStore()
  const workspaceStore = useWorkspaceStore()
  const recentFilesStore = useRecentFilesStore()
  const editorStore = useEditorStore()

  return computed<CommandPaletteItem[]>(() => {
    const needWorkspace = !workspaceStore.activeRoot
    const hasDoc = !!documentStore.activeId
    const items: CommandPaletteItem[] = [
      {
        id: 'file.new',
        title: '新建文件',
        shortcut: 'Ctrl+N',
        group: 'app',
        keywords: ['new file', 'new document', 'markdown'],
        run: () => documentStore.newDoc(),
      },
      ...(opts.tauri ? [{
        id: 'window.new',
        title: '新窗口',
        shortcut: 'Ctrl+Shift+N',
        group: 'app' as const,
        keywords: ['new window'],
        run: () => opts.createNewAppWindow(),
      }] : []),
      ...(opts.tauri ? [{
        id: 'window.fullscreen',
        title: opts.isFullscreen.value ? '退出全屏' : '全屏模式',
        shortcut: 'F11',
        group: 'app' as const,
        keywords: ['fullscreen', '全屏'],
        run: () => opts.toggleFullscreen(),
      }] : []),
      ...(opts.tauri ? [{
        id: 'window.alwaysOnTop',
        title: opts.isAlwaysOnTop.value ? '取消窗口最前' : '保持窗口最前',
        group: 'app' as const,
        keywords: ['always on top', 'pin', '置顶', '最前'],
        run: () => opts.toggleAlwaysOnTop(),
      }] : []),
      {
        id: 'editor.focusMode',
        title: opts.focusMode.value ? '退出专注模式' : '专注模式',
        shortcut: 'F8',
        group: 'app',
        keywords: ['focus mode', '专注', 'focus'],
        run: () => opts.toggleFocusMode(),
      },
      {
        id: 'editor.typewriterMode',
        title: opts.typewriterMode.value ? '退出打字机模式' : '打字机模式',
        shortcut: 'F9',
        group: 'app',
        keywords: ['typewriter mode', '打字机', 'typewriter', '锁屏'],
        run: () => opts.toggleTypewriterMode(),
      },
      {
        id: 'file.open',
        title: '打开文件',
        shortcut: 'Ctrl+O',
        group: 'app',
        keywords: ['open file'],
        run: () => documentStore.open(),
      },
      {
        id: 'file.save',
        title: '保存',
        shortcut: 'Ctrl+S',
        group: 'app',
        keywords: ['save file'],
        hidden: !hasDoc,
        run: () => documentStore.save(),
      },
      {
        id: 'file.saveAs',
        title: '另存为',
        shortcut: 'Ctrl+Shift+S',
        group: 'app',
        keywords: ['save as'],
        hidden: !hasDoc,
        run: () => documentStore.saveAs(),
      },
      {
        id: 'file.versionHistory',
        title: '浏览版本历史',
        group: 'app',
        keywords: ['version', 'history', 'timeline', 'snapshot', '版本', '历史', '时间线'],
        disabled: !documentStore.currentFilePath,
        disabledReason: '需要先保存文件',
        hidden: !hasDoc,
        run: () => opts.openVersionHistory(),
      },
      {
        id: 'file.export',
        title: exportStore.exporting ? '导出中…' : '导出',
        shortcut: 'Ctrl+Shift+E',
        group: 'app',
        keywords: ['export', 'html', 'pdf'],
        disabled: exportStore.exporting,
        disabledReason: '导出中…',
        hidden: !hasDoc,
        run: () => exportStore.exportDocument(),
      },
      {
        id: 'edit.find',
        title: '查找',
        shortcut: 'Ctrl+F',
        group: 'app',
        keywords: ['find', 'search current file'],
        hidden: !hasDoc,
        run: () => opts.openFind(),
      },
      {
        id: 'edit.replace',
        title: '替换',
        shortcut: 'Ctrl+H',
        group: 'app',
        keywords: ['replace'],
        hidden: !hasDoc,
        run: () => opts.openReplace(),
      },
      {
        id: 'editor.toggleSource',
        title: documentStore.sourceMode ? '切换到所见即所得' : '切换源码模式',
        shortcut: 'Ctrl+`',
        group: 'app',
        keywords: ['source mode', 'wysiwyg', 'markdown source'],
        hidden: !hasDoc,
        run: () => documentStore.toggleSourceMode(),
      },
      {
        id: 'editor.readMode',
        title: documentStore.readOnly ? '退出阅读模式' : '阅读模式',
        shortcut: 'Ctrl+Shift+R',
        group: 'app',
        keywords: ['read mode', 'read only', '阅读', '只读'],
        hidden: !hasDoc,
        run: () => { documentStore.readOnly = !documentStore.readOnly },
      },
      {
        id: 'editor.toggleTheme',
        title: editorStore.darkMode ? '切换到浅色模式' : '切换到暗色模式',
        group: 'app',
        keywords: ['theme', 'dark', 'light', '暗色', '浅色', '主题', '深色', '夜间', '日间'],
        run: () => { editorStore.themeMode = editorStore.darkMode ? 'light' : 'dark' },
      },
      {
        id: 'editor.formatCJK',
        title: '格式化排版',
        shortcut: 'Ctrl+Shift+L',
        group: 'app',
        keywords: ['format', 'cjk', '排版', '格式化', '中英文', '间距', '全角', '标点', '引号', '空白', '中文'],
        hidden: !hasDoc,
        run: () => opts.formatCJK(),
      },
      {
        id: 'settings.open',
        title: '打开设置',
        shortcut: 'Ctrl+,',
        group: 'app',
        keywords: ['settings', 'preferences'],
        run: () => opts.showSettingsPanel(),
      },
      {
        id: 'workspace.openFolder',
        title: '打开文件夹作为工作区',
        group: 'workspace',
        keywords: ['open folder', 'workspace'],
        run: () => opts.openFolderAsWorkspace(),
      },
      {
        id: 'workspace.quickOpen',
        title: '快速打开文件',
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
        group: 'workspace',
        keywords: ['file tree', 'explorer', 'workspace files'],
        disabled: needWorkspace,
        disabledReason: '需要先打开工作区',
        run: () => opts.showSidebarTab('files'),
      },
      {
        id: 'workspace.outline',
        title: '显示大纲',
        group: 'workspace',
        keywords: ['outline', 'headings'],
        run: () => opts.showSidebarTab('outline'),
      },
      {
        id: 'workspace.assets',
        title: '显示资产面板',
        group: 'workspace',
        keywords: ['assets', 'images', 'pictures'],
        run: () => opts.showSidebarTab('assets'),
      },
      {
        id: 'workspace.close',
        title: '关闭工作区',
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
