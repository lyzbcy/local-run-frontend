// 运行时管理：端口扫描 + 启动预览/dev server + 健康检查 + 进程回收。
// runningInstances: Map<projectId, { kind, proc?, server?, port, baseUrl, navUrl, startedAt }>

const net = require('net');
const { spawn } = require('child_process');
const { createPreviewServer, scanHtmlFiles } = require('./preview-server');
const { createDevNavServer } = require('./dev-nav');

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

// 把用户配置的启动命令 + 指定端口，拼成正确的参数数组。
// 关键：npm/yarn/pnpm run xxx 必须用 "--" 分隔，否则 --port 会被 npm 当成它自己的参数吞掉。
function buildFrameworkArgs(cmd, port) {
  const parts = cmd.split(/\s+/).filter(Boolean);
  const bin = parts[0];
  const args = parts.slice(1);
  const portArgs = ['--port', String(port), '--strictPort'];
  // npm/yarn/pnpm run <script> 需要用 -- 转发参数给脚本
  if ((bin === 'npm' || bin === 'yarn' || bin === 'pnpm' || bin === 'npx') && !args.includes('--')) {
    return [...args, '--', ...portArgs];
  }
  return [...args, ...portArgs];
}

// 从 dev server 输出里抓真实端口（vite/next/nuxt 都会打印 Local: http://...:PORT）。
// 返回端口号字符串，抓不到返回 null。
function extractPortFromOutput(output) {
  const m = output.match(/(?:Local|ready)[^\n]*?https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i);
  return m ? m[1] : null;
}

// 启动框架项目的 dev server（子进程）
async function startFramework(project, portRange, log, options = {}) {
  const preferPort = await findFreePort(portRange[0], portRange[1], project.port);
  const cmd = project.startCommand || 'npm run dev';
  const bin = cmd.split(/\s+/)[0];
  const args = buildFrameworkArgs(cmd, preferPort);
  log(`启动命令：${bin} ${args.join(' ')}`);

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined
  };
  // 拼 PATH：.app 双击时默认 PATH 极短，不含 nvm/volta。把探测到的 node binDir 放最前。
  const extraPaths = [];
  if (options.nodeBinDir) extraPaths.push(options.nodeBinDir);
  if (process.platform === 'darwin') extraPaths.push('/opt/homebrew/bin', '/usr/local/bin');
  if (extraPaths.length) env.PATH = [...extraPaths, env.PATH || ''].join(':');

  const proc = spawn(bin, args, {
    cwd: project.path,
    env,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // 边收集输出边尝试抓真实端口。输出节流 + 噪音折叠，避免 IPC 洪泛（qv-admin 启动吐上百行 sass 警告会卡死渲染层）。
  let realPort = null;
  let buffer = '';
  let pendingLogs = '';
  let flushTimer = null;
  let noiseCount = 0; // 折叠掉重复的噪音警告

  const FLUSH_MS = 200;
  const FLUSH_MAX = 2000; // 攒到这个量也立即 flush
  const NOISE_RE = /DEPRECATION WARNING|@charset must precede|mixed-decls|repetitive deprecation|postcss|glob option "as"|Failed to run dependency scan|rules will be changing|behavior for declarations|move the declaration|opt into the new behavior|nested rule|root stylesheet|Run in verbose mode|could not be resolved|Are they installed|Skipping dependency/i;

  const flushLogs = (force) => {
    if (!pendingLogs && !noiseCount) return;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    let out = pendingLogs;
    if (noiseCount) out += (out ? '\n' : '') + `[dev] (已折叠 ${noiseCount} 条噪音警告：sass/postcss/deprecation 等)`;
    if (out) log(out);
    pendingLogs = '';
    noiseCount = 0;
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flushLogs(false); }, FLUSH_MS);
  };
  const handleChunk = (s, tag) => {
    buffer += s;
    tryExtract();
    // 按行分类：噪音折叠，正常行累积
    for (const line of s.split(/\r?\n/)) {
      if (!line) continue;
      if (NOISE_RE.test(line)) { noiseCount++; continue; }
      pendingLogs += (pendingLogs ? '\n' : '') + `[${tag}] ${line}`;
      if (pendingLogs.length >= FLUSH_MAX) flushLogs(false);
    }
    scheduleFlush();
  };
  const tryExtract = () => {
    if (!realPort) {
      const p = extractPortFromOutput(buffer);
      if (p) { realPort = p; log(`检测到 dev server 端口：${realPort}`); }
    }
  };
  proc.stdout.on('data', d => handleChunk(d.toString(), 'dev'));
  proc.stderr.on('data', d => handleChunk(d.toString(), 'dev!'));
  proc.on('exit', code => { flushLogs(true); log(`[dev] 进程退出 code=${code}`); });

  // 等真实端口出现（dev server 会打印），最长 90s
  const deadline = Date.now() + 90000;
  while (!realPort && Date.now() < deadline && !proc.killed) {
    await sleep(500);
  }

  // 端口确认：抓到用抓到的，否则退回期望端口（健康检查兜底）
  const port = realPort ? parseInt(realPort, 10) : preferPort;
  const homeUrl = `http://127.0.0.1:${port}/`;
  flushLogs(true);
  log(`健康检查：${homeUrl}`);
  await waitHealthy(homeUrl, { timeout: 60000, log });
  flushLogs(true);

  const baseUrl = `http://127.0.0.1:${port}`;
  // 框架项目：额外起一个开发导航 server（扫 src/router），让目录页能点进各路由
  let navServer = null;
  let navUrl = homeUrl;
  try {
    navServer = await createDevNavServer({
      projectRoot: project.path, projectName: project.name, devBaseUrl: baseUrl, onLog: log
    });
    navUrl = navServer.navUrl;
  } catch (e) { log(`[nav] 启动失败（忽略，降级为首页）：${e.message}`); }

  return {
    kind: 'framework', server: navServer ? navServer.server : null, proc, port, baseUrl,
    homeUrl, navUrl, startedAt: Date.now()
  };
}

async function startProject(project, portRange, log = () => {}, options = {}) {
  if (instances.has(project.id)) {
    return { ok: true, instance: instances.get(project.id), already: true };
  }
  try {
    const inst = project.framework
      ? await startFramework(project, portRange, log, options)
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

module.exports = { startProject, stopProject, getStatus, stopAll, isPortFree, findFreePort, buildFrameworkArgs, extractPortFromOutput };
