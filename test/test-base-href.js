// base-href 映射测试 + 错误文件命中回归守卫。
// 钉死：旧的 prefix-strip 会返回错误文件还报 200，base-href 显式映射必须杜绝。
// 运行：node test/test-base-href.js

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
    http.get(url, res => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve('ERR'));
  });
}

(async () => {
  // 造含 <base href> 的项目：模拟真实 mobile/seo 项目结构
  // 根有 css/header.css、page/caseIndex.html 带 <base href="/mobile/">、引用 ../css/header.css
  // 浏览器会请求 /mobile/css/header.css（base + 相对路径）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'base-'));
  fs.mkdirSync(path.join(root, 'css'));
  fs.writeFileSync(path.join(root, 'css', 'header.css'), 'ROOT_CSS');
  fs.mkdirSync(path.join(root, 'page'));
  fs.writeFileSync(path.join(root, 'page', 'caseIndex.html'),
    '<base href="/mobile/"><link rel="stylesheet" href="../css/header.css"><script src="../js/common.js"></script>');
  fs.mkdirSync(path.join(root, 'js'));
  fs.writeFileSync(path.join(root, 'js', 'common.js'), 'console.log(1)');

  const { server } = await createPreviewServer({ root, projectName: 'base测试', port: 0, onLog: () => {} });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  console.log('\n[base-href 映射] 模拟 <base href="/mobile/"> 的资源请求');
  // 浏览器 base=/mobile/ + 相对 ../css/header.css → /mobile/css/header.css
  ok('/mobile/css/header.css → 映射到根 /css/header.css → 200',
    (await get(base + '/mobile/css/header.css')) === 200);
  ok('/mobile/js/common.js → 200', (await get(base + '/mobile/js/common.js')) === 200);

  console.log('\n[正确性守卫] prefix-strip 的错文件 200 必须 404');
  // 关键：造同名文件冲突。根 css/x.css 和 page/css/x.css 都存在。
  // 旧的 prefix-strip：请求 /mobile/css/x.css（不存在）会剥 mobile 命中根 css/x.css → 错的 200
  // 现在：base 映射 /mobile/css/x.css → /css/x.css，这个存在就 200（正确，因为 base 就是指向根）
  // 但请求一个 base 映射后仍不存在的，必须 404，绝不能猜测
  fs.mkdirSync(path.join(root, 'page', 'css'));
  fs.writeFileSync(path.join(root, 'page', 'css', 'x.css'), 'PAGE_CSS');
  fs.writeFileSync(path.join(root, 'css', 'x.css'), 'ROOT_X');
  // /mobile/page/css/x.css → base 映射 → /page/css/x.css → 200（PAGE_CSS，正确）
  ok('/mobile/page/css/x.css → 映射到 /page/css/x.css → 200（正确文件）',
    (await get(base + '/mobile/page/css/x.css')) === 200);
  // /nonexist/css/x.css → 不是已知 base 前缀，不映射，找不到 → 404（不能猜）
  ok('/nonexist/css/x.css → 404（绝不猜测式 strip）',
    (await get(base + '/nonexist/css/x.css')) === 404);
  // /mobile/deeply/nested/missing.css → base 映射后 /deeply/nested/missing.css 不存在 → 404
  ok('/mobile/deeply/nested/missing.css → 映射后仍 404',
    (await get(base + '/mobile/deeply/nested/missing.css')) === 404);

  console.log('\n[不影响] 无 base 的项目仍正常');
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nobase-'));
  fs.mkdirSync(path.join(root2, 'css'));
  fs.writeFileSync(path.join(root2, 'css', 'a.css'), 'A');
  const { server: s2 } = await createPreviewServer({ root: root2, projectName: '无base', port: 0, onLog: () => {} });
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  ok('无 base 项目 /css/a.css → 200', (await get(b2 + '/css/a.css')) === 200);

  server.close(); s2.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root2, { recursive: true, force: true });
  console.log(`\n================结果================`);
  console.log(`✅ 通过 ${pass} ｜ ❌ 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('异常：', e); process.exit(1); });
