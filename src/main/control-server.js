const { rejectUntrustedRequest } = require('./local-http-security');
// AI-Agent 控制接口：一个独立的本地 HTTP server，让外部 AI Agent 能控制本软件。
// 绑定 127.0.0.1，固定端口 47800。
// 端点：
//   GET  /status                 → 运行中实例
//   GET  /projects               → 项目列表
//   POST /start   {id}           → 启动
//   POST /stop    {id}           → 关闭
//   POST /restart {id}           → 重启（停止后启动）
//   POST /add     {path,name?}   → 添加项目（自动探测类型）
//   POST /remove  {id}           → 删除项目（仅从列表删，不删文件）

const http = require('http');
const { shell } = require('electron');

const CTRL_PORT = 47800;

function createControlServer({ getStore, saveStore, startProject, stopProject, getStatus, detectFn, addProjectFn, removeProjectFn, onLog }) {
  const log = (...a) => { try { (onLog || console.log)('[ctrl]', ...a); } catch {} };

  function send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  function readBody(req) {
    return new Promise(resolve => {
      let raw = '';
      let tooBig = false;
      req.on('data', c => {
        if (tooBig) return;
        raw += c;
        // 限制 2MB，防本地恶意/失控进程 OOM
        if (raw.length > 2 * 1024 * 1024) { tooBig = true; resolve({ __tooBig: true }); }
      });
      req.on('end', () => {
        if (tooBig) return; // 已 resolve
        try { resolve(raw ? JSON.parse(raw) : {}); }
        catch { resolve({}); }
      });
    });
  }

  // 内部辅助：启动并开浏览器
  async function startAndRespond(res, project) {
    const store = getStore();
    const r = await startProject(project, store.settings.portRange, log);
    if (r.ok) {
      try { shell.openExternal(r.instance.navUrl || r.instance.homeUrl); } catch {}
      return send(res, 200, { ok: true, instance: { port: r.instance.port, baseUrl: r.instance.baseUrl, navUrl: r.instance.navUrl, homeUrl: r.instance.homeUrl } });
    }
    return send(res, 500, { ok: false, error: r.error });
  }

  const server = http.createServer(async (req, res) => {
    if (rejectUntrustedRequest(req, res)) return;
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
        return startAndRespond(res, project);
      }
      if (req.method === 'POST' && url === '/restart') {
        const { id } = await readBody(req);
        const store = getStore();
        const project = store.projects.find(p => p.id === id);
        if (!project) return send(res, 404, { ok: false, error: '项目不存在' });
        stopProject(id, log);
        // 等 SIGKILL 兜底完成（runner.js 里是 1500ms），留足端口释放时间
        await new Promise(r => setTimeout(r, 1800));
        return startAndRespond(res, project);
      }
      if (req.method === 'POST' && url === '/stop') {
        const { id } = await readBody(req);
        stopProject(id, log);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url === '/add') {
        const body = await readBody(req);
        const p = body.path;
        if (!p || typeof p !== 'string') return send(res, 400, { ok: false, error: '缺少 path' });
        const info = detectFn(p);
        const store = getStore();
        const { data: next, project, created } = addProjectFn(store, { name: body.name || null, projectPath: p, type: info.type, startCommand: info.startCommand, framework: !!info.framework });
        saveStore(next);
        if (!created) return send(res, 200, { ok: true, project, created: false, msg: '项目已存在' });
        log(`[agent] 添加项目「${project.name}」(${info.type})`);
        return send(res, 200, { ok: true, project, created: true });
      }
      if (req.method === 'POST' && url === '/remove') {
        const { id } = await readBody(req);
        stopProject(id, log);
        const store = getStore();
        const next = removeProjectFn(store, id);
        saveStore(next);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url === '/') {
        return send(res, 200, { ok: true, service: '本地运行前端项目 控制接口', version: '2', endpoints: ['GET /status','GET /projects','POST /start','POST /stop','POST /restart','POST /add','POST /remove'] });
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
