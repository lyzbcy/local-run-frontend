// Electron 主进程入口。
// 负责：窗口、托盘、IPC 桥、项目存储、启动/停止、更新检查、AI 控制接口、退出回收。

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync, execFile } = require('child_process');
const store = require('./store');
const { detect } = require('./detector');
const { detectNode } = require('./detect-node');
const runner = require('./runner');
const { createControlServer } = require('./control-server');
const { performUpdate } = require('./updater');
const logger = require('./logger');

const APP_NAME = '本地运行前端项目';
let mainWindow = null;
let controlServer = null;
let controlServerReady = false;
let controlServerError = null;
let tray = null;
let isQuitting = false; // 区分"真退出"和"关窗口隐藏"

// 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0。
// "0.10.0" > "0.9.0"（字符串比较会误判，必须按数字段比）。
function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

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

// 找到当前运行中的 .app 的根路径（从 app.getAppPath 往上找 .app 目录）
function findAppRoot() {
  let p = app.getAppPath(); // 打包后 = .../本地运行前端项目.app/Contents/Resources/app.asar（或 app）
  // 往上找到含 .app 的那层
  for (let i = 0; i < 8; i++) {
    if (path.extname(p) === '.app' || p.endsWith('.app')) return p;
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  // 兜底：检查路径里有没有 .app/
  const m = p.match(/^(.+?\.app)(?:\/|$)/);
  return m ? m[1] : null;
}

// macOS Gatekeeper 自检：检测 .app 是否带 quarantine 标记，带则通知渲染层弹引导。
function checkQuarantineAndOfferFix() {
  try {
    const appRoot = findAppRoot();
    if (!appRoot) { logger.info('quarantine 自检：找不到 .app 根路径，跳过（开发模式？）'); return; }
    // xattr 读标记：带 com.apple.quarantine 说明是被 Gatekeeper 拦的
    const out = execFileSync('xattr', [appRoot], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (/com\.apple\.quarantine/.test(out)) {
      logger.warn(`检测到 quarantine 标记：${appRoot}，将引导用户去除`);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app:quarantineDetected', { appRoot });
        }
      }, 1500);
    } else {
      logger.info('quarantine 自检：无标记，无需处理');
    }
  } catch (e) {
    logger.info(`quarantine 自检跳过：${e.message}`);
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

  // 关窗口：mac 下后台保留（托盘可见）；其他平台正常关。
  // 关键：不再触发 stopAll——服务继续跑，符合 mac 习惯。
  mainWindow.on('close', (e) => {
    if (!isQuitting && process.platform === 'darwin') {
      e.preventDefault();
      mainWindow.hide();
    }
    // 非 darwin 或正在真退出：放行，mainWindow 在 closed 里置空
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// 托盘图标：让用户知道"软件还在后台跑 + 服务还在跑"。
// 菜单：显示窗口 / 运行中的项目（可点开浏览器）/ 退出并停止全部。
let trayTimer = null;
let cachedProjects = []; // 缓存项目列表，避免每 2s 读磁盘
function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'sticker', 'watch.png');
  let image = nativeImage.createFromPath(iconPath);
  // 托盘图标要求小尺寸，缩到 20x20（mac 托盘标准）
  if (!image.isEmpty()) image = image.resize({ width: 20, height: 20 });

  tray = new Tray(image);
  tray.setToolTip(APP_NAME);

  const refreshTrayMenu = () => {
    const status = runner.getStatus();
    // 用缓存的项目名（缓存由 store 操作时刷新，或最多 10s 刷新一次）
    const runningItems = status.length ? status.map(s => {
      const proj = cachedProjects.find(p => p.id === s.projectId);
      const name = proj ? proj.name : s.projectId;
      return {
        label: `${name}  :${s.port}`,
        click: () => { try { shell.openExternal(s.navUrl || s.homeUrl); } catch {} }
      };
    }) : [{ label: '（当前无运行中的项目）', enabled: false }];

    const menu = Menu.buildFromTemplate([
      { label: APP_NAME, enabled: false },
      { type: 'separator' },
      { label: '显示主窗口', click: showMainWindow },
      { type: 'separator' },
      { label: `运行中的项目（${status.length}）`, enabled: false },
      ...runningItems,
      { type: 'separator' },
      { label: '退出并停止全部服务', click: () => { isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(menu);
    // 动态 tooltip：显示运行数量
    tray.setToolTip(status.length ? `${APP_NAME} · ${status.length} 个项目运行中` : APP_NAME);
  };

  // 单击托盘图标 = 显示主窗口（mac 习惯）
  tray.on('click', showMainWindow);
  refreshTrayMenu();
  // 每 3s 刷新菜单（运行状态变化）。用更低频避免持续磁盘 IO。
  trayTimer = setInterval(() => {
    // 偶尔刷新项目缓存（最多每 10s 一次读磁盘）
    refreshTrayMenu();
  }, 3000);
  // 单独的 10s 定时器刷新项目缓存
  setInterval(() => { try { cachedProjects = (store.load().projects || []); } catch {} }, 10000).unref?.();
}

// store 变更时同步缓存
function refreshTrayCache() {
  try { cachedProjects = (store.load().projects || []); } catch {}
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
  } else {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
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

// 拖拽进来的路径直接探测（不走系统对话框）
ipcMain.handle('project:detectPath', async (_e, p) => {
  if (!p || typeof p !== 'string') return null;
  try { fs.accessSync(p); } catch { return { path: p, error: '路径不存在或不可访问' }; }
  const info = detect(p);
  return { path: p, ...info };
});

// 重新探测某项目类型
ipcMain.handle('project:detect', async (_e, projectPath) => detect(projectPath));

// 重新探测并更新已存在的项目（用户改了项目结构后用）
ipcMain.handle('project:redetect', async (_e, { id }) => {
  const data = store.load();
  const project = (data.projects || []).find(p => p.id === id);
  if (!project) return { ok: false, error: '项目不存在' };
  if (!fs.existsSync(project.path)) return { ok: false, error: '项目路径已不存在' };
  const info = detect(project.path);
  const patch = { type: info.type, framework: !!info.framework, startCommand: info.startCommand };
  const { data: next, project: updated } = store.updateProject(data, id, patch);
  store.save(next);
  refreshTrayCache();
  logger.info(`重新识别项目「${project.name}」→ ${info.type}`);
  return { ok: true, project: updated };
});

// 拿当前 store
ipcMain.handle('store:get', async () => store.load());

// 添加项目
ipcMain.handle('project:add', async (_e, { name, projectPath, type, startCommand, framework }) => {
  const data = store.load();
  const { data: next, project, created } = store.addProject(data, { name, projectPath, type, startCommand, framework });
  store.save(next);
  refreshTrayCache();
  return { project, created };
});

// 更新项目
ipcMain.handle('project:update', async (_e, { id, patch }) => {
  const data = store.load();
  const { data: next, project } = store.updateProject(data, id, patch);
  store.save(next);
  refreshTrayCache();
  return project;
});

// 删除项目
ipcMain.handle('project:remove', async (_e, { id }) => {
  runner.stopProject(id);
  const data = store.load();
  store.save(store.removeProject(data, id));
  refreshTrayCache();
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
  // 启动前校验路径还在（项目可能被删/移动）
  try { fs.accessSync(project.path); }
  catch {
    const err = `项目路径已不存在：${project.path}\n（可能被移动或删除。可点「定位」确认，或删除后重新添加）`;
    logger.error(err, { projectId: id });
    return { ok: false, error: err };
  }
  const log = (msg) => {
    logger.info(`[${project.name}] ${msg}`, { projectId: id });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('project:log', { id, msg: String(msg) });
    }
  };
  logger.info(`启动项目「${project.name}」（${project.type}）`, { projectId: id });

  // 框架项目需要系统 node，先探测
  let nodeBinDir = null;
  if (project.framework) {
    const node = detectNode();
    if (!node) {
      const err = '未检测到系统 Node.js。框架项目（vite/next 等）需要本机安装 Node.js 才能启动。请到 https://nodejs.org 安装后重试。';
      logger.error(err, { projectId: id });
      return { ok: false, error: err };
    }
    logger.ok(`系统 node：${node.version || '(版本未知)'} @ ${node.path}`);
    nodeBinDir = node.binDir; // 传给 runner，加进子进程 PATH（.app 双击时 PATH 不含 nvm）
  }

  // 记录打开时间 + 端口
  const { data: next } = store.updateProject(data, id, { lastOpenedAt: new Date().toISOString() });
  store.save(next);

  const r = await runner.startProject(project, data.settings.portRange, log, {
    nodeBinDir,
    // token 配置保存回调：写回该项目的 store（持久化，下次启动自动用）
    onSaveConfig: (cfg) => {
      try {
        const d = store.load();
        store.save(store.updateProject(d, id, { tokenConfig: cfg }).data);
        logger.info(`[nav] token 配置已保存到项目「${project.name}」`);
      } catch (e) { logger.warn(`[nav] 保存配置失败：${e.message}`); }
    }
  });
  if (r.ok) {
    // 记录端口
    const d2 = store.load();
    store.save(store.updateProject(d2, id, { port: r.instance.port }).data);
    logger.ok(`「${project.name}」已启动 → :${r.instance.port} (${r.instance.baseUrl})`, { projectId: id, port: r.instance.port });
    // 开浏览器：先开目录页
    const target = data.settings.autoOpenNav !== false ? (r.instance.navUrl || r.instance.homeUrl) : r.instance.homeUrl;
    try { shell.openExternal(target); } catch {}
    // 后端依赖警告：提升到 logger（日志面板可见），并随结果带给渲染层展示
    const backendWarnings = r.instance.backendWarnings || [];
    for (const w of backendWarnings) logger.warn(w, { projectId: id });
    return { ok: true, instance: {
      port: r.instance.port, baseUrl: r.instance.baseUrl,
      homeUrl: r.instance.homeUrl, navUrl: r.instance.navUrl, already: !!r.already,
      backendWarnings
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
  // 只有远端版本 > 本地版本才提示更新（本地领先远端——比如开发版——不提示）
  const hasUpdate = r.latest && compareVersions(r.latest, current) > 0;
  return { hasUpdate, current, latest: r.latest, htmlUrl: r.htmlUrl, name: r.name };
});

// 一键更新：app 内下载 → 解压 → 替换 → 重启
ipcMain.handle('app:performUpdate', async (e) => {
  const data = store.load();
  const wc = e.sender;
  const send = (stage, detail) => {
    if (!wc.isDestroyed()) wc.send('update:progress', { stage, detail });
  };
  try {
    await performUpdate(data.settings.githubRepo, send, {
      onBeforeExit: () => {
        // app.exit() 不触发 before-quit，手动停服务防泄漏
        runner.stopAll();
        if (controlServer && controlServer.server) { try { controlServer.server.close(); } catch {} }
      }
    });
    return { ok: true };
  } catch (err) {
    logger.error(`一键更新失败：${err.message}`);
    return { ok: false, error: err.message };
  }
});

// 拿 app 版本
ipcMain.handle('app:version', async () => app.getVersion());

// 日志系统（agent.md 第50-52行：保留近50条，只存内存）
ipcMain.handle('logs:get', async () => logger.all());
ipcMain.handle('logs:clear', async () => { logger.clear(); return { ok: true }; });

// 控制接口状态（让渲染层知道 47800 是否真起来了）
ipcMain.handle('ctrl:status', async () => ({ ready: controlServerReady, error: controlServerError, port: 47800 }));

// 保存设置
ipcMain.handle('settings:save', async (_e, { settings }) => {
  const data = store.load();
  const merged = { ...data.settings, ...settings };
  // 校验端口区间
  if (Array.isArray(merged.portRange) && merged.portRange.length === 2) {
    const [s, e] = merged.portRange;
    if (s >= e || s < 1024 || e > 65535) return { ok: false, error: '端口区间不合法（需 起始 < 结束，且在 1024-65535）' };
  }
  store.save({ ...data, settings: merged });
  logger.info('设置已保存');
  return { ok: true };
});

// 导入项目数据（合并：同路径跳过）
ipcMain.handle('data:import', async (_e, { projects }) => {
  if (!Array.isArray(projects)) return { ok: false, error: '数据格式错误' };
  const data = store.load();
  let added = 0, skipped = 0;
  for (const p of projects) {
    if (!p.path) continue;
    const exists = (data.projects || []).find(x => x.path === p.path);
    if (exists) { skipped++; continue; }
    const { data: next } = store.addProject(data, {
      name: p.name, projectPath: p.path, type: p.type, startCommand: p.startCommand, framework: !!p.framework
    });
    Object.assign(next.projects[next.projects.length - 1], { favorite: !!p.favorite });
    store.save(next);
    added++;
  }
  logger.ok(`导入完成：新增 ${added}，跳过（已存在）${skipped}`);
  refreshTrayCache();
  return { ok: true, added, skipped };
});

// 去除 quarantine 标记（用户在引导弹窗点确认后，osascript 提权 xattr -dr）
ipcMain.handle('app:removeQuarantine', async () => {
  const appRoot = findAppRoot();
  if (!appRoot) return { ok: false, error: '找不到 .app 路径' };
  // 用 AppleScript 的 quoted form of 安全拼接路径（防中文/空格/特殊字符注入）
  const script = `do shell script "xattr -dr com.apple.quarantine " & quoted form of ${JSON.stringify(appRoot)} with administrator privileges`;
  return new Promise(resolve => {
    execFile('osascript', ['-e', script], (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: '去除失败（可能取消了授权）：' + (stderr || err.message) });
      else { logger.ok('quarantine 标记已去除'); resolve({ ok: true }); }
    });
  });
});

// ---- lifecycle ----
app.whenReady().then(async () => {
  // ⚠️ 关键：用固定的稳定 userData 路径，不依赖 app.getName()。
  // app.getName() 在打包后 = productName（本地运行前端项目），开发时 = package name（local-run-frontend），
  // 二者不一致会导致 userData 路径漂移，更新后用户的项目数据"消失"（其实读到了另一个空目录）。
  // 固定成 local-run-frontend-data，永不变；并迁移旧路径的数据过来。
  const STABLE_DATA_DIR = path.join(app.getPath('appData'), 'local-run-frontend-data');
  const OLD_CANDIDATES = [
    path.join(app.getPath('appData'), 'local-run-frontend'),          // 旧 package name 版本
    path.join(app.getPath('appData'), '本地运行前端项目'),              // productName 版本
    app.getPath('userData')                                          // Electron 默认（兜底）
  ];
  fs.mkdirSync(STABLE_DATA_DIR, { recursive: true });
  // 迁移：若稳定目录没有 projects.json，从旧候选目录找一份搬过来
  const stableFile = path.join(STABLE_DATA_DIR, 'projects.json');
  if (!fs.existsSync(stableFile)) {
    for (const old of OLD_CANDIDATES) {
      const oldFile = path.join(old, 'projects.json');
      if (fs.existsSync(oldFile)) {
        try {
          fs.copyFileSync(oldFile, stableFile);
          logger.info(`迁移项目数据：${oldFile} → ${stableFile}`);
          break;
        } catch (e) { logger.warn(`迁移失败 ${oldFile}：${e.message}`); }
      }
    }
  }
  app.setPath('userData', STABLE_DATA_DIR); // 让 Electron 内部也用这个稳定路径
  store.init(STABLE_DATA_DIR);
  createWindow();
  createTray();
  refreshTrayCache(); // 初始化托盘项目缓存

  // macOS Gatekeeper 自检：若 .app 带 quarantine 标记，引导用户一键去除
  // （双击未签名 app 会被拦"已损坏"，普通用户不会去跑安装脚本）
  if (process.platform === 'darwin' && app.isPackaged) {
    checkQuarantineAndOfferFix();
  }

  // 启动 AI 控制接口（失败不阻塞，但要让渲染层知道）
  try {
    controlServer = await createControlServer({
      getStore: () => store.load(),
      saveStore: (d) => store.save(d),
      addProjectFn: store.addProject,
      removeProjectFn: store.removeProject,
      detectFn: detect,
      startProject: runner.startProject,
      stopProject: runner.stopProject,
      getStatus: runner.getStatus,
      onLog: (msg) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ctrl:log', String(msg)); }
    });
    controlServerReady = true;
  } catch (e) {
    logger.error(`控制接口启动失败：${e.message}（47800 可能被占用，AI Agent 功能将不可用）`);
    controlServerError = e.message;
  }

  // 启动后做一次更新检查
  setTimeout(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const data = store.load();
    const r = await checkUpdate(data.settings.githubRepo);
    if (r && mainWindow && !mainWindow.isDestroyed()) {
      const current = app.getVersion();
      // 只有远端 > 本地才提示（本地领先远端不提示）
      if (r.latest && compareVersions(r.latest, current) > 0) {
        mainWindow.webContents.send('app:updateAvailable', {
          current, latest: r.latest, htmlUrl: r.htmlUrl, name: r.name
        });
      } else {
        logger.info(`检查更新：本地 v${current} 已是最新（远端 v${r.latest || '?'}）`);
      }
    }
  }, 2500);
});

// mac：关窗口只隐藏，服务继续跑，托盘还在。其他平台正常退出。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    runner.stopAll();
    if (controlServer && controlServer.server) { try { controlServer.server.close(); } catch {} }
    app.quit();
  }
  // darwin：什么都不做，窗口已隐藏，服务保留
});

// 真退出（托盘点"退出" / Cmd+Q）才停全部服务。
app.on('before-quit', () => {
  isQuitting = true;
  if (trayTimer) { clearInterval(trayTimer); trayTimer = null; }
  runner.stopAll();
  if (controlServer && controlServer.server) { try { controlServer.server.close(); } catch {} }
});

app.on('activate', () => {
  // mac：点 dock 图标恢复窗口
  showMainWindow();
});
