// CI-only: install/extract shipped package, launch real executable, exercise preload via CDP.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const assert = require('assert/strict');
const { version } = require('../package.json');
if (!process.env.CI) throw new Error('Native installer smoke test must run in an isolated CI machine');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrf-native-'));
const releaseDir = path.resolve('release');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, socket;
async function run(exe, args) {
  const p = spawn(exe, args, { stdio: 'inherit' });
  await new Promise((resolve, reject) => { p.once('error', reject); p.once('exit', code => code === 0 ? resolve() : reject(Error(`Installer exited ${code}`))); });
}
(async () => {
  let executable;
  if (process.platform === 'win32') {
    const installDir = path.join(tmp, 'installed');
    await run(path.join(releaseDir, `local-run-frontend-v${version}-win-x64-setup.exe`), ['/S', `/D=${installDir}`]);
    executable = path.join(installDir, '本地运行前端项目.exe');
  } else {
    execFileSync('/usr/bin/ditto', ['-x', '-k', path.join(releaseDir, `local-run-frontend-v${version}-mac-${process.arch}.zip`), tmp]);
    assert.ok(fs.existsSync(path.join(tmp, '一键安装.command')));
    assert.ok(fs.existsSync(path.join(tmp, 'install-mac.sh')));
    executable = path.join(tmp, '本地运行前端项目.app/Contents/MacOS/本地运行前端项目');
  }
  assert.ok(fs.existsSync(executable), `Installed executable missing: ${executable}`);
  child = spawn(executable, ['--remote-debugging-port=19223'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
  child.on('error', error => { logs += error.message; });
  let target;
  for (let i = 0; i < 150; i++) {
    try { target = (await (await fetch('http://127.0.0.1:19223/json/list')).json()).find(t => t.type === 'page' && t.url.includes('index.html')); } catch {}
    if (target) break;
    if (child.exitCode !== null) throw Error(`Application exited ${child.exitCode}\n${logs}`);
    await delay(200);
  }
  assert.ok(target, `Application window not ready\n${logs}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    const job = pending.get(msg.id);
    if (job) { pending.delete(msg.id); msg.error ? job.reject(Error(JSON.stringify(msg.error))) : job.resolve(msg.result); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await call('Runtime.enable');
  assert.equal(await evaluate('window.api.appVersion()'), version, 'Installed version matches release');
  const projectPath = path.join(tmp, '中文 project'); fs.mkdirSync(projectPath);
  fs.writeFileSync(path.join(projectPath, 'index.html'), '<title>Native preview</title>native-smoke-ready');
  const added = await evaluate(`window.api.addProject(${JSON.stringify({ name: '原生安装包验证', projectPath, type: 'static', framework: false })})`);
  const id = JSON.stringify(added.project.id);
  const started = await evaluate(`window.api.startProject(${id})`);
  assert.equal(started.ok, true, started.error);
  assert.match(await (await fetch(started.instance.homeUrl)).text(), /native-smoke-ready/);
  assert.equal((await fetch(started.instance.navUrl)).status, 200);
  await evaluate('refreshStore().then(() => render())'); await delay(300);
  assert.equal(await evaluate('document.querySelectorAll(".card").length'), 1);
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(releaseDir, `smoke-${process.platform}-${process.arch}.png`), Buffer.from(screenshot.data, 'base64'));
  await evaluate(`window.api.stopProject(${id})`);
  assert.equal((await evaluate('window.api.runnerStatus()')).length, 0);
  await assert.rejects(fetch(started.instance.homeUrl));
  await evaluate(`window.api.removeProject({id:${id}})`);
  console.log(`NATIVE SMOKE PASS ${process.platform}/${process.arch}: installed v${version}, window, preload, add/start/preview/nav/stop/port-release/remove`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  socket?.close();
  if (child?.pid) {
    if (process.platform === 'win32') { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(process.exitCode || 0), 500);
});
setTimeout(() => { console.error('Native smoke timed out'); if (child) child.kill(); process.exit(1); }, 120000).unref();
