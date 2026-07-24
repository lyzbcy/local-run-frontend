# AI-Agent 接入

> 让你的 AI Agent（Cursor / Claude Code / ZCode / Windsurf 等）通过本地 HTTP 接口控制本软件。

## 原理

本软件启动后，会在本机 `127.0.0.1:47800` 开一个控制接口。AI Agent 只要能发 HTTP 请求，就能查询项目、启动/关闭前端预览。这样你就能用自然语言对 Agent 说"启动 XXX 项目"，Agent 帮你调接口完成。

## 接口规范

所有接口仅绑定 `127.0.0.1`，只能本机访问。请求/响应均为 JSON。

| 方法 | 路径 | 入参 | 作用 |
|------|------|------|------|
| GET | `/` | — | 健康检查 |
| GET | `/projects` | — | 所有项目列表（含 id/name/path/type） |
| GET | `/status` | — | 当前运行中的实例 |
| POST | `/start` | `{"id":"<projectId>"}` | 启动项目（自动开浏览器 + 目录页） |
| POST | `/stop` | `{"id":"<projectId>"}` | 关闭项目 |

**响应示例**：

```jsonc
// GET /projects
{ "ok": true, "projects": [{ "id": "abc", "name": "我的官网", "path": "/.../site", "type": "static" }] }

// POST /start
{ "ok": true, "instance": { "port": 8092, "baseUrl": "http://127.0.0.1:8092", "navUrl": "http://127.0.0.1:8092/__nav__", "homeUrl": "http://127.0.0.1:8092/" } }

// POST /stop
{ "ok": true }
```

## 给 AI Agent 的 Prompt（直接复制）

软件内的「🤖 AI Agent」页签也提供了这段，可一键复制：

```
你正在使用「本地运行前端项目」桌面软件。它在本机运行了一个控制接口（http://127.0.0.1:47800），你可以通过它控制软件，帮用户启动/关闭前端项目。

可用接口（仅本机，JSON）：
- GET  http://127.0.0.1:47800/projects   拿到所有项目列表（含 id / name / path / type）
- GET  http://127.0.0.1:47800/status     查看当前运行中的实例
- POST  http://127.0.0.1:47800/start     body: {"id":"<projectId>"}  启动项目（会自动开浏览器和目录页）
- POST  http://127.0.0.1:47800/stop      body: {"id":"<projectId>"}  关闭项目

工作方式：
1. 用户说"启动 XXX 项目"时，先 GET /projects 找到名字匹配的项目的 id，再 POST /start。
2. 用户说"关闭 / 停掉"时，先 GET /status 看运行中的，再 POST /stop。
3. 启动后把返回的 baseUrl / navUrl（目录页）告诉用户。

注意：这个软件不会往用户的项目里写任何文件，所有预览都在软件内部完成。
```

## 使用流程

1. 打开「本地运行前端项目」软件（控制接口会自动启动）。
2. 在软件里添加好你要管理的项目。
3. 把上面的 Prompt 喂给你的 AI Agent。
4. 在 Agent 里说"启动 XXX"、"停掉 XXX"，Agent 调接口完成。

## 安全说明

- 接口只绑 `127.0.0.1`，**外网无法访问**。
- 没有鉴权（本机信任模型）。如需多用户/共享，请勿直接暴露端口。
- 启动项目会自动打开浏览器和目录页——这是给"人看"的；Agent 验证可用 curl 拿 `navUrl`。
