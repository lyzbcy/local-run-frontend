// 使用真实 Electron 主进程、preload、UI；所有数据写临时目录。
const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrf-smoke-'));
app.setVersion(require('../package.json').version);
app.setPath('appData', tmp);
app.setPath('userData', path.join(tmp, 'electron'));
shell.openExternal = async () => {}; // 不在 CI 打开系统浏览器。
const errors = [];
app.on('web-contents-created', (_, contents) => {
  contents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  contents.on('render-process-gone', (_, details) => errors.push(JSON.stringify(details)));
});
const deadline = setTimeout(() => { console.error('Smoke timeout'); app.exit(1); }, 60000);
const packaged = process.argv.includes('--packaged');
const packageRoot = process.platform === 'darwin'
  ? path.resolve('release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', '本地运行前端项目.app/Contents/Resources/app.asar')
  : path.resolve('release/win-unpacked/resources/app.asar');
require(packaged ? path.join(packageRoot, 'src/main/main.js') : '../src/main/main');
app.whenReady().then(async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript('!!document.getElementById("version")?.textContent').catch(() => false)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const version = await win.webContents.executeJavaScript('document.getElementById("version").textContent');
    assert.ok(version.startsWith('v'), 'Renderer initialized through preload');
    const projectPath = path.join(tmp, '中文 project');
    fs.mkdirSync(projectPath);
    fs.writeFileSync(path.join(projectPath, 'index.html'), '<title>Smoke preview</title>smoke-ready');
    const payload = JSON.stringify({ projectPath, name: '中文预览 Smoke', type: 'static', framework: false });
    const added = await win.webContents.executeJavaScript(`window.api.addProject(${payload})`);
    const id = JSON.stringify(added.project.id);
    const started = await win.webContents.executeJavaScript(`window.api.startProject(${id})`);
    assert.equal(started.ok, true, started.error);
    const response = await fetch(started.instance.homeUrl);
    assert.match(await response.text(), /smoke-ready/);
    const nav = await fetch(started.instance.navUrl);
    assert.equal(nav.status, 200);
    await win.webContents.executeJavaScript('refreshStore().then(() => render())');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".card").length'), 1);
    const out = path.resolve('release', `smoke-${process.platform}-${process.arch}.png`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript(`window.api.stopProject(${id})`);
    assert.equal((await win.webContents.executeJavaScript('window.api.runnerStatus()')).length, 0);
    await win.webContents.executeJavaScript(`window.api.removeProject({id:${id}})`);
    assert.deepEqual(errors, []);
    console.log(`SMOKE PASS ${process.platform}/${process.arch}: UI, preload, add/start/preview/nav/stop/remove; ${out}`);
    clearTimeout(deadline);
    app.quit();
  } catch (e) { console.error(e); app.exit(1); }
});
app.on('will-quit', () => { fs.rmSync(tmp, { recursive: true, force: true }); });
