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

## 下载安装

[![GitHub Release](https://img.shields.io/badge/下载-GitHub_Release-blue?logo=github)](https://github.com/DawnSaint/velo/releases/latest)

前往 [Releases 页面](https://github.com/DawnSaint/velo/releases/latest) 下载对应平台的安装包：

| 平台 | 下载文件 | 安装方式 |
|------|---------|--------|
| **Windows** x64 | `Velo_x.x.x_x64-setup.exe` | 双击运行安装程序 |
| **macOS** Apple Silicon | `Velo_x.x.x_aarch64.dmg` | 打开 dmg → 拖到 Applications |
| **macOS** Intel | `Velo_x.x.x_x64.dmg` | 打开 dmg → 拖到 Applications |
| **Linux** x64 (Debian 系) | `velo_x.x.x_amd64.deb` | `sudo dpkg -i velo_x.x.x_amd64.deb` |
| **Linux** x64 (通用) | `Velo_x.x.x_amd64.AppImage` | `chmod +x Velo_x.x.x_amd64.AppImage && ./Velo_x.x.x_amd64.AppImage` |

> macOS 首次打开如果提示「无法验证开发者」，前往 系统设置 → 隐私与安全性 → 点击「仍要打开」。
> Windows 首次运行如果被 SmartScreen 拦截，点击「更多信息」→「仍要运行」。

---

## 从源码构建

```bash
npm install            # 安装依赖
npm run tauri:dev      # 桌面开发模式（推荐）
npm run tauri:build    # 生产构建（产出 .exe / .dmg / .deb / .AppImage / .app）
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
