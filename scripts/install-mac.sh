#!/bin/bash
# 「本地运行前端项目」一键安装脚本（macOS）
# 作用：把 .app 拖进「应用程序」，并去掉 macOS 的 quarantine 标记（解决"已损坏/无法验证开发者"问题）。
#
# 用法：
#   1. 下载 release 包（.app + 本脚本）解压
#   2. 双击本脚本，或在终端运行：bash 一键安装.command
#
# 原理：未签名的 .app 从网上下载后会被打上 com.apple.quarantine 标记，
#       双击会被 Gatekeeper 拦截。本脚本用 xattr 移除该标记，并复制到应用程序。

set -e

# UTF-8，防中文路径乱码
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

APP_NAME="本地运行前端项目"
APP_FILE="${APP_NAME}.app"
APPLICATIONS="/Applications"

# 脚本所在目录（.app 应该和本脚本在同一层）
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SRC_APP="$SCRIPT_DIR/$APP_FILE"

echo ""
echo "============================================================"
echo "  $APP_NAME · 一键安装"
echo "============================================================"
echo ""

# 1. 检查 .app 是否存在
if [ ! -d "$SRC_APP" ]; then
  echo "[错误] 没找到 $APP_FILE"
  echo "       请确认 $APP_FILE 和本脚本在同一个文件夹里。"
  echo "       当前查找位置：$SRC_APP"
  echo ""
  read -p "按回车关闭..."
  exit 1
fi
echo "[1/3] 找到 $APP_FILE：$SRC_APP"

# 2. 移除 quarantine 标记（关键：解决"已损坏"）
echo "[2/3] 移除 macOS 隔离标记（解决\"已损坏/无法验证开发者\"提示）..."
xattr -dr com.apple.quarantine "$SRC_APP" 2>/dev/null || true
echo "      完成"

# 3. 复制到「应用程序」
echo "[3/3] 复制到「应用程序」文件夹..."
# 如果已存在旧版，先删掉
if [ -d "$APPLICATIONS/$APP_FILE" ]; then
  echo "      检测到旧版本，先移除..."
  rm -rf "$APPLICATIONS/$APP_FILE"
fi
cp -R "$SRC_APP" "$APPLICATIONS/" 2>/dev/null || {
  echo "      [提示] 复制到应用程序需要管理员权限，正在请求..."
  osascript -e "do shell script \"cp -R \\\"$SRC_APP\\\" \\\"$APPLICATIONS/\\\"\" with administrator privileges" 2>/dev/null || {
    echo "      [跳过] 未能复制到应用程序，你可以手动把 $APP_FILE 拖进应用程序文件夹。"
  }
}

echo ""
echo "============================================================"
echo "  ✅ 安装完成！"
echo ""
echo "  打开方式："
echo "    • 在启动台 / Spotlight 搜索「$APP_NAME」"
echo "    • 或双击：$APPLICATIONS/$APP_FILE"
echo ""
echo "  首次打开若仍被拦截："
echo "    系统设置 → 隐私与安全性 → 拉到底 → 点「仍要打开」"
echo "============================================================"
echo ""

# 询问是否立即打开
read -p "是否立即打开？[Y/n] " OPEN
if [[ ! "$OPEN" =~ ^[Nn] ]]; then
  open "$APPLICATIONS/$APP_FILE" 2>/dev/null || open "$SRC_APP"
fi
