// AI-Agent 控制接口：一个独立的本地 HTTP server，让外部 AI Agent 能控制本软件。
// 绑定 127.0.0.1，固定端口 47800。
// 端点：
//   GET  /status                 → 运行中实例
//   GET  /projects               → 项目列表
//   POST /start   {id}           → 启动
//   POST /stop    {id}           → 关闭

const http = require('http');
const { shell } = require('electron');

const CTRL_PORT = 47800;

function createControlServer({ getStore, startProject, stopProject, getStatus, onLog }) {
  const log = (...a) => { try { (onLog || console.log)('[ctrl]', ...a); } catch {} };

  function send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  function readBody(req) {
    return new Promise(resolve => {
      let raw = '';
      req.on('data', c => raw += c);
      req.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}); }
        catch { resolve({}); }
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    try {
      if (req.method === 'GET' && url === '/status') {
        return send(res, 200, { ok: true, instances: getStatus() });
      }
      if (req.method === 'GET' && url === '/projects') {
        const store = getStore();
        return send(res, 200, { ok: true, projects: store.projects });
      }
      if (req.method === 'POST' && url === '/start') {
        const { id } = await readBody(req);
        const store = getStore();
        const project = store.projects.find(p => p.id === id);
        if (!project) return send(res, 404, { ok: false, error: '项目不存在' });
        const r = await startProject(project, store.settings.portRange, log);
        if (r.ok) {
          // 自动开浏览器（agent 模式也开，方便 agent 验证）
          try { shell.openExternal(r.instance.navUrl || r.instance.homeUrl); } catch {}
          return send(res, 200, { ok: true, instance: { port: r.instance.port, baseUrl: r.instance.baseUrl, navUrl: r.instance.navUrl, homeUrl: r.instance.homeUrl } });
        }
        return send(res, 500, { ok: false, error: r.error });
      }
      if (req.method === 'POST' && url === '/stop') {
        const { id } = await readBody(req);
        stopProject(id, log);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url === '/') {
        return send(res, 200, { ok: true, service: '本地运行前端项目 控制接口', version: '1' });
      }
      send(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      send(res, 500, { ok: false, error: e.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(CTRL_PORT, '127.0.0.1', () => {
      log(`控制接口就绪 http://127.0.0.1:${CTRL_PORT}`);
      resolve({ server, port: CTRL_PORT });
    });
  });
}

module.exports = { createControlServer, CTRL_PORT };
