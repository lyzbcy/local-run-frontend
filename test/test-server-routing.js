// 服务器路由测试：复现 404 问题，验证目录/无后缀路径的处理。
// 运行：node test/test-server-routing.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { createPreviewServer } = require('../src/main/preview-server');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

function get(url) {
  return new Promise(resolve => {
    http.get(url, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', () => resolve({ status: 'ERR', body: '' }));
  });
}

(async () => {
  // 造一个模拟真实项目的临时目录：根 index.html + 有 index 的目录 + 无 index 的业务目录 + 子页
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-test-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<title>首页</title>');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'index.html'), '<title>子目录首页</title>');
  fs.writeFileSync(path.join(root, 'sub', 'about.html'), '<title>关于</title>');
  // 无 index 的业务目录（模拟 casePage/schemePage）
  fs.mkdirSync(path.join(root, 'biz'));
  fs.writeFileSync(path.join(root, 'biz', 'list.html'), '<title>列表</title>');
  fs.writeFileSync(path.join(root, 'biz', 'detail.html'), '<title>详情</title>');
  // 纯资源目录
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'style.css'), 'body{}');

  const { server } = await createPreviewServer({ root, projectName: '测试', port: 0, onLog: () => {} });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  console.log('\n[路由] 根与标准文件');
  ok('根路径 → 首页', (await get(base + '/')).status === 200);
  ok('index.html', (await get(base + '/index.html')).status === 200);
  ok('显式子页', (await get(base + '/sub/about.html')).status === 200);

  console.log('\n[路由] 无后缀补 .html');
  ok('/sub/about → 补 about.html (200)', (await get(base + '/sub/about')).status === 200);

  console.log('\n[路由] 有 index 的目录');
  ok('/sub/ → index.html (200)', (await get(base + '/sub/')).status === 200);
  ok('/sub（无斜杠无后缀）→ 目录→index.html (200)', (await get(base + '/sub')).status === 200);

  console.log('\n[路由] 无 index 的业务目录（核心修复点）');
  const bizDir = await get(base + '/biz/');
  ok('/biz/ → 不该 404（目录列表或首个 html）', bizDir.status !== 404, `got ${bizDir.status}`);
  const bizNoSlash = await get(base + '/biz');
  ok('/biz（无斜杠）→ 不该 404', bizNoSlash.status !== 404, `got ${bizNoSlash.status}`);
  // 业务目录的子页应能直接访问
  ok('/biz/list.html → 200', (await get(base + '/biz/list.html')).status === 200);
  ok('/biz/detail → 补 .html → 200', (await get(base + '/biz/detail')).status === 200);

  console.log('\n[路由] 纯资源目录');
  ok('/assets/style.css → 200', (await get(base + '/assets/style.css')).status === 200);

  console.log('\n[路由] 不存在');
  ok('/noexist.html → 404', (await get(base + '/noexist.html')).status === 404);

  console.log('\n[路由] 路径穿越');
  const traversal = await get(base + '/../../../etc/passwd');
  ok('穿越被拦（403/404）', traversal.status === 403 || traversal.status === 404, `got ${traversal.status}`);

  server.close();
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n================结果================`);
  console.log(`✅ 通过 ${pass} ｜ ❌ 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('异常：', e); process.exit(1); });
