# Velo E2E

WebdriverIO + tauri-driver 主链路 E2E。Windows only。

> Canonical E2E 规则、WebView2/msedgedriver 兜底、`data-testid` 钩子、appData snapshot/restore 见 [`docs/architecture/testing.md`](../docs/architecture/testing.md)。本文件只保留本地跑法速查。

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

`wdio.conf.ts::onPrepare` 会自动：① 平台守门(非 Windows exit 0) ② 杀残留 `velo.exe` ③ `npm run tauri:build:debug` 构建 `src-tauri/target/debug/velo.exe`。

## 实拍场景

`specs/multi-window.spec.ts` 覆盖二次启动经 `tauri-plugin-single-instance` 路由 → 创建独立工作区窗口。新 / 重命名 / 删除的组件级行为由 `src/components/__tests__/FileTree.test.ts` vitest 覆盖,不重复走 E2E。

详细约束见 [`docs/architecture/testing.md`](../docs/architecture/testing.md)。
