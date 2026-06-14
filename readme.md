# Velo

基于 Tauri 2 / Vue 3 的桌面 Markdown 编辑器，底层用裸 [ProseMirror](https://prosemirror.net/) + [unified](https://unifiedjs.com/) (remark-parse / remark-stringify) 做 markdown 往返。

- WYSIWYG 编辑，行内编辑 LaTeX 公式(`$...$` / `$$...$$`)与 Mermaid 图表
- 原生文件系统：打开 / 保存 / 自动保存 / 失焦保存
- 外部文件改动自动同步(`tauri-plugin-fs` 的 `watch` feature + 窗口聚焦 fallback)
- OS 文件关联：双击 `.md` 直接打开
- 单实例：再次启动转发参数给现有窗口
- 暗色模式 + 原生 title bar 联动
- 大纲面板带 scroll-spy + 折叠状态记忆
- 任务列表 checkbox 在编辑器内点选切换
- 脚注:渲染 + 点击跳转 + 末尾回链
- 警告框(`> [!NOTE]` 等 5 种 GitHub 风格)
- 透传 HTML 渲染(`<kbd>` / `<sub>` / `<sup>` / `<mark>` / `<details>` 等;用 DOMPurify 清洗)
- 查找替换(Ctrl+F / Ctrl+H),支持大小写 / 全词 / 正则三档

> 技术细节、目录结构、ProseMirror 插件链、架构决策 → 见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
> 版本迭代记录 → 见 [`docs/ROADMAP.md`](docs/ROADMAP.md)
> 测试策略 → 见 [`docs/TESTING.md`](docs/TESTING.md)

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

## 设置

右上角 ⚙ 打开设置面板：

- 字号 / 主色 / 字体 / 代码块主题
- 暗色模式
- 自动保存（1 秒防抖）
- 失焦时保存

---

## 平台

- Windows 10/11
- macOS 11+
- Linux（GTK 桌面环境）

---

## License

待定
