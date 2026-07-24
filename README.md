# 🚀 本地运行前端项目

> 一键启动任意前端项目，**不往项目里写任何文件**。

接手每一个前端项目都要先搭一套本地预览——脚本不能 git 上去，同事用不了，下次还要重来。
这个桌面软件把这件事固化下来：装一次，统一管理所有前端项目，团队共享，永久在线。

## ✨ 功能

- 📂 **自动识别项目**：静态站 / Vite / Next / Vue / CRA / Nuxt / Angular，选目录即判断
- 🚀 **一键启动**：端口自动顺延、健康检查通过才开浏览器、先打开自动生成的目录页
- 🚫 **零文件侵入**：所有预览能力都在软件内部，绝不往项目目录写文件
- 🔌 **端口管理**：一目了然看到本机在跑哪些预览，可单独停掉
- ⭐ **项目记忆**：我的项目 / 收藏 / 最近，一次添加下次一键打开
- 🤖 **AI Agent 接入**：本地 HTTP 接口 + Prompt，用自然语言控制启停
- 🔄 **自动更新**：打开时比对 GitHub release，有新版提醒

## 📦 安装

### 方式一：下载 release（普通用户）

到 [Releases](https://github.com/lyzbcy/local-run-frontend/releases/latest) 下载 `.app`，拖进「应用程序」。
首次打开若提示"已损坏"，运行随附的一键安装脚本（去掉 quarantine 标记）。

### 方式二：源码运行（开发者）

```bash
git clone https://github.com/lyzbcy/local-run-frontend.git
cd local-run-frontend
npm install      # .npmrc 已配 npmmirror，Electron 二进制国内可直连
npm start        # 开发调试：npm run dev
```

> 需要本机装了 Node.js 16+。框架项目（Vite/Next 等）的启动还需用户项目本身 `npm install` 过。

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
- macOS 优先，Windows 设计预留

## 📚 文档

所有设计、进度、技术方案、开发经验都在 [`doc/`](./doc/) 下（渐进式披露，先读 `doc/README.md`）。

## 📋 当前状态

v0.1.0 MVP：核心闭环（识别→启动→目录页→端口管理→AI 接口）已可用。
打包成 `.app` + 安装脚本、Windows 版、介绍页部署为 MVP 后阶段。

## 💖 关于

由 [捞鱼](https://lyzbcy.github.io/) 制作 · MIT 协议 · 开源免费

介绍页：<https://lyzbcy.github.io/local-run-frontend/>
