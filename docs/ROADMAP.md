# Velo Roadmap

> 规划后续版本的迭代方向


## v0.5.x — 工作区与文件管理

**主线**：从"单文件编辑器"跃迁到"目录级工作区"。

### 0.5.7 - 便捷操作


**feat**

- [x] "打开最近文件"功能 + `velo-recent-files.json`（顶栏可达；命令面板入口随下一项实现）
- [ ] 命令面板（`Ctrl+Shift+P`）：聚合所有快捷键命令 + 工作区操作 + 最近文件，沿用 §查找文件 的 fuzzy 匹配


## 未规划入具体版本的功能

### 编辑器增强

- [ ] WYSIWYG code_block 行号（可选开关）
- [ ] 表格增强（行列增删的浮层操作 / 单元格对齐 / 整表格拖拽）
- [ ] ``` 语法增加语言选择下拉框
- [ ] 语言选择器增加语言图标
- [ ] 段落拖拽重排（hover gutter 拽手）
- [ ] 块级折叠（heading / list / code_block 折叠）
- [ ] 打字机模式：光标锁屏中
- [ ] 全屏模式（F11）：隐藏顶栏 / 侧栏 / 状态栏，进入沉浸编辑；再次 F11 还原
- [ ] 专注模式：当前段落外内容降透明度（独立开关，可与全屏叠加）
- [ ] 阅读模式：无法编辑

### 窗口与全局体验

- [ ] 保持窗口最前
- [ ] 系统托盘 + 快速捷径
- [ ] 设置面板、工具栏重做
- [ ] 左侧功能栏可自定义（排序、隐藏）

- [ ] 编辑器多标签：单窗口内同时打开多个 .md，标签条横排，关闭脏盘弹 confirm；标签状态走 `documentStore` 多实例化（`documents: Map<id, DocState>` + `activeId`，`currentFilePath` / `content` / `lastSavedContent` 等下沉到 DocState）
- [ ] 标签持久化到 `velo-workspaces.json` 的 per-workspace `openTabs: string[]`，恢复工作区时重开上次的标签集
- [ ] 文件树↔标签联动：点击树节点优先复用已开标签，不重复打开；中键点击 = 新标签打开

### 视觉与个性化

- [ ] 主题市场（自定义颜色方案 / 字号规范 / 段落间距整套打包）
- [ ] 多种自带主题预设（除当前两套外）
- [ ] 字体配置 UI 暴露（`editorStore.fontFamily` 已有 store 字段，仅设置面板未暴露 ——补一个字体族选择器）

### 功能性

- [ ] 功能更新弹窗（版本升级后首启展示 CHANGELOG 摘要）
- [ ] Git 集成（侧栏显示 git status / commit / diff）
- [ ] 导出更多格式（DOCX / EPUB）
- [ ] 资产面板（侧边栏第 3 个 tab）：扫描当前文档所有 `image` / `link` 节点，列出本地路径 + 外链分组；点击条目把光标定位到引用位置（PM `view.dispatch + scrollIntoView`）；引用计数为 0 的本地资产标灰（孤儿候选）
- [ ] 资产"重新组织到 assets/" 入口：右键资产条目 → 复制 / 移动到工作区 `assets/<docName>/`，编辑器内引用路径同步重写（依赖 `fs:allow-copy`，本版本补 capability）
- [ ] 书签




### 双链

把工作区里的 .md 文件相互关联起来，让 Velo 从"批量编辑 .md"上升到"知识库"。

**feat**

- [ ] `[[wikilink]]` 语法：schema + remark 插件 + syntax/inline 注册 + NodeView（hover 显示目标文件预览，点击跳转）
- [ ] 工作区索引：`workspaceStore` 维护 `Map<filePath, { headings, outgoingLinks }>`，文件变动时增量更新（依赖 v0.5.0 的工作区根 watch）
- [ ] 损坏链接检测：索引时标记指向不存在文件的 `[[link]]`，编辑器内 decoration 标红 + 提示
- [ ] 反向链接：当前文档被工作区内哪些 .md 引用，分组展示 + 上下文片段

**test**

- [ ] `[[link]]` 语法 round-trip 测试（按新增语法 checklist 第 8 项）
- [ ] 工作区索引增量更新逻辑单元测试（不走 PM，纯函数测试）