# Velo E2E

WebdriverIO + tauri-driver 主链路 E2E。Windows only。

## 跑前自检

```bash
# 1. 装 tauri-driver (Rust)
cargo install tauri-driver --locked

# 2. 装与本机 Edge 匹配的 msedgedriver.exe
cargo install --git https://github.com/chippers/msedgedriver-tool
msedgedriver-tool                # 拉 msedgedriver.exe 到当前目录
# 把 msedgedriver.exe 放到 $PATH(或直接放在 ~/.cargo/bin)

# 3. 自检
where tauri-driver               # 应输出 ~/.cargo/bin/tauri-driver.exe
where msedgedriver               # 应输出 msedgedriver.exe 路径

# 4. 杀掉残留(避免单实例锁路由)
taskkill /F /IM velo.exe /T 2> nul

# 5. 跑
npm run test:e2e
```

`wdio.conf.ts::onPrepare` 会自动:① 平台守门(非 Windows exit 0) ② 杀残留 velo.exe
③ `npm run tauri:build:debug` 构建 `src-tauri/target/debug/velo.exe`(Cargo 增量,无变动秒级)。

## 主链路覆盖

`specs/workspace-crud.spec.ts`:

1. CLI 启动 + 临时工作区目录作为 root → FileTree 渲染根 row + seed.md
2. 右键根 → 新建文件 → 输入 `alpha` → Enter → `alpha.md` 出现
3. 点 alpha.md 打开 → 在编辑器输入文字 → Ctrl+S → 物理校验 fs 内容
4. 右键 → 重命名 → `beta` → Enter → `beta.md` 出现,`alpha.md` 消失
5. 右键 → 删除 → 系统 confirm 被 `__VELO_E2E_AUTO_CONFIRM__` 自动通过 → `beta.md` 消失

## 已知限制

- **Windows only** — `msedgedriver`/`WebView2` 依赖
- **不接 CI** — Windows runner 暂未配置
- **不并行** — `tauri-plugin-single-instance` 让多 session 互相路由,`maxInstances: 1` 是硬约束
- **systeme confirm 走前端 dev-only 守门**:`src/tauri/dialog.ts` 的 `confirm` 在 `import.meta.env.DEV` 且 `window.__VELO_E2E_AUTO_CONFIRM__ === true` 时直接 resolve `true`。release build 经 esbuild dead-code-eliminate,行为不变
