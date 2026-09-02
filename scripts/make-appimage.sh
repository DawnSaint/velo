#!/usr/bin/env bash
# 把 Velo 打包成自包含 AppImage（Arch + pkgforge sharun + uruntime）
#
# 前置（由 CI 或本地 Arch 用户准备）：
#   - 系统已装 webkit2gtk-4.1 等依赖：
#       pacman -S webkit2gtk-4.1 libayatana-appindicator librsvg openssl patchelf
#   - 已 npm ci 且已编译出 src-tauri/target/release/velo
#     （本脚本通常由 `npm run tauri:build:appimage` 在 `tauri build --no-bundle` 之后调用）
#
# 产物：src-tauri/target/release/bundle/appimage/*.AppImage
# 特性：uruntime 让终端用户侧无需 libfuse2 / 无需开发者模式（FUSE→namespace→extract 回退）。
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

BIN="src-tauri/target/release/velo"
[ -x "$BIN" ] || { echo "::error::未找到可执行文件 $BIN，请先编译（tauri build --no-bundle）"; exit 1; }

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

# 1) 拉取 pkgforge sharun 工具（自动部署 webkit/gtk/opengl 等全部依赖）
SHARUN=/tmp/quick-sharun.sh
curl -fSL https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/main/useful-tools/quick-sharun.sh -o "$SHARUN"
chmod +x "$SHARUN"

# 可选的 mesa 精简：针对 UOS 4.19 内核 + Arch mesa 25 不兼容；失败不阻断
curl -fSL https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/main/useful-tools/get-debloated-pkgs.sh -o /tmp/get-debloated-pkgs.sh 2>/dev/null || true
chmod +x /tmp/get-debloated-pkgs.sh 2>/dev/null || true
/tmp/get-debloated-pkgs.sh --add-mesa --prefer-nano 2>/dev/null || echo "⚠️ mesa debloat 跳过（非致命）"

# 2) sharun 要求先把应用装到 /usr
$SUDO install -Dm755 "$BIN" /usr/bin/velo
[ -f src-tauri/icons/icon.png ] && $SUDO install -Dm644 src-tauri/icons/icon.png /usr/share/pixmaps/velo.png || true

# 3) 打包 AppImage（OUTPUT_APPIMAGE=1 → 产出 .AppImage）
OUTPUT_APPIMAGE=1 DEPLOY_WEBKIT2GTK=1 "$SHARUN" /usr/bin/velo

# 4) 把产物挪到 Tauri 的 bundle 目录，便于统一上传 artifact
mkdir -p src-tauri/target/release/bundle/appimage
mv ./*AppImage src-tauri/target/release/bundle/appimage/ 2>/dev/null || true
ls -la src-tauri/target/release/bundle/appimage/
echo "✅ AppImage 生成完成"
