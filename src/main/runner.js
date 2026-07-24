// 运行时管理：端口扫描 + 启动预览/dev server + 健康检查 + 进程回收。
// runningInstances: Map<projectId, { kind, proc?, server?, port, baseUrl, navUrl, startedAt }>

const net = require('net');
const { spawn } = require('child_process');
const { createPreviewServer, scanHtmlFiles } = require('./preview-server');

const instances = new Map();

function isPortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function findFreePort(start, end, prefer) {
  if (prefer && await isPortFree(prefer)) return prefer;
  for (let p = start; p <= end; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`端口区间 ${start}-${end} 已满`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 用 Electron 自带的 fetch（Node 20+ 全局 fetch）做健康检查
async function waitHealthy(url, { timeout = 60000, interval = 1000, log }) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
      clearTimeout(t);
      // 2xx/3xx 都算就绪；404 也算 server 起来了（首页路由可能不对，但 server OK）
      if (res.status < 500) return true;
    } catch {}
    await sleep(interval);
  }
  throw new Error(`健康检查超时：${url}`);
}

// 启动静态项目的内嵌预览 server
async function startStatic(project, portRange, log) {
  const port = await findFreePort(portRange[0], portRange[1], project.port);
  const { server, baseUrl } = await createPreviewServer({
    root: project.path,
    projectName: project.name,
    port,
    routeAliases: project.routeAliases || {},
    onLog: log
  });
  const navUrl = `${baseUrl}/__nav__`;
  const homeUrl = `${baseUrl}/`;
  // 健康检查首页
  await waitHealthy(homeUrl, { timeout: 15000, log });
  return {
    kind: 'static', server, proc: null, port, baseUrl,
    homeUrl, navUrl, startedAt: Date.now()
  };
}

// 启动框架项目的 dev server（子进程）
async function startFramework(project, portRange, log) {
  const port = await findFreePort(portRange[0], portRange[1], project.port);
  const homeUrl = `http://127.0.0.1:${port}/`;

  // 拆分命令：支持 "npm run dev" 这种带空格的
  const cmd = project.startCommand || 'npm run dev';
  const parts = cmd.split(/\s+/);
  const bin = parts[0];
  const args = parts.slice(1);
  // 注入端口：vite/next/nuxt 都认 --port
  args.push('--port', String(port), '--strictPort');

  // 用系统 shell 找到 npm（Electron 打包后 PATH 可能不全，兜底加常见路径）
  const env = {
    ...process.env,
    // 不让子进程以为是 Electron
    ELECTRON_RUN_AS_NODE: undefined
  };
  // mac 上双击启动 Electron 时 PATH 很短，补一下
  if (process.platform === 'darwin') {
    env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH || ''}`;
  }

  const proc = spawn(bin, args, {
    cwd: project.path,
    env,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const stdoutChunks = [];
  proc.stdout.on('data', d => { const s = d.toString(); stdoutChunks.push(s); log(`[dev] ${s.trimEnd()}`); });
  proc.stderr.on('data', d => { const s = d.toString(); log(`[dev!] ${s.trimEnd()}`); });
  proc.on('exit', code => log(`[dev] 进程退出 code=${code}`));

  // 等 server 起来
  await waitHealthy(homeUrl, { timeout: 90000, log });

  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    kind: 'framework', server: null, proc, port, baseUrl,
    homeUrl, navUrl: homeUrl, startedAt: Date.now()
  };
}

async function startProject(project, portRange, log = () => {}) {
  if (instances.has(project.id)) {
    return { ok: true, instance: instances.get(project.id), already: true };
  }
  try {
    const inst = project.framework
      ? await startFramework(project, portRange, log)
      : await startStatic(project, portRange, log);
    instances.set(project.id, inst);
    return { ok: true, instance: inst };
  } catch (e) {
    log(`[start] 失败: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

function stopProject(projectId, log = () => {}) {
  const inst = instances.get(projectId);
  if (!inst) return { ok: true, already: true };
  try {
    if (inst.server) {
      try { inst.server.close(); } catch {}
    }
    if (inst.proc && !inst.proc.killed) {
      inst.proc.kill('SIGTERM');
      // 兜底强杀
      setTimeout(() => {
        try {
          if (inst.proc && !inst.proc.killed) inst.proc.kill('SIGKILL');
        } catch {}
      }, 1500);
    }
  } catch (e) {
    log(`[stop] ${e.message}`);
  }
  instances.delete(projectId);
  return { ok: true };
}

function getStatus() {
  const out = [];
  for (const [pid, inst] of instances) {
    out.push({
      projectId: pid,
      kind: inst.kind,
      port: inst.port,
      baseUrl: inst.baseUrl,
      homeUrl: inst.homeUrl,
      navUrl: inst.navUrl,
      startedAt: inst.startedAt
    });
  }
  return out;
}

function stopAll() {
  for (const pid of [...instances.keys()]) stopProject(pid);
}

module.exports = { startProject, stopProject, getStatus, stopAll, isPortFree, findFreePort };
