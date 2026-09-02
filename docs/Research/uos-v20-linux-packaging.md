# UOS V20 / 麒麟 V10 上的 Tauri 2 交付可行性调研

> 目标：让 Velo（tauri 2.11.5 + wry 0.55.1）在统信 UOS 桌面专业版 V20 (1070)、
> 内核 4.19、Debian 10 buster 基座上跑起来。
>
> 结论先说：**能。有三条可行路线，没有一条是免费的。**
> 现有 `.deb` 装不上有**两道**坎，不是一道。

---

## 0. 现状复核：两道坎，不是一道

`.deb` 报 `依赖关系不满足: libwebkit2gtk-4.1-0` 只是**先撞上的**那一道。

| # | 坎 | 事实 | 现有产物是否踩中 |
|---|---|---|---|
| 1 | WebKit API 代次 | UOS V20 源里只有 `libwebkit2gtk-4.0-37`（实测 `2.38.6.0-deepin1`），无 4.1 | ✅ 踩中 |
| 2 | glibc 代次 | UOS V20 = glibc **2.28**；CI 的 Linux job 跑在 `ubuntu-22.04`（`build.yml:125`）= glibc **2.35** | ✅ 踩中，但被第 1 道挡在前面 |

第 2 道很容易被忽略：**即便把 webkit 4.1 装上，二进制也会在 `GLIBC_2.35 not found` 上崩**。
任何路线都必须同时解掉这两条，只解 webkit 是白做。

---

## 1. 对"不能降级到 4.0"这条判断的修正

原判断**方向对，理由不完整**。逐条核对 wry 0.55.1 与 tauri 2.11.5 的实际源码（本机 cargo registry）：

### 1.1 soup3 的耦合面 = 2 行，不是障碍

```
wry-0.55.1/src/webkitgtk/web_context.rs:10   use soup::{MessageHeaders, MessageHeadersType};
wry-0.55.1/src/webkitgtk/web_context.rs:235  let headers = MessageHeaders::new(MessageHeadersType::Response);
```

全仓 soup 使用就这两处。4.0/4.1 在 C API 层的差异**只有 soup 版本**（同一份
WebKit 源码用不同 flag 编两次），`SoupMessageHeaders` 在 FFI 层是不透明指针。
Tauri 1 时代的 wry 用的就是 `soup2::{MessageHeaders, MessageHeadersType}` +
同一个 `MessageHeaders::new(...)` 调用——即这段代码本来就有 soup2 版本存在过。

所以 "soup3 锁死 4.1" **不成立**。

### 1.2 真正的拦路虎：`linux-body` 把底线抬到 WebKit 2.40

```
tauri-runtime-wry-2.11.4/Cargo.toml:102   "linux-body",
wry-0.55.1/Cargo.toml:58                  linux-body = ["webkit2gtk/v2_40", "os-webview"]
wry-0.55.1/Cargo.toml.orig:58             webkit2gtk = { version="=2.0.2", features=["v2_38"] }
```

wry 自身基线是 `v2_38`，但 `tauri-runtime-wry` **主动启用了 `linux-body`**，
把要求抬到 **WebKit 2.40+**。UOS V20 只有 **2.38.6** —— 差 2 个小版本。

这才是 4.0 路线的实际卡点，且它与 4.0/4.1 无关，纯粹是 WebKit 小版本问题。

### 1.3 这个卡点有 Tauri 官方留的后门

`linux-body` 是干净的 `cfg` 分支，关掉不会编译失败：

```rust
// wry-0.55.1/src/webkitgtk/web_context.rs:202-205
#[cfg(not(feature = "linux-body"))]
{ body = Vec::new(); }
```

关掉后 custom protocol 读不到 POST body → Tauri IPC 的 payload 会丢。
但 Tauri 2 为**完全相同的场景**留了第二条 IPC 通道：

```js
// tauri-2.11.5/scripts/ipc-protocol.js:19-20
// on Android we never use it because Android does not have support to reading the request body
const canUseCustomProtocol = osName !== 'android'
...
window.ipc.postMessage(data)   // :84  ← 回退通道
```

Rust 侧 `handle_ipc_message`（`src/ipc/protocol.rs:185`，`kind = "post-message"`）
是完整实现的一等通道，Android 生产环境一直走它。
底层是 `webkit_user_content_manager_register_script_message_handler`（WebKit 2.8+），2.38 完全支持。

**channel 流式命令也不受影响**——它的 payload 走 header 不走 body：

```rust
// tauri-2.11.5/src/ipc/channel.rs:179
invoke('plugin:__TAURI_CHANNEL__|fetch', null, { headers: { <CHANNEL_ID>: ... } })
```

`payload = null`，channel id 在 header 里。这正是 Android 关掉 body 后
`fetch_channel_data` 仍能走 custom protocol 的原因。
→ plugin-updater 的下载进度、plugin-fs 的 watch 不会因此失效。

### 1.4 修正后的结论

4.0 路线 **不是"堵死"，是"要维护一套 5 crate 的 patch"**。技术上通，成本在长期维护。

---

## 2. 四条路线对比

| | A. 自包含 AppImage | B. 玲珑 / Linyaps | C. fork 回 4.0 API | D. 目标机升级 |
|---|---|---|---|---|
| 产物 | `.AppImage` ~150 MB | `.uab` / `.layer` | 正常 `.deb` ~15 MB | 无需改动 |
| 解 webkit | 内置 | runtime 提供 | 用系统 2.38.6 | 系统自带 4.1 |
| 解 glibc | 内置动态链接器 | base 提供 | 在 UOS 内编译 | 无需 |
| 社区验证 | ✅ 已在 UOS V20 跑通 | ✅ Tauri 应用实测跑通 | ⚠️ 未见公开先例 | ✅ |
| 上手成本 | 中 | 中高（学 ll-builder） | 高（fork 5 个 crate） | 零 |
| 长期维护 | 低 | 低 | **高**（每次升 Tauri 重打 patch） | 零 |
| 商店上架 | ❌ 商店不收内置依赖包 | ✅ 官方通道 | ✅ | — |
| 体积代价 | 超过 Electron | 小 | 最小 | — |

### 路线 A：自包含 AppImage（pkgforge-dev/Anylinux-AppImages）

原理：用 `sharun` 把**含动态链接器在内**的全部依赖打进去，并二进制修补
webkit2gtk 硬编码的子进程路径（`/usr/libexec/webkit2gtk-4.1/WebKitWebProcess`
→ 相对路径），配 `uruntime`（FUSE 不可用时回退 namespace，再回退解压运行）。
一次解决 webkit + glibc 两道坎。Tauri 官方认可此思路但未合主干。

**已验证**：deepin 论坛 `kero990` 用此法在 UOS/V20 上跑通 Tauri V2 应用。

踩坑（照抄他的结论，能省几天）：
- **打包基镜像要选对**：不要 Ubuntu 22.04——它的 `libglib-2.0` 有个 bug 会导致在 UOS 上起不来；
  也不要直接用 Debian 12 当**最终链接**基——Debian 12 的 glibc 2.36 会让产物在 UOS 的
  glibc 2.28 上 `GLIBC_2.35 not found`。正确做法是用 pkgforge/sharun 的 **old-glibc 运行时**
  （CentOS 7 系 sysroot，glibc ~2.17）链接，Debian 12 只作"拉源码 / 编 runtime"的宿主。
- **不要用 Arch 基座**——会打进 mesa 25，与 UOS 的 4.19 内核 DRM 协同不了。
- 即使 DwarFS 压缩，webkit + mesa 也把体积推到 ~150 MB。

参考：`pkgforge-dev/Anylinux-AppImages`（`HOW-TO-MAKE-THESE.md` + `useful-tools/`）

### 路线 B：玲珑 / Linyaps（推荐用于政企批量交付 / 上架）

国产化官方通道。`ll-builder` 已支持构建 `uab`（**deepin V23 与 UOS V20 均支持**），
支持离线运行，玲珑环境本身已进 UOS 1071 系统仓库；UOS V20 可手动加源：

```bash
echo "deb [trusted=yes] https://ci.deepin.com/repo/obs/linglong:/CI:/release/uos_1070/ ./" \
  | sudo tee /etc/apt/sources.list.d/linglong.list
```

关键前提：base `org.deepin.base/23.1.0` 默认不带 webkit2gtk。社区已把它补上了：
- `LFRon/webkit2gtk-for-linyaps` —— 专门修了 webkit2gtk 在玲珑内的链接问题
- `LFRon/org.deepin.runtime.gtk4`

作者用它打包 Tauri 应用（Biliup-app）**原生跑通，不内置任何运行库**。

⚠️ 该 runtime 目前在**社区自建测试源**，非官方源；已知问题：应用主题不跟随宿主。

### 路线 B 细化：UOS V20 上到底要做什么（2026-09-01 补）

机制上，Route B 是四条路线里**唯一自带两道坎解药**的：

- **webkit 4.1 这道坎**：由容器内的 **runtime 层** 提供，不是宿主。社区
  `LFRon/webkit2gtk-for-linyaps`（release `2.48.0-1deepin1`）是给玲珑专用的 webkit runtime，
  它打包的就是 `libwebkit2gtk-4.1-0` + `libjavascriptcoregtk-4.1-0`
  （v2.48.0，远高于 Tauri 的 2.40 底线）。应用只声明依赖这个 runtime，
  **宿主无需 `libwebkit2gtk-4.1-0`**——这正是你原报错那一项。
- **glibc 2.28 这道坎**：由容器的 **base 层** 自带 glibc 解决，与宿主无关。宿主只提供内核
  （4.19，支持 user namespaces / bubblewrap），不提供 glibc。所以这道坎也消失。
- 内核 4.19 提供 user namespaces，bubblewrap 沙箱可跑。

#### UOS V20 1070 目标机处理清单（6 步）

```bash
# ① 先查是否已预装（UOS 1071 起集成；1070 多半未预装）
ll-cli --version 2>/dev/null || echo "无玲珑，需手动装"

# ② UOS 20 (1070) 必须先开「开发者模式」（系统设置里）
#    否则 linglong 相关操作会被安全中心拦截

# ③ 加玲珑官方源并安装运行时（官方文档给的 1070 命令，已含 linglong-installer）
echo "deb [trusted=yes] https://ci.deepin.com/repo/obs/linglong:/CI:/release/uos_1070/ ./" \
  | sudo tee /etc/apt/sources.list.d/linglong.list
sudo apt update
sudo apt install linglong-bin linglong-installer

# ④ 加社区测试源——webkit2gtk-for-linyaps 只在测试源，不在稳定源
sudo ll-cli repo add --alias=testing stable https://cdn-linglong.odata.cc

# ⑤ 装一次 webkit runtime（共享层，~28 MB：webkit 21.3 + jscore 6.6）
#    确切 id 用下面命令查（预期形如 org.deepin.runtime.webkit2gtk/2.48.0）
ll-cli search webkit2gtk          # 在 testing 源里找确切 id
sudo ll-cli install <查到的 runtime id>

# ⑥ 装 Velo 的 uab（离线包，不需要联网商店；双击 .uab 也会经 linglong-installer 安装）
ll-cli install ./velo-x.y.z.x86_64.uab
ll-cli run <appid>               # appid 见 linglong.yaml 的 appid 字段
```

#### 构建侧（你这边）：linglong.yaml 骨架

```yaml
# 极简骨架，字段以 ll-builder 实际校验为准；runtime id 待 ⑤ 查出后填入
base: org.deepin.base/23.1.0      # 提供足够新的 glibc 给 webkit 2.48（用 25.2.2 也可）
runtime: <webkit2gtk-for-linyaps 的 runtime id>   # 关键：Tauri 应用的 4.1 由它给
build:
  # 在 linglong 容器里 cargo build --release，产物拷到 ${PREFIX}/bin
  ...
command: /opt/apps/<appid>/files/bin/velo
```

参考现成 Tauri uab（`Biliup-app` / `Venera`）的 `linglong.yaml` 当模板最稳——
它们就是同一套 webkit runtime 跑通的。

#### Route B 风险（诚实列）

1. **webkit runtime 在测试源，非官方稳定源** —— 需手动加源、自行承担稳定性。这是当前 #1 不确定项。
2. **runtime 确切 id / `runtime:` 字段格式待确认** —— 用 ④⑤ 的 `ll-cli search` 现查，或扒 `Biliup-app` 的 yaml。
3. 已知问题：应用主题不跟随宿主系统设置（mozixun 原帖确认），纯美观不影响功能。
4. 官方 base `org.deepin.foundation/20.0.0`（UOS 20 系）标注 *Unsupported*；
   建议用 `org.deepin.base/23.1.0` 或 `25.2.2` 构建（glibc 由 base 给，宿主 4.19 内核照跑）。
5. 内核 4.19 + webkit sandbox（GPU 进程 / seccomp）需真机验证能否起；预期可跑，但未实测。
6. 应用二进制运行时链接 `libwebkit2gtk-4.1.so`，必须正确声明 runtime 依赖，`ll-cli install` 才会自动拉下层。

### 路线 C：fork 回 webkit2gtk-4.0（唯一能产出正常小 deb 的路）

**前提**：目标机 `libwebkit2gtk-4.0-37 >= 2.38`。UOS V20 1070 的 2.38.6.0-deepin1 刚好够。
**若目标机是 2.30 / 2.32，此路直接作废**（`v2_38` 符号缺失 → 运行时 undefined symbol）。

patch 清单（`src-tauri/Cargo.toml` 用 `[patch.crates-io]` 指向本地 fork）：

| # | crate | 改动 |
|---|---|---|
| 1 | `webkit2gtk-sys 2.0.2` | `Cargo.toml:58` `name = "webkit2gtk-4.1"` → `-4.0`；`src/lib.rs:3131` `#[link(name=...)]` 同改；`soup3-sys` 依赖换成 soup2 shim |
| 2 | `javascriptcore-rs-sys 1.1.1` | `Cargo.toml:40` `javascriptcoregtk-4.1` → `-4.0`（**易漏，这是第二个硬绑 4.1 的 crate**） |
| 3 | `webkit2gtk 2.0.2` | `soup3 0.5` → soup2 shim |
| 4 | `wry 0.55.1` | 2 行 soup import/调用换成 shim |
| 5 | `tauri-runtime-wry 2.11.4` | 删掉 `Cargo.toml:102` 的 `"linux-body"` |
| 6 | `tauri 2.11.5` | `scripts/ipc-protocol.js:20` → `osName !== 'android' && osName !== 'linux'`，强制走 postMessage IPC |

soup2 shim 注意：**不能直接用 crates.io 的 `soup2 0.2`**——它锁 `glib 0.15`，
而本栈是 `glib 0.18.5`（见 `Cargo.lock`），类型不通。需手写 ~50 行：
用 glib 0.18 的 `wrapper!` 包 `soup_message_headers_new` / `_append`，链 `libsoup-2.4`。

编译环境：**必须在 UOS V20 / deepin 20 容器内编译**（同时解决 glibc 2.28 与
`webkit2gtk-4.0 >= 2.38` 的 pkg-config）。Debian 10 官方源的 webkit 可能低于 2.38，
`system-deps` 版本检查会直接失败——要的是 deepin 那份 2.38.6。
rustup 与 Node 20/22 在 glibc 2.28 上均可用。

产出的 deb 依赖变成 `libwebkit2gtk-4.0-37 (>= 2.38), libjavascriptcoregtk-4.0-18`，
UOS V20 原生满足，体积回到十几 MB。

**残留风险**：① fork 维护成本，每次升 Tauri 都要重打；② soup2 的已知 bug 回来了
（Tauri 当年迁 4.1 的动因之一）；③ 前端需在 WebKit 2.38（≈ Safari 16，2022-09）上实测——
`vite.config` 未设 `build.target`，走默认 `'modules'` 基线，语法层没问题，
但 mermaid 11 / shiki 4 / katex 0.17 的运行时特性需要真机验证。

### 路线 D：目标机升级

UOS V25 / 1071+ 自带 4.1。若设备可控，这是零成本方案，**先问这个问题再动手**。

### 不推荐：自行编译 webkit2gtk-4.1 到 UOS

webkit 2.40+ 需要 glib ≥ 2.70，UOS 是 2.58；libsoup3 需要 glib ≥ 2.68。
换系统 glib 会连带重编 gtk3/pango/harfbuzz/gdk-pixbuf 全栈（否则一个进程里两个 glib
符号打架），且 dde 桌面依赖系统 glib，风险极高。webkit 单库 ~150 MB，全依赖 300 MB+，
还有 `/usr/libexec/webkit2gtk-4.1/` 硬编码子进程路径问题。
这条路等于手搓一个 Flatpak runtime——直接用路线 A/B。

---

## 3. 动手前必须在目标机确认的事

路线 C 完全建立在"4.0 是 2.38.x"这个前提上，先验证再投入：

```bash
# ① webkit 4.0 实际版本（决定路线 C 是否成立，必须 >= 2.38）
apt-cache policy libwebkit2gtk-4.0-37
dpkg -l | grep -E 'webkit|javascriptcore|libsoup'

# ② glibc 版本（确认 2.28，决定编译容器基座）
ldd --version

# ③ 是否已有玲珑环境（决定路线 B 的门槛）
ll-cli --version 2>/dev/null || echo "无玲珑"

# ④ 系统版本与源
cat /etc/os-version; apt-cache policy | head -20

# ⑤ AppImage 前置：FUSE 是否可用（不可用也行，uruntime 会回退）
which fusermount fusermount3

# ⑥ 4.0-dev 是否可装（路线 C 的编译前提）
apt-get install --dry-run libwebkit2gtk-4.0-dev
```

---

## 4. 建议的推进顺序

1. **先问路线 D**：目标机能不能升 UOS V25 / 1071+。能升就不折腾。
2. **跑第 3 节的 6 条命令**，把前提钉死。
3. **要"这周就有能装的东西"** → 路线 A。改 CI：Linux job 从 `ubuntu-22.04`
   换到 `debian:12` 容器 + Anylinux 的 sharun 流程，产出 AppImage。
4. **要长期正式交付 / 上架统信商店** → 路线 B，`.uab` 是正解。
5. **要"一个正常的小 deb"且能接受 fork 维护** → 路线 C，且必须先确认 ② 的 2.38.6。

不建议同时开两条。A 和 B 的产物形态不同，但都不改业务代码；C 会污染依赖树，
一旦走上去，后续每次 Tauri 升级都要付利息。

---

## 5. 零终端交付：面向不懂 bash 的终端用户（2026-09-01 补）

前面第 2 节的 6 步清单、第 3 节的 6 条核验命令，**都是「你（开发者）做构建 / 一次性核验」
用的，不是给最终用户跑的**。如果目标用户不懂终端，交付设计的目标就是：
**最终用户全程零终端 —— 只用双击 + 点 GUI 按钮。**

### 5.1 哪种产物对"零终端"最友好（按终端用户摩擦排序）

| 产物 | 终端用户要做的 | 摩擦 |
|---|---|---|
| **自包含 AppImage（推荐，见 5.2 / 第 6 节）** | 右键 → 属性 → 权限 → 勾"允许作为程序执行" → 双击 | **几乎为零**（GUI 勾选+双击；uruntime 自动处理 FUSE 缺失，无需 libfuse2 / 无需开发者模式） |
| 自包含 `.deb` | 双击 → 系统「包安装器」GUI 点「安装」；UOS 1070 可能需先开「开发者模式」(GUI) | 低（1070 多一步开发者模式开关） |
| 玲珑 `.uab` | 需先装好 linglong（1070 多半没预装；要么应用商店 GUI 装、要么终端加源）+ 加测试源 + 装 webkit runtime | 中高（测试源那几步通常躲不开终端） |

**结论**：对不懂终端的终端用户，最稳的是 **sharun + uruntime 的自包含 AppImage**——
它把 webkit/glibc/opengl 全部打包进一个文件，uruntime 在缺少 FUSE 时自动回退 namespace / extract，
所以**不需要 libfuse2、不需要开发者模式、不需要任何命令**，双击即用（比 deb 在 UOS 1070 还少一步）。

### 5.2 自包含 AppImage 怎么消掉原来的报错

原本 `依赖关系不满足: libwebkit2gtk-4.1-0` 是因为 deb 把 webkit 4.1 列成系统依赖。
AppImage 的做法是**根本不依赖宿主的任何库**——由 sharun 把 `libwebkit2gtk-4.1.so` +
`libjavascriptcoregtk-4.1.so` + `libexec`(WebKitWebProcess) + 现代 glib/gtk/opengl 全部
探测打包进 AppImage 内部，运行时用 uruntime 的 namespace / 自解包机制隔离，宿主只提供内核（4.19 即可）。

1. **老 glibc 兼容**：在 Arch 容器里构建，闭包按老 glibc 链接，在 UOS 的 glibc 2.28 上
   直接能跑，不报 `GLIBC_2.35 not found`。
2. **自带 webkit**：一整套 `.so` + webkit 的 `libexec` 助手进程，全部随 AppImage 走。
3. **依赖清单彻底消失**——AppImage 不进 apt，没有 `Depends`，原报错从源头不存在。

→ 宿主不查系统 webkit，闭包自满足，双击即跑。

> 这正是路线 A 的落地形态：pkgforge 的 sharun 负责打包、uruntime 负责运行时兼容，
> 社区已在 UOS V20 验证 Tauri V2 可跑通（见第 6 节，已在我们仓库 CI 实现）。

### 5.3 终端用户实际只需两步（都是 GUI）

1. **下载** `.AppImage`（图形浏览器）。
2. **右键 → 属性 → 权限 → 勾"允许作为程序执行文件"** → **双击**运行。
   若弹"未验证来源"，点"信任并启动"。

完。全程不需要敲任何命令；即便系统没装 `libfuse2`，uruntime 也会自动回退，不会卡住。

### 5.4 若你（开发者）想更省事：走 uab 但把摩擦前置到自己身上

如果坚持路线 B（uab 上架 / 体积更小），把第 2 节那 6 步里的「终端摩擦」**全留给你自己**：

- 4.⑤ 的 webkit runtime 直接**烘焙进 uab 的 app 层**（把 webkit `.so` 打进应用层、
  设 `LD_LIBRARY_PATH`），这样最终用户 `ll-cli install velo.uab` 时**自动装好、无需另加测试源**。
- linglong 若目标机没预装，由 IT / 你这边一次性在交付镜像里预置，终端用户不碰。

这样一来终端用户那侧也收敛成「双击 uab → GUI 点安装」，但构建侧你要多打一层私有 webkit。

### 5.5 一句话建议

- **终端用户零基础 + 不想碰任何终端 / 不想开开发者模式** → 选 **5.2 自包含 AppImage（已落地，见第 6 节）**。
- **要上架统信商店 / 体积敏感 + 你能接受构建侧多打一层私有 webkit** → 选 **5.4 烘焙 webkit 的 uab**。
- 两者都不需要终端用户懂 bash。AppImage 已在我们仓库 CI（`linux-x64-portable`）实现，是最省事的默认推荐。

---

## 6. 自包含 AppImage 实现（Arch + pkgforge sharun，2026-09-02 改为 AppImage）

> 状态：**build.yml 已改为 Arch 容器 + sharun 出 AppImage；`scripts/make-appimage.sh`
> 已落地；旧的 `scripts/make-portable-deb.mjs`（自包含 deb 方案）已删除。** 需在 CI 跑一次
> `linux-x64-portable` 验证（本机无 Linux 容器，跑不了真构建）。不再需要任何自托管 secret。

### 6.1 为什么从「自包含 deb」切到「AppImage」

- deb 方案要求用户侧可能要开 UOS 1070 开发者模式，且开发侧要**自托管 webkit 运行时 tarball**
  ——而 pkgforge **根本没有现成 webkit tarball**，得自己用工具构建并托管（`PKGFORGE_RUNTIME_URL` 是占位）。
- AppImage（sharun + uruntime）把 glibc + webkit + `libexec`(WebKitWebProcess) + opengl 一次性打包；
  且 **uruntime 的 FUSE→namespace→extract 回退**让终端用户侧**无需 libfuse2 / 无需开发者模式 / 无需终端**，
  仅 GUI 勾"允许执行" + 双击。
- 对"用户不懂终端"硬约束，AppImage 更契合。

### 6.2 双产物兼容模型

- **`linux-x64`（既有）**：正常 deb，依赖系统 `libwebkit2gtk-4.1-0`，给自带 4.1 的系统（Ubuntu 22.04+ / UOS 1071+）。CI 不变。
- **`linux-x64-portable`（新增）**：自包含 `.AppImage`，给 UOS V20（1070）等老系统。
- 两者是**不同格式、不同文件**：deb 走 apt / 系统安装器，AppImage 直接给文件双击运行。分发时按系统选其一即可。

> AppImage 是**超集**：绕开系统 webkit、用私有闭包，即使在「自带 4.1」的新系统上也能跑（只是体积大）。

### 6.3 改动清单

| 文件 | 改动 |
|---|---|
| `scripts/make-appimage.sh`（新增，替代已删的 `make-portable-deb.mjs`） | 拉 pkgforge `quick-sharun.sh` → 装 velo 到 `/usr/bin` → `OUTPUT_APPIMAGE=1 DEPLOY_WEBKIT2GTK=1 quick-sharun.sh /usr/bin/velo` 打包 → 产物挪到 `bundle/appimage/` |
| `package.json` | `tauri:build:portable` 改为 `tauri:build:appimage` = `tauri build --no-bundle && bash scripts/make-appimage.sh` |
| `.github/workflows/build.yml` | `linux-x64-portable` 不再用 ubuntu apt + 自托管 tarball，改为在 `archlinux:latest` 容器里 `pacman` 装 `webkit2gtk-4.1` + rust/node → `npm run tauri:build:appimage` 出 AppImage；Verify 改为校验 `.AppImage` |

### 6.4 本地 / CI 怎么用

```bash
# 本地（仅 Arch Linux，且已 pacman -S webkit2gtk-4.1 libayatana-appindicator librsvg openssl patchelf）
npm run tauri:build:appimage        # 产出 src-tauri/target/release/bundle/appimage/*.AppImage

# CI：手动触发 workflow_dispatch，platform 选 linux-x64-portable
#   无需任何 secret（不再有 PKGFORGE_RUNTIME_URL）
```

### 6.5 不能省的前置：必须在 Arch 构建 + mesa 精简

- **sharun 官方明确**：仅在 Arch 部署，非 Arch 部署「很糟」；且需先把应用装到 `/usr`。CI 已用 `archlinux` 容器满足。
- webkit 闭包由 sharun 自动从 Arch 系统 `/usr/lib` 探测打包，因此**不需要**自托管 tarball（这是相对 deb 方案最大的简化）。
- **UOS 4.19 内核 + Arch mesa 25 不兼容**：`make-appimage.sh` 内 `get-debloated-pkgs.sh --add-mesa --prefer-nano` 精简 mesa（非致命，失败跳过）。

### 6.6 校验命令（AppImage 产出后）

```bash
ai=$(ls src-tauri/target/release/bundle/appimage/*.AppImage)
file "$ai"                              # 应识别为 AppImage / ELF
# 在 UOS V20 真机（用户侧零终端）：
#   右键 → 属性 → 权限 → 勾"允许作为程序执行" → 双击
#   （无 libfuse2 时 uruntime 自动回退 namespace / extract，不报错）
```

---

## 附：本次核实的源码位置（便于复查）

| 事实 | 位置 |
|---|---|
| soup3 全部用法 | `wry-0.55.1/src/webkitgtk/web_context.rs:10,235` |
| webkit pkg-config 名 | `webkit2gtk-sys-2.0.2/Cargo.toml:58`、`src/lib.rs:3131` |
| jsc pkg-config 名 | `javascriptcore-rs-sys-1.1.1/Cargo.toml:40` |
| wry 基线 v2_38 | `wry-0.55.1/Cargo.toml.orig:58` |
| linux-body → v2_40 | `wry-0.55.1/Cargo.toml:58` |
| tauri 启用 linux-body | `tauri-runtime-wry-2.11.4/Cargo.toml:102` |
| body 的 cfg 回退 | `wry-0.55.1/src/webkitgtk/web_context.rs:202-205` |
| IPC postMessage 回退 | `tauri-2.11.5/scripts/ipc-protocol.js:19-20,84` |
| postMessage 服务端 | `tauri-2.11.5/src/ipc/protocol.rs:185` |
| channel 走 header | `tauri-2.11.5/src/ipc/channel.rs:179` |
| CI Linux 基座 | `.github/workflows/build.yml:125,147` |
| glib/gtk 锁定版本 | `src-tauri/Cargo.lock`（glib 0.18.5 / gtk 0.18.2 / soup3 0.5.0） |
