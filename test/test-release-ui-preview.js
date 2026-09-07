const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { createPreviewServer } = require('../src/main/preview-server');
const store = require('../src/main/store');
const mainSource = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');

test('import keeps every new project and skips duplicates in the same batch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-review-'));
  try {
    store.init(dir);
    let handler;
    const source = mainSource.slice(mainSource.indexOf("ipcMain.handle('data:import'"), mainSource.indexOf("\n});", mainSource.indexOf("ipcMain.handle('data:import'")) + 4);
    vm.runInNewContext(source, { store, ipcMain: { handle: (_, fn) => { handler = fn; } }, logger: { ok() {} }, refreshTrayCache() {} });
    const result = await handler(null, { projects: [{ path: '/a' }, { path: '/b' }, { path: '/a' }] });
    assert.deepEqual(store.load().projects.map(p => p.path), ['/a', '/b']);
    assert.equal(result.added, 2);
    assert.equal(result.skipped, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Windows retains native window controls; macOS retains inset traffic lights', () => {
  const source = mainSource.slice(mainSource.indexOf('function createWindow()'), mainSource.indexOf('// 托盘图标'));
  for (const platform of ['win32', 'darwin']) {
    let options;
    const context = { process: { platform, argv: [] }, APP_NAME: 'Test', path, __dirname,
      BrowserWindow: class { constructor(opts) { options = opts; } loadFile() {} on() {} } };
    vm.runInNewContext(source + '\ncreateWindow();', context);
    assert.equal(options.titleBarStyle || 'default', platform === 'darwin' ? 'hiddenInset' : 'default');
  }
});

test('settings reject non-array, non-integer and out-of-bounds port ranges', async () => {
  const start = mainSource.indexOf("ipcMain.handle('settings:save'");
  const end = mainSource.indexOf('\n});', start) + 4;
  let handler, saved;
  vm.runInNewContext(mainSource.slice(start, end), {
    ipcMain: { handle: (_, fn) => { handler = fn; } },
    store: { load: () => ({ settings: { portRange: [8091, 8100] } }), save: value => { saved = value; } },
    logger: { info() {} }
  });
  for (const portRange of ['8091,8100', ['8091', '8100'], [8091.5, 8100], null, [65535, 65536], [9000, 8000], [8091]]) {
    assert.equal((await handler(null, { settings: { portRange } })).ok, false, JSON.stringify(portRange));
  }
  assert.equal(saved, undefined);
  assert.equal((await handler(null, { settings: { portRange: [8091, 8100] } })).ok, true);
});

test('unknown project preserves the user supplied startup command', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = source.indexOf('async function confirmAdd()');
  const end = source.indexOf('\n//', start);
  const inputs = { '#addName': { value: 'Custom' }, '#addCmd': { value: 'npm run custom' }, '#addStartNow': { checked: false } };
  let payload;
  await vm.runInNewContext(source.slice(start, end) + '\nconfirmAdd();', {
    picked: { path: '/custom', type: 'unknown', framework: false }, $: id => inputs[id],
    window: { api: { addProject: async value => { payload = value; return { created: true }; } } },
    toast() {}, closeAddModal() {}, refreshStore: async () => {}, render() {}
  });
  assert.equal(payload.startCommand, 'npm run custom');
  assert.equal(payload.framework, true);
});

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-review-'));
  const root = path.join(dir, 'site');
  fs.mkdirSync(root); fs.mkdirSync(root + '-private');
  fs.writeFileSync(path.join(root, 'index.html'), '<title>home</title>');
  fs.writeFileSync(path.join(root + '-private', 'secret.txt'), 'private-test-marker');
  fs.symlinkSync(root + '-private', path.join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  const { server } = await createPreviewServer({ root, projectName: 'Test', port: 0, onLog() {} });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const get = (requestPath, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: requestPath, headers }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  return { server, get, root };
}

test('navigation handles projects with only nested HTML pages', async t => {
  const { server, root } = await fixture(t);
  fs.unlinkSync(path.join(root, 'index.html'));
  fs.mkdirSync(path.join(root, 'pages'));
  fs.writeFileSync(path.join(root, 'pages', 'hello.html'), '<title>Hello</title>');
  let status, body;
  assert.doesNotThrow(() => server.emit('request', { url: '/__nav__', headers: { host: '127.0.0.1' } }, { writeHead(code) { status = code; }, end(value) { body = value; } }));
  assert.equal(status, 200);
  assert.match(body, /Hello/);
});

test('encoded traversal cannot read a sibling with the same prefix', async t => {
  const { get } = await fixture(t);
  assert.equal((await get('/%2e%2e/site-private/secret.txt')).status, 403);
});

test('symlinks cannot expose files outside the project root', async t => {
  const { get } = await fixture(t);
  assert.equal((await get('/outside/secret.txt')).status, 403);
});

test('malformed URI returns 400 without escaping the request handler', async t => {
  const { server, get } = await fixture(t);
  let status;
  assert.doesNotThrow(() => server.emit('request', { url: '/%ZZ', headers: { host: '127.0.0.1' } }, { writeHead(code) { status = code; }, end() {} }));
  assert.equal(status, 400);
  assert.equal((await get('/')).status, 200);
});

test('static preview blocks foreign Host but permits cross-origin resource requests', async t => {
  const { get } = await fixture(t);
  assert.equal((await get('/', { Host: 'attacker.example' })).status, 403);
  assert.equal((await get('/', { Origin: 'https://example.com', 'Sec-Fetch-Site': 'cross-site' })).status, 200);
});

test('control connection button uses IPC status for ready and failed states', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = source.indexOf('function bindAgent()');
  const end = source.indexOf('// --- 更新 ---', start);
  for (const ready of [true, false]) {
    let click, message, statusCalls = 0;
    const button = { addEventListener(_, fn) { click = fn; } };
    vm.runInNewContext(source.slice(start, end) + '\nbindAgent();', {
      $: id => id === '#btnTestCtrl' ? button : { addEventListener() {} },
      window: { api: { ctrlStatus: async () => { statusCalls++; return { ready, error: 'port occupied' }; } } },
      toast: (text, kind) => { message = { text, kind }; }
    });
    await click();
    assert.equal(statusCalls, 1);
    assert.equal(message.kind, ready ? 'success' : 'error');
    if (!ready) assert.match(message.text, /port occupied/);
    assert.equal(button.disabled, false);
  }
});
