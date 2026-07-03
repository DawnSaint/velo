
## KNOWN ISSUES

- **mark / link / image 源码编辑态期间切源代码模式会看到转义串**：进入编辑态的 trigger 事务挂了 `SKIP_CONTENT_EMIT` 不回写，但用户在 session 内键入修改源码时，每次键入 tr 不挂该 meta（commit 才需要回写）→ `onChange` 回写 `toMarkdown` 把纯文本 `[..](..)` / `**..**` 转义成 `\[..\]\(..)` / `\*\*..\*\*`，污染 `documentStore.content`。此时切源代码模式读到转义串，切回所见即所得后 `fromMarkdown` 解析转义串只得纯文本，无法变回 link / mark。光标移出 commit 时回写恢复正常。彻底修复需 session 期间所有 tr 跳过回写、commit 时一次性同步（待做）。link / image / markSourceEdit 三者共有此限制。




## DIFF
1. Mac 和 Linux 文件夹右键菜单在 Velo 中打开未实现


## 工程化 — 发版流程改造

Tier 1 已落地（preversion/postversion hook + Conventional Commits + 去 `-f`），见 CLAUDE.md「版本发布」节。

### Tier 2 — 引入 release-please 自动化（推荐目标态）

**目标**：发版决策、CHANGELOG 生成、tag 创建全自动化；人工只做 review + merge。

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
   - 「文档同步规则」里 CHANGELOG 一节标注：发版时自动生成，平时不要手写零散追加；保留 ROADMAP 整章删除/DECISIONS 写入的同步要求
5. 把 `scripts/sync-tauri-version.mjs` 的角色降级为本地辅助，CI 上由 release-please 直接改文件

**风险点 / 注意**：
- release-please 对 `release-as` footer 的支持可用来做"强制版本号"逃生口
- 首次接入需要 squash merge 策略统一，避免 merge commit 污染 conventional commits 解析
- Tauri 的版本号在 3 处（`package.json` / `Cargo.toml` / `tauri.conf.json`），都要在 `extra-files` 里列上，漏了会发版后版本不一致

---

### Tier 3 — CI 跨平台发布流水线（首次对外分发前必须做）

**目标**：tag push 触发 GitHub Actions 跨平台构建 + 自动创建 GitHub Release + attach 安装包。

**Tauri 桌面应用的核心交付物是平台二进制**，靠本地一次构建发布是反模式（缺平台、缺签名、易污染、无审计）。

**落地步骤**：
1. `.github/workflows/release.yml`：
   - 触发：`push: tags: ['v*']`（与 Tier 2 release-please 衔接，merge release PR → 自动打 tag → 触发该 workflow）
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
