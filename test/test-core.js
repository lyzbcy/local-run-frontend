// 核心逻辑自检（不依赖 Electron）。
// 运行：node test/test-core.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const { detect } = require('../src/main/detector');
const { createPreviewServer, scanHtmlFiles } = require('../src/main/preview-server');
const store = require('../src/main/store');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

// ---- 1. detector ----
console.log('\n[detector] 项目类型识别');

// 静态项目（用 mobile-wshoto 参考项目）
const staticProj = '/Users/zeen/Documents/共享/工作/微盛/学习/官网国际化-mobile/mobile-wshoto-admin-feature-v1212583-首屏防闪修复';
if (fs.existsSync(staticProj)) {
  const r = detect(staticProj);
  ok('static 项目识别为 static', r.type === 'static', `got ${r.type}`);
  ok('static 不需要启动命令', r.startCommand === null);
} else {
  console.log('  ⏭ 跳过 static（参考项目路径不存在）');
}

// vite 项目（qv-admin 是 vite）
const viteProj = '/Users/zeen/Documents/共享/工作/微盛/学习/【ID1219183】【AI】企微数据与智能专区—文档检索能力需求-需求二：企微AI管家—分析增强/qv-admin';
if (fs.existsSync(viteProj)) {
  const r = detect(viteProj);
  ok('vite 项目识别为 framework', r.framework === true, `got ${r.type}`);
  ok('vite 有启动命令', !!r.startCommand, `got ${r.startCommand}`);
} else {
  console.log('  ⏭ 跳过 vite（参考项目路径不存在）');
}

// 造一个临时 vite 项目
const tmpVite = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-'));
fs.writeFileSync(path.join(tmpVite, 'vite.config.js'), 'export default {}');
fs.writeFileSync(path.join(tmpVite, 'package.json'), JSON.stringify({
  name: 't', scripts: { dev: 'vite' }, devDependencies: { vite: '^5' }
}));
ok('临时 vite 识别为 vite', detect(tmpVite).type === 'vite');
fs.rmSync(tmpVite, { recursive: true, force: true });

// 造一个临时 next 项目
const tmpNext = fs.mkdtempSync(path.join(os.tmpdir(), 'next-'));
fs.writeFileSync(path.join(tmpNext, 'package.json'), JSON.stringify({
  name: 't', scripts: { dev: 'next dev' }, dependencies: { next: '^14' }
}));
ok('临时 next 识别为 next', detect(tmpNext).type === 'next');
fs.rmSync(tmpNext, { recursive: true, force: true });

// 造一个临时静态项目
const tmpStatic = fs.mkdtempSync(path.join(os.tmpdir(), 'static-'));
fs.writeFileSync(path.join(tmpStatic, 'index.html'), '<html><title>首页</title></html>');
fs.mkdirSync(path.join(tmpStatic, 'sub'));
fs.writeFileSync(path.join(tmpStatic, 'sub', 'about.html'), '<html><title>关于</title></html>');
const dr = detect(tmpStatic);
ok('临时 static 识别为 static', dr.type === 'static');

// 未知目录
const tmpEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'));
ok('空目录识别为 unknown', detect(tmpEmpty).type === 'unknown');
fs.rmSync(tmpEmpty, { recursive: true, force: true });

// ---- 2. scanHtmlFiles ----
console.log('\n[scanHtmlFiles] 目录页扫描');
const files = scanHtmlFiles(tmpStatic);
ok('扫到 2 个 html', files.length === 2, `got ${files.length}`);
ok('包含 index.html', files.some(f => f.rel === '/index.html'));
ok('包含 /sub/about.html', files.some(f => f.rel === '/sub/about.html'));

// ---- 3. preview-server ----
console.log('\n[preview-server] 预览服务器');
(async () => {
  const { server, baseUrl } = await createPreviewServer({
    root: tmpStatic, projectName: '测试', port: 0, onLog: () => {}
  });
  // 上面 port:0 会随机端口，重新拿
  const addr = server.address();
  const realBase = `http://127.0.0.1:${addr.port}`;
  baseUrl; // ignore

  const fetch = (url) => new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });

  // 首页
  let r = await fetch(realBase + '/');
  ok('首页 200', r.status === 200, `got ${r.status}`);
  ok('首页是 utf-8', (r.headers['content-type'] || '').includes('charset=utf-8'));

  // 子页面
  r = await fetch(realBase + '/sub/about.html');
  ok('子页 200', r.status === 200, `got ${r.status}`);

  // 目录页
  r = await fetch(realBase + '/__nav__');
  ok('目录页 200', r.status === 200);
  ok('目录页含项目名', r.body.includes('测试'));
  ok('目录页含首页链接', r.body.includes('/index.html'));
  ok('目录页含子页链接', r.body.includes('/sub/about.html'));

  // 404
  r = await fetch(realBase + '/nope.html');
  ok('不存在页面 404', r.status === 404, `got ${r.status}`);

  // 路径穿越拦截
  r = await fetch(realBase + '/../../../etc/passwd');
  ok('路径穿越被拦（403 或 404）', r.status === 403 || r.status === 404, `got ${r.status}`);

  server.close();

  // ---- 4. store ----
  console.log('\n[store] 持久化');
  const tmpStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  store.init(tmpStoreDir);
  let data = store.load();
  ok('初始 projects 为空', data.projects.length === 0);

  const { data: d2, project, created } = store.addProject(data, {
    name: '测试项目', projectPath: '/tmp/foo', type: 'static', startCommand: null, framework: false
  });
  ok('添加成功', created === true && project.id);
  ok('projects 长度 1', d2.projects.length === 1);

  // 同路径去重
  const { created: created2 } = store.addProject(d2, {
    name: '测试项目2', projectPath: '/tmp/foo', type: 'static', startCommand: null, framework: false
  });
  ok('同路径不重复添加', created2 === false);

  // 更新
  const { data: d3, project: up } = store.updateProject(d2, project.id, { favorite: true });
  ok('更新收藏成功', up.favorite === true);

  // 删除
  const d4 = store.removeProject(d3, project.id);
  ok('删除成功', d4.projects.length === 0);

  // 持久化到磁盘
  store.save(d3);
  const reloaded = store.load();
  ok('持久化可重新读出', reloaded.projects.length === 1 && reloaded.projects[0].favorite === true);

  fs.rmSync(tmpStatic, { recursive: true, force: true });
  fs.rmSync(tmpStoreDir, { recursive: true, force: true });

  console.log(`\n================结果================`);
  console.log(`✅ 通过 ${pass} ｜ ❌ 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
