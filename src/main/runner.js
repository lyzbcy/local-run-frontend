// 运行时管理：端口扫描 + 启动预览/dev server + 健康检查 + 进程回收。
// runningInstances: Map<projectId, { kind, proc?, server?, port, baseUrl, navUrl, startedAt }>

const net = require('net');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const { createPreviewServer } = require('./preview-server');
const { createDevNavServer } = require('./dev-nav');
const { checkProjectBackends } = require('./backend-probe');
const { detectNode } = require('./detect-node');

const instances = new Map();
const starting = new Map();

// Probe both wildcard and loopback addresses. macOS permits a wildcard bind
// alongside an existing loopback listener, so one address alone misses conflicts.
async function isPortFree(port) {
  for (const host of ['0.0.0.0', '127.0.0.1', '::1', '::']) {
    const free = await new Promise(resolve => {
      const srv = net.createServer();
      srv.once('error', error => resolve(['EAFNOSUPPORT','EADDRNOTAVAIL'].includes(error.code)));
      srv.once('listening', () => srv.close(() => resolve(true)));
      try { srv.listen({port, host, exclusive:true}); } catch { resolve(false); }
    });
    if (!free) return false;
  }
  return true;
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
async function waitHealthy(url, { timeout = 60000, interval = 250, log, check = () => {} }) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    check();
    let t;
    try {
      const ctrl = new AbortController();
      t = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
      clearTimeout(t);
      // 2xx/3xx 都算就绪；404 也算 server 起来了（首页路由可能不对，但 server OK）
      const healthy = res.status < 500;
      await res.body?.cancel();
      if (healthy) return true;
    } catch {} finally { clearTimeout(t); }
    check();
    await sleep(interval);
  }
  throw new Error(`健康检查超时：${url}`);
}

// 启动静态项目的内嵌预览 server。
// findFreePort 已同时检查 IPv4+IPv6（vite 只绑 IPv6 的坑已堵），用它预选空闲端口；
// 万一预选后 listen 仍 EADDRINUSE（竞态），顺延重试。
async function startStatic(project, portRange, log, state) {
  let port = await findFreePort(portRange[0], portRange[1], project.port);
  let lastErr = null;
  for (let attempt = port; attempt <= portRange[1]; attempt = await findFreePort(attempt + 1, portRange[1])) {
    try {
      const { server, baseUrl } = await createPreviewServer({
        root: project.path, projectName: project.name, port: attempt,
        routeAliases: project.routeAliases || {}, onLog: log
      });
      state.server = server;
      if (state.cancelled) throw new Error("启动已取消");
      const navUrl = `${baseUrl}/__nav__`;
      const homeUrl = `${baseUrl}/`;
      await waitHealthy(homeUrl, { timeout: 15000, log, check: () => {
        if (state.cancelled) throw new Error('启动已取消');
      } });
      return { kind: 'static', server, proc: null, port: attempt, baseUrl, homeUrl, navUrl, startedAt: Date.now() };
    } catch (e) {
      lastErr = e;
      if (e && (e.code === 'EADDRINUSE' || /EADDRINUSE/.test(e.message))) {
        log(`端口 ${attempt} 被占用（竞态），顺延`);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`端口启动失败：${lastErr ? lastErr.message : '未知'}`);
}

// 把用户配置的启动命令 + 指定端口，拼成正确的参数数组。
// npm 需要 -- 转发脚本参数；pnpm/yarn/npx 直接转发。只有 Vite 支持 strictPort。
function buildFrameworkArgs(cmd, port, type = "vite") {
  const parts = cmd.split(/\s+/).filter(Boolean);
  const bin = parts[0];
  const args = parts.slice(1);
  if (type === 'react-scripts') return args;
  const portArgs = ['--port', String(port), ...(type === 'vite' ? ['--strictPort'] : [])];
  // npm run <script> 需要用 -- 转发参数给脚本
  if (bin === 'npm' && !args.includes('--')) {
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
async function startFramework(project, portRange, log, options = {}, state) {
  const preferPort = await findFreePort(portRange[0], portRange[1], project.port);
  const cmd = project.startCommand || 'npm run dev';
  const bin = cmd.split(/\s+/)[0];
  const args = buildFrameworkArgs(cmd, preferPort, project.type || "generic-dev");
  log(`启动命令：${bin} ${args.join(' ')}`);

  // 拼 PATH：.app 双击时默认 PATH 极短，不含 nvm/volta。把探测到的 node binDir 放最前。
  // 关键兜底：调用方（如控制接口 /start）没传 nodeBinDir 时，这里自己探测——
  // 否则 PATH 里没有 npm，spawn 秒退，健康检查超时（真实踩坑：HTTP 接口启动失败而 UI 启动正常）。
  if (!options.nodeBinDir) {
    const node = detectNode();
    if (!node) {
      throw new Error('未检测到系统 Node.js。框架项目（vite/next 等）需要本机安装 Node.js 才能启动。请到 https://nodejs.org 安装后重试。');
    }
    log(`[node] 自动探测：${node.version || '(版本未知)'} @ ${node.path}`);
    options = { ...options, nodeBinDir: node.binDir };
  }
  const env = buildEnvironment(process.env, options.nodeBinDir);
  env.PORT = String(preferPort);
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = path.join(project.path, 'node_modules', '.bin') + path.delimiter + env[pathKey];
  // Preserve the user's command quoting. Only append generated numeric port options.
  const originalArgs = cmd.split(/\s+/).filter(Boolean).slice(1);
  const appended = args.slice(originalArgs.length);
  const command = cmd + (appended.length ? ' ' + appended.join(' ') : '');
  if (state.cancelled) throw new Error('启动已取消');
  const proc = spawn(command, [], {
    cwd: project.path, env, shell: true, detached: process.platform !== 'win32',
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  state.proc = proc;
  let processError = null;
  proc.on('error', error => { processError = error; });
  const checkProcess = () => {
    if (state.cancelled) throw new Error('启动已取消');
    if (processError) throw processError;
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`启动进程已退出（code=${proc.exitCode}, signal=${proc.signalCode}）`);
  };

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
    buffer = (buffer + s).slice(-32768);
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

  // Probe the chosen port immediately; output matching is a fallback, not a 90s gate.
  const deadline = Date.now() + 60000;
  let port = preferPort;
  while (true) {
    checkProcess();
    port = realPort ? parseInt(realPort, 10) : preferPort;
    try {
      await waitHealthy(`http://127.0.0.1:${port}/`, {timeout:1000, interval:150, log, check:checkProcess});
      break;
    } catch (error) {
      checkProcess();
      if (Date.now() >= deadline) throw error;
    }
  }
  checkProcess();
  const homeUrl = `http://127.0.0.1:${port}/`;
  flushLogs(true);

  const baseUrl = `http://127.0.0.1:${port}`;
  // 框架项目：额外起一个开发导航 server（扫 src/router），让目录页能点进各路由
  let navServer = null;
  let navUrl = homeUrl;
  try {
    navServer = await createDevNavServer({
      projectRoot: project.path, projectName: project.name, devBaseUrl: baseUrl, onLog: log,
      tokenConfig: project.tokenConfig || null,
      onSaveConfig: options.onSaveConfig // main 提供，写回 store
    });
    state.server = navServer.server;
    navUrl = navServer.navUrl;
  } catch (e) { log(`[nav] 启动失败（忽略，降级为首页）：${e.message}`); }

  // 后端依赖探测：dev server 活着 ≠ 项目可用。proxy 目标挂了页面会白屏/登录失败，
  // 健康检查看不见，这里显式探测并警告（不阻止启动）。
  let backendWarnings = [];
  try {
    const results = await checkProjectBackends(project.path, log);
    // excused = 已交叉验证 API 基址直连可达，代理不可达不影响接口，不再算警告
    backendWarnings = results.filter(r => !r.ok && !r.excused).map(r =>
      `后端不可达 ${r.target}（${r.detail}，来自${r.source}）：页面能打开但接口会失败。请启动本地后端，或在 .env.development.local 里把代理目标指到可用环境`);
  } catch {}

  checkProcess();
  return {
    kind: 'framework', server: navServer ? navServer.server : null, proc, port, baseUrl,
    homeUrl, navUrl, startedAt: Date.now(), backendWarnings
  };
}

function buildEnvironment(source, nodeBinDir, platform = process.platform) {
  const env = {...source};
  delete env.ELECTRON_RUN_AS_NODE;
  const pathKey = platform === 'win32' ? (Object.keys(env).find(k => k.toLowerCase() === 'path') || 'Path') : 'PATH';
  const extra = [nodeBinDir, ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])].filter(Boolean);
  env[pathKey] = [...extra, env[pathKey] || ''].join(platform === 'win32' ? ';' : ':');
  if (platform === 'win32') for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path' && key !== pathKey) delete env[key];
  }
  return env;
}

function disposeInstance(inst) {
  if (inst.server) { try { inst.server.closeAllConnections?.(); inst.server.close(); } catch {} }
  if (!inst.proc || !inst.proc.pid) return;
  const proc = inst.proc;
  if (process.platform === 'win32') {
    // Windows has no POSIX process groups; taskkill /T includes npm/cmd grandchildren.
    try { execFileSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {windowsHide:true, stdio:'ignore', timeout:5000}); } catch {}
  } else {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { try { proc.kill('SIGTERM'); } catch {} }
    const timer = setTimeout(() => {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    }, 1500);
    timer.unref();
  }
}

function startProject(project, portRange, log = () => {}, options = {}) {
  if (starting.has(project.id)) return starting.get(project.id).promise;
  if (instances.has(project.id)) return Promise.resolve({ok:true,instance:instances.get(project.id),already:true});
  const state = {cancelled:false, proc:null, server:null};
  // Defer actual work so the pending state exists before any async operation starts.
  state.promise = Promise.resolve().then(async () => {
    try {
      if (state.cancelled) throw new Error('启动已取消');
      const inst = project.framework
        ? await startFramework(project, portRange, log, options, state)
        : await startStatic(project, portRange, log, state);
      if (state.cancelled) throw new Error('启动已取消');
      instances.set(project.id, inst);
      if (inst.proc) inst.proc.once('exit', () => {
        if (instances.get(project.id) === inst) {
          instances.delete(project.id);
          disposeInstance(inst);
        }
      });
      return {ok:true,instance:inst};
    } catch (error) {
      disposeInstance(state);
      log(`[start] 失败: ${error.message}`);
      return {ok:false,error:error.message};
    } finally {
      if (starting.get(project.id) === state) starting.delete(project.id);
    }
  });
  starting.set(project.id, state);
  return state.promise;
}

function stopProject(projectId, log = () => {}) {
  const pending = starting.get(projectId);
  if (pending) { pending.cancelled = true; disposeInstance(pending); }
  const inst = instances.get(projectId);
  if (inst) { instances.delete(projectId); disposeInstance(inst); }
  return {ok:true,already:!inst && !pending};
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
      startedAt: inst.startedAt,
      backendWarnings: inst.backendWarnings || []
    });
  }
  return out;
}

function stopAll() {
  for (const pid of new Set([...instances.keys(), ...starting.keys()])) stopProject(pid);
}

module.exports = { startProject, stopProject, getStatus, stopAll, isPortFree, findFreePort, buildFrameworkArgs, extractPortFromOutput, buildEnvironment };
