#!/bin/bash
set -eu
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SRC_APP="$SCRIPT_DIR/本地运行前端项目.app"
TARGET_APP="/Applications/本地运行前端项目.app"
echo '请先退出旧版「本地运行前端项目」，再继续安装。'
read -r -p '按回车开始安装…' _
if [ ! -d "$SRC_APP/Contents/MacOS" ]; then
  echo '未找到完整 .app，请把安装脚本和 .app 放在同一个目录。'
  read -r -p '按回车关闭…' _
  exit 1
fi
if ! /bin/bash "$SCRIPT_DIR/install-mac.sh" "$SRC_APP" "$TARGET_APP"; then
  echo '需要管理员权限，请在系统弹窗中授权。'
  /usr/bin/osascript - "$SCRIPT_DIR/install-mac.sh" "$SRC_APP" "$TARGET_APP" <<'APPLESCRIPT'
on run argv
  do shell script "/bin/bash " & quoted form of (item 1 of argv) & " " & quoted form of (item 2 of argv) & " " & quoted form of (item 3 of argv) with administrator privileges
end run
APPLESCRIPT
fi
echo '安装完成：/Applications/本地运行前端项目.app'
read -r -p '立即打开？[Y/n] ' choice
if [[ ! "$choice" =~ ^[Nn] ]]; then /usr/bin/open "$TARGET_APP"; fi
