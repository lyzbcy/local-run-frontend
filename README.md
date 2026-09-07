# 🚀 本地运行前端项目

> 集中启动常见前端项目，**无需向项目添加预览脚本**。

接手每一个前端项目都要先搭一套本地预览——脚本不能 git 上去，同事用不了，下次还要重来。
这个桌面软件把这件事固化下来：装一次，统一管理本地项目，同事也能独立安装使用。

## ✨ 功能

- 📂 **自动识别项目**：静态站 / Vite / Next / Vue / CRA / Nuxt / Angular，选目录即判断
- 🚀 **一键启动**：端口自动顺延、健康检查通过才开浏览器、先打开自动生成的目录页
- 🔄 **一键重启**：改了代码点「重启」即可，无需停了再起
- 🖱️ **拖拽添加**：直接把文件夹拖进窗口，自动识别类型
- 🚫 **零文件侵入**：软件不添加预览脚本；框架仍可能生成缓存和编译输出
- 🔌 **端口管理**：一目了然看到本机在跑哪些预览，可单独停掉
- ⭐ **项目记忆**：我的项目 / 收藏 / 最近，一次添加下次一键打开
- 🤖 **AI Agent 接入**：本地 HTTP 接口 + Prompt，用自然语言控制启停/重启/添加/删除
- 🔄 **app 内自动更新**：检查新版本，按平台下载 Mac 更新包或 Windows 安装程序
- 🍟 **托盘后台运行**：Mac 关闭窗口后服务保留；Windows 关闭窗口退出并停止服务
- 🔐 **登录态自适应**：自动探测后端项目（.env/baseURL），需要 token 时才显示注入区，字段全可改
- 📊 **日志可追溯**：200 条运行日志 + dev server 输出，按项目过滤，可导出

## 📦 安装

**v0.3.0 用户请手动下载新版安装包升级。** 旧版内置更新器存在替换失败风险，本次修复仅在 v0.4.0 及以后生效。

### 方式一：下载 release（普通用户）

v0.4.0 下载（**Mac 推荐 DMG**：双击打开，把应用图标拖进右侧 Applications 文件夹即可）：

| 系统 | 推荐 | 备选（含安装脚本） |
|---|---|---|
| macOS 12+，Apple 芯片 | [Mac arm64 DMG](https://github.com/lyzbcy/local-run-frontend/releases/download/v0.4.0/local-run-frontend-v0.4.0-mac-arm64.dmg) | [arm64 ZIP](https://github.com/lyzbcy/local-run-frontend/releases/download/v0.4.0/local-run-frontend-v0.4.0-mac-arm64.zip) |
| macOS 12+，Intel 芯片 | [Mac x64 DMG](https://github.com/lyzbcy/local-run-frontend/releases/download/v0.4.0/local-run-frontend-v0.4.0-mac-x64.dmg) | [x64 ZIP](https://github.com/lyzbcy/local-run-frontend/releases/download/v0.4.0/local-run-frontend-v0.4.0-mac-x64.zip) |
| Windows 10+，x64 | — | [Windows NSIS 安装 EXE](https://github.com/lyzbcy/local-run-frontend/releases/download/v0.4.0/local-run-frontend-v0.4.0-win-x64-setup.exe) |

> 应用未做开发者签名：Mac 首次打开若被拦，系统设置 → 隐私与安全性 → 「仍要打开」，或用应用内的「一键去除隔离」引导；Windows SmartScreen 选「仍要运行」。

Mac：解压后保持 `.app`、`一键安装.command`、`install-mac.sh` 在同一目录，运行 `一键安装.command`。应用未签名，可能需要在系统设置中选择「仍要打开」；应用被拦时，不能依靠进入应用自修。
Windows：运行安装 EXE。安装包未签名，可能出现系统提示，请核对下载来源后继续。

静态项目无需安装 Node.js。框架项目须先安装依赖，并满足其 Node.js 版本要求，建议 22+。特殊命令、环境变量、登录态与后端依赖需按项目配置，不能保证任意项目开箱即用。

### 方式二：源码运行（开发者）

```bash
git clone https://github.com/lyzbcy/local-run-frontend.git
cd local-run-frontend
npm install      # .npmrc 已配 npmmirror，Electron 二进制国内可直连
npm start        # 开发调试：npm run dev
```

> 需要本机装了 Node.js 22+（用户项目的实际要求优先）。框架项目（Vite/Next 等）的启动还需用户项目本身 `npm install` 过。

## 🖱️ 使用

1. 打开软件 →「＋ 添加项目」→ 选择一个前端项目目录
2. 软件自动识别类型（静态 / 框架）
3. 点项目卡片「▶ 启动」→ 自动起服务、健康检查、打开浏览器和目录页

## 🤖 AI Agent 接入

软件启动后会在 `http://127.0.0.1:47800` 开控制接口。详见 [AI-Agent 接入文档](./doc/05-ai-agent-接入.md)，
软件内「🤖 AI Agent」页签也提供了一键复制的 Prompt。

## 🛠️ 技术栈

- **Electron 43** + 原生 JS（零构建，省 token）
- 内嵌静态预览服务器（复用 [lyzbcy-zeen-tools](https://github.com/lyzbcy) 的精华）
- macOS 12+（Apple / Intel 芯片）、Windows 10+（x64）

## 📚 文档

所有设计、进度、技术方案、开发经验都在 [`doc/`](./doc/) 下（渐进式披露，先读 `doc/README.md`）。

## 📋 当前状态

v0.4.0：提供 Mac arm64 / x64 与 Windows x64 安装包；修复批量导入、未知项目自定义命令、目录页与预览路径边界。发布附件与验证结果以对应 Release 为准。

## 💖 关于

由 [捞鱼](https://lyzbcy.github.io/) 制作 · MIT 协议 · 开源免费

介绍页：<https://lyzbcy.github.io/local-run-frontend/>
