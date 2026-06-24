// 集中 data-testid 常量。spec 不写裸字符串,改 testid 钩子时一处收口。
//
// 钩子加在:
//   - src/components/Sidebar/FileTree.vue:工作区根 row(workspace-root)、
//     文件行(file-row-${name})、行内 input(inline-input)
//   - src/components/Sidebar/FileTreeContextMenu.vue:菜单项 ctx-{action}
//   - src/components/ProseMirrorEditor/EditorInner.vue:PM 挂载容器(pm-editor)

export const sel = {
  workspaceRoot: '[data-testid="workspace-root"]',
  fileRow: (name: string) => `[data-testid="file-row-${name}"]`,
  inlineInput: '[data-testid="inline-input"]',
  pmEditor: '[data-testid="pm-editor"]',
  ctx: {
    newFile: '[data-testid="ctx-new-file"]',
    newDir: '[data-testid="ctx-new-dir"]',
    rename: '[data-testid="ctx-rename"]',
    delete: '[data-testid="ctx-delete"]',
    reveal: '[data-testid="ctx-reveal"]',
    openInEditor: '[data-testid="ctx-open-in-editor"]',
    openAsWorkspace: '[data-testid="ctx-open-as-workspace"]',
  },
}
