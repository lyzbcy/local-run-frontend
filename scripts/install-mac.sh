#!/bin/bash
# 被一键安装.command 调用；先复制完整新版，再替换旧版。
set -eu
source_app="$1"
target="$2"
stage="$target.update-$$"
backup="$target.backup-$$"
trap 'rm -rf "$stage"' EXIT
[ -d "$source_app/Contents/MacOS" ] || { echo '应用包不完整'; exit 1; }
/usr/bin/ditto "$source_app" "$stage"
/usr/bin/xattr -dr com.apple.quarantine "$stage" 2>/dev/null || true
if [ -e "$target" ]; then mv "$target" "$backup"; fi
if mv "$stage" "$target"; then
  rm -rf "$backup"
else
  if [ -e "$backup" ]; then mv "$backup" "$target"; fi
  exit 1
fi
