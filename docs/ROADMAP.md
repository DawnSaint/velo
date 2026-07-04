# Velo Roadmap

> Velo 的迭代规划：功能 backlog、工程化、已知问题统一在此追踪。每条 `- [ ]` 完成后改 `- [x]`；纳入某版本时在文件顶部新增 `## v<version>` 章节把条目移入，发版后整章删除，feat/fix 进 CHANGELOG、重大取舍进 DECISIONS。
>
> 重大架构取舍见 [DECISIONS.md](./DECISIONS.md)；用户可见变更见 [CHANGELOG.md](./CHANGELOG.md)；当前设计状态与踩坑记录见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 已知问题

> 已发布功能中待修复的缺陷 / 限制 / 平台缺口。

- [ ] **mark / link / image 源码编辑 session 期间切源码模式会看到转义串**
  - 进入源码编辑态的 trigger 事务挂了 `SKIP_CONTENT_EMIT` 不回写，但 session 内逐字键入的 tr 不挂该 meta（仅 commit 才需回写）→ `onChange` 回写 `toMarkdown` 把纯文本 `[..](..)` / `**..**` 转义成 `\[..\]\(..)` / `\*\*..\*\*`，污染 `documentStore.content`；此时切源码模式读到转义串，切回所见即所得后 `fromMarkdown` 解析转义串只得纯文本，无法变回 link / mark。光标移出 commit 时恢复正常。
  - 修复方向：session 期间所有 tr 跳过回写、commit 时一次性同步。link / image / markSourceEdit 三者共有此限制。
- [ ] **Mac / Linux 文件夹右键菜单「在 Velo 中打开」未实现**（Windows 已支持）

## 功能规划

### 编辑器增强

- [x] WYSIWYG code_block 行号（可选开关）
- [ ] 表格增强（行列增删的浮层操作 / 单元格对齐 / 整表格拖拽）
- [ ] ``` 语法增加语言选择下拉框
- [ ] 语言选择器增加语言图标
- [ ] 段落拖拽重排（hover gutter 拽手）
- [x] 块级折叠（heading / list 折叠）—— code_block 折叠 v0.5.12 未做
- [ ] 打字机模式：光标锁屏中
- [ ] 全屏模式（F11）：隐藏顶栏 / 侧栏 / 状态栏，进入沉浸编辑；再次 F11 还原
- [ ] 专注模式：当前段落外内容降透明度（独立开关，可与全屏叠加）
- [x] 阅读模式：无法编辑

### 窗口与全局体验

- [ ] 保持窗口最前
- [ ] 系统托盘 + 快速捷径
- [ ] 设置面板、工具栏重做
- [ ] 左侧功能栏可自定义（排序、隐藏）
- [ ] 编辑器多标签：单窗口内同时打开多个 .md，标签条横排，关闭脏盘弹 confirm；标签状态走 `documentStore` 多实例化（`documents: Map<id, DocState>` + `activeId`，`currentFilePath` / `content` / `lastSavedContent` 等下沉到 DocState）
- [ ] 标签持久化到 `velo-workspaces.json` 的 per-workspace `openTabs: string[]`，恢复工作区时重开上次的标签集
- [ ] 文件树↔标签联动：点击树节点优先复用已开标签，不重复打开；中键点击 = 新标签打开

### 视觉与个性化

- [ ] 增加跟随系统深浅色
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
- [ ] 导出 PDF 分页预览
- [ ] 命令面板按照 VSCode “多模式输入框”升级
  - `>` 是命令模式
  - 无前缀是文件模式
  - @ 是符号
  - `#` 是 workspace symbol
  - : 是行号

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

## 工程化

### 发版流程自动化（release-please）

Tier 1 已落地（preversion/postversion hook + Conventional Commits + 去 `-f`），见 CLAUDE.md「版本发布」节。目标：发版决策、CHANGELOG 生成、tag 创建全自动化；人工只做 review + merge。

**为什么是 release-please**：
- 单 package + 桌面 app 形态匹配（changesets 是 monorepo 取向、semantic-release 太激进、standard-version 已废弃）
- 基于 Conventional Commits 自动推 semver（feat → minor / fix → patch / `BREAKING CHANGE` → major）
- PR 驱动：bot 维护一个长期存在的 release PR，merge 即发版，不 merge 就继续攒；保留人工节奏把控
- CHANGELOG 按 Keep a Changelog 格式自动分组（Added / Changed / Fixed / ...）

**落地步骤**：
1. 装 `googleapis/release-please-action` workflow
2. 配 `release-please-config.json`：
   - `release-type: node`
   - `extra-files`: `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` 挂上（让 release-please 直接 bump，省掉 `sync-tauri-version.mjs` 在 CI 流程里的位置）
   - `changelog-sections` 按 Keep a Changelog 配置 type → 分组映射
3. 配 `.release-please-manifest.json` 记当前版本起点（`0.5.x`）
4. CLAUDE.md 同步：
   - 「版本发布」改为「review release-please PR → merge」
   - 「文档同步规则」里 CHANGELOG 一节标注：发版时自动生成，平时不要手写零散追加；保留 ROADMAP 整章删除 / DECISIONS 写入的同步要求
5. 把 `scripts/sync-tauri-version.mjs` 的角色降级为本地辅助，CI 上由 release-please 直接改文件

**风险点 / 注意**：
- release-please 对 `release-as` footer 的支持可用来做"强制版本号"逃生口
- 首次接入需要 squash merge 策略统一，避免 merge commit 污染 conventional commits 解析
- Tauri 的版本号在 3 处（`package.json` / `Cargo.toml` / `tauri.conf.json`），都要在 `extra-files` 里列上，漏了会发版后版本不一致

### CI 跨平台发布流水线（首次对外分发前必须做）

**目标**：tag push 触发 GitHub Actions 跨平台构建 + 自动创建 GitHub Release + attach 安装包。

Tauri 桌面应用的核心交付物是平台二进制，靠本地一次构建发布是反模式（缺平台、缺签名、易污染、无审计）。

**落地步骤**：
1. `.github/workflows/release.yml`：
   - 触发：`push: tags: ['v*']`（与 release-please 衔接，merge release PR → 自动打 tag → 触发该 workflow）
   - matrix：`windows-latest` / `macos-latest` / `macos-14`(arm64) / `ubuntu-22.04`
   - 用 `tauri-apps/tauri-action@v0`，配置 `tagName: v__VERSION__` / `releaseName: 'Velo v__VERSION__'`
   - 产物：Windows `.msi` + `.exe`、macOS `.dmg` (x64 + arm64)、Linux `.AppImage` + `.deb`
2. 签名（可选但推荐）：
   - Windows: code signing certificate（avoid SmartScreen 警告），证书走 GitHub Secrets
   - macOS: Apple Developer ID + notarization（避免 Gatekeeper 拦截），需要 `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` secrets
   - Linux 通常不需要
3. 更新通道（可选）：
   - Tauri Updater plugin + `latest.json` 上传到 GitHub Release / S3 / 自有服务器
   - 配 `tauri.conf.json` 的 `updater.endpoints` + 公钥
4. CHANGELOG 自动注入 Release body：release-please 已生成的 CHANGELOG 片段直接传给 `tauri-action` 的 `releaseBody`
5. 首次跑通后在 README 加 download badge / install 说明

**风险点 / 注意**：
- macOS arm64 build runner 时长收费较高，按需开
- Tauri build 在 CI 第一次跑会装 rust toolchain + 依赖，注意 cache `~/.cargo` 和 `src-tauri/target`，否则单次 build 20+ min
- 签名密钥泄漏风险高，secrets 必须 environment-scoped + required reviewers
- Apple notarization 异步，CI job 要等回执，超时设到 30+ min
