# Velo

基于 Tauri 2 / Vue 3 的桌面 Markdown 编辑器，底层用裸 [ProseMirror](https://prosemirror.net/) + [unified](https://unifiedjs.com/) (remark-parse / remark-stringify) 做 markdown 往返。

- WYSIWYG 编辑
- 文件系统
- OS 文件关联：双击 `.md` 直接打开
- 暗色模式
- 查找替换(Ctrl+F / Ctrl+H)

> 架构索引与模块入口 → 见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
> 当前 / 下一版本 To-Do → 见 [`docs/ROADMAP.md`](docs/ROADMAP.md)
> 版本变更日志 → 见 [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md)
> 重大架构决策与重构记录 → 见 [`docs/DECISIONS.md`](docs/DECISIONS.md)
> 测试目标与规约 → 见 [`docs/architecture/testing.md`](docs/architecture/testing.md)

---

## 安装 / 构建

```bash
npm install            # 安装依赖
npm run tauri:dev      # 桌面开发模式（推荐）
npm run tauri:build    # 生产构建（产出 .msi / .dmg / .deb / .app）
```

仅前端开发（不起 Tauri 进程）：

```bash
npm run dev            # Vite dev server (port 5273)
npm run build          # vue-tsc 类型检查 + 生产 bundle
npm run type-check     # 仅类型检查
```

---

## 快捷键

| 操作 | 快捷键 |
|------|--------|
| 新建文档 | Ctrl/Cmd + N |
| 打开文件 | Ctrl/Cmd + O |
| 保存 | Ctrl/Cmd + S |
| 另存为 | Ctrl/Cmd + Shift + S |
| 查找 / 替换 | Ctrl/Cmd + F / H |
| 撤销 / 重做 | Ctrl/Cmd + Z / Y |
| 加粗 | Ctrl/Cmd + B |
| 斜体 | Ctrl/Cmd + I |
| 删除线 | Ctrl/Cmd + Alt + X |
| Tab | 列表项内缩进 / 段落 / code-like 插 4 空格 |
| Shift + Tab | 列表项反缩进 |
| `$$` + Enter | 插入块级公式并进入编辑态 |

---

## 平台

- Windows 10/11
- macOS 11+
- Linux（GTK 桌面环境）

---

## License

待定
