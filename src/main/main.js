// Electron 主进程入口。
// 负责：窗口、IPC 桥、项目存储、启动/停止、更新检查、AI 控制接口、退出回收。

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const store = require('./store');
const { detect } = require('./detector');
const runner = require('./runner');
const { createControlServer } = require('./control-server');
const logger = require('./logger');

const APP_NAME = '本地运行前端项目';
let mainWindow = null;
let controlServer = null;

// 更新检查（容错：失败静默）
async function checkUpdate(repo) {
  try {
    logger.info(`检查更新：拉取 ${repo} 最新 release`);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'local-run-frontend' },
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!res.ok) {
      logger.warn(`检查更新：GitHub 返回 ${res.status}（可能还没有 release）`);
      return null;
    }
    const j = await res.json();
    const info = { latest: (j.tag_name || '').replace(/^v/, ''), htmlUrl: j.html_url, name: j.name };
    logger.info(`检查更新：远端最新 v${info.latest}`);
    return info;
  } catch (e) {
    logger.warn(`检查更新失败：${e.message}`);
    return null;
  }
}

// 探测系统 node 版本（框架项目启动需要）。缺失返回 null。
function detectNode() {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which',
      ['node'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!out) return null;
    // 顺带拿版本
    try {
      const ver = execFileSync(out, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim();
      return { path: out.split(/\r?\n/)[0], version: ver };
    } catch {
      return { path: out.split(/\r?\n/)[0], version: null };
    }
  } catch {
    return null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 880,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#f5f7fa',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---- IPC handlers ----

// 读目录选择
ipcMain.handle('dialog:openDirectory', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  const info = detect(p);
  return { path: p, ...info };
});

// 重新探测某项目类型
ipcMain.handle('project:detect', async (_e, projectPath) => detect(projectPath));

// 拿当前 store
ipcMain.handle('store:get', async () => store.load());

// 添加项目
ipcMain.handle('project:add', async (_e, { name, projectPath, type, startCommand, framework }) => {
  const data = store.load();
  const { data: next, project, created } = store.addProject(data, { name, projectPath, type, startCommand, framework });
  store.save(next);
  return { project, created };
});

// 更新项目
ipcMain.handle('project:update', async (_e, { id, patch }) => {
  const data = store.load();
  const { data: next, project } = store.updateProject(data, id, patch);
  store.save(next);
  return project;
});

// 删除项目
ipcMain.handle('project:remove', async (_e, { id }) => {
  runner.stopProject(id);
  const data = store.load();
  store.save(store.removeProject(data, id));
  return { ok: true };
});

// 在 Finder 中打开
ipcMain.handle('project:reveal', async (_e, { projectPath }) => {
  shell.showItemInFolder(projectPath);
  return { ok: true };
});

// 启动项目
ipcMain.handle('project:start', async (e, { id }) => {
  const data = store.load();
  const project = (data.projects || []).find(p => p.id === id);
  if (!project) return { ok: false, error: '项目不存在' };
  const log = (msg) => {
    logger.info(`[${project.name}] ${msg}`, { projectId: id });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('project:log', { id, msg: String(msg) });
    }
  };
  logger.info(`启动项目「${project.name}」（${project.type}）`, { projectId: id });

  // 框架项目需要系统 node，先探测
  if (project.framework) {
    const node = detectNode();
    if (!node) {
      const err = '未检测到系统 Node.js。框架项目（vite/next 等）需要本机安装 Node.js 才能启动。请到 https://nodejs.org 安装后重试。';
      logger.error(err, { projectId: id });
      return { ok: false, error: err };
    }
    logger.ok(`系统 node：${node.version || '(版本未知)'} @ ${node.path}`);
  }

  // 记录打开时间 + 端口
  const { data: next } = store.updateProject(data, id, { lastOpenedAt: new Date().toISOString() });
  store.save(next);

  const r = await runner.startProject(project, data.settings.portRange, log);
  if (r.ok) {
    // 记录端口
    const d2 = store.load();
    store.save(store.updateProject(d2, id, { port: r.instance.port }).data);
    logger.ok(`「${project.name}」已启动 → :${r.instance.port} (${r.instance.baseUrl})`, { projectId: id, port: r.instance.port });
    // 开浏览器：先开目录页
    const target = data.settings.autoOpenNav !== false ? (r.instance.navUrl || r.instance.homeUrl) : r.instance.homeUrl;
    try { shell.openExternal(target); } catch {}
    return { ok: true, instance: {
      port: r.instance.port, baseUrl: r.instance.baseUrl,
      homeUrl: r.instance.homeUrl, navUrl: r.instance.navUrl, already: !!r.already
    }};
  }
  logger.error(`「${project.name}」启动失败：${r.error}`, { projectId: id });
  return { ok: false, error: r.error };
});

// 停止项目
ipcMain.handle('project:stop', async (_e, { id }) => {
  const data = store.load();
  const project = (data.projects || []).find(p => p.id === id);
  logger.info(`停止项目「${project ? project.name : id}」`, { projectId: id });
  runner.stopProject(id, (msg) => logger.info(`[stop] ${msg}`));
  return { ok: true };
});

// 运行状态
ipcMain.handle('runner:status', async () => runner.getStatus());

// 打开某 url（用于端口管理面板"打开"按钮）
ipcMain.handle('shell:openExternal', async (_e, { url }) => {
  shell.openExternal(url);
  return { ok: true };
});

// 更新检查
ipcMain.handle('app:checkUpdate', async () => {
  const data = store.load();
  const r = await checkUpdate(data.settings.githubRepo);
  if (!r) return { hasUpdate: false };
  const current = app.getVersion();
  const hasUpdate = r.latest && r.latest !== current;
  return { hasUpdate, current, latest: r.latest, htmlUrl: r.htmlUrl, name: r.name };
});

// 拿 app 版本
ipcMain.handle('app:version', async () => app.getVersion());

// 日志系统（agent.md 第50-52行：保留近50条，只存内存）
ipcMain.handle('logs:get', async () => logger.all());
ipcMain.handle('logs:clear', async () => { logger.clear(); return { ok: true }; });

// ---- lifecycle ----
app.whenReady().then(async () => {
  store.init(app.getPath('userData'));
  createWindow();

  // 启动 AI 控制接口（失败不阻塞）
  try {
    controlServer = await createControlServer({
      getStore: () => store.load(),
      startProject: runner.startProject,
      stopProject: runner.stopProject,
      getStatus: runner.getStatus,
      onLog: (msg) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ctrl:log', String(msg)); }
    });
  } catch (e) {
    console.error('控制接口启动失败：', e.message);
  }

  // 启动后做一次更新检查
  setTimeout(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const data = store.load();
    const r = await checkUpdate(data.settings.githubRepo);
    if (r && mainWindow && !mainWindow.isDestroyed()) {
      const current = app.getVersion();
      if (r.latest && r.latest !== current) {
        mainWindow.webContents.send('app:updateAvailable', {
          current, latest: r.latest, htmlUrl: r.htmlUrl, name: r.name
        });
      }
    }
  }, 2500);
});

app.on('window-all-closed', () => {
  runner.stopAll();
  if (controlServer && controlServer.server) { try { controlServer.server.close(); } catch {} }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  runner.stopAll();
  if (controlServer && controlServer.server) { try { controlServer.server.close(); } catch {} }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
