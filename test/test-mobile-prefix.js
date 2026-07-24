// 复现 mobile 项目资源 404 问题，验证 /mobile/ /m/ 前缀剥离修复。
// 运行：node test/test-mobile-prefix.js

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
  // 造一个 mobile 项目结构：根有 css/js/image，子目录 casePage 有 html 用相对路径引用 ../css
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-'));
  fs.mkdirSync(path.join(root, 'css'));
  fs.writeFileSync(path.join(root, 'css', 'header.css'), 'body{}');
  fs.mkdirSync(path.join(root, 'js'));
  fs.writeFileSync(path.join(root, 'js', 'common.js'), 'console.log(1)');
  fs.mkdirSync(path.join(root, 'image'));
  fs.writeFileSync(path.join(root, 'image', 'logo.png'), 'PNG');
  fs.mkdirSync(path.join(root, 'casePage'));
  fs.writeFileSync(path.join(root, 'casePage', 'caseIndex.html'),
    '<link rel="stylesheet" href="../css/header.css"><script src="../js/common.js"></script>');

  const { server } = await createPreviewServer({ root, projectName: 'mobile测试', port: 0, onLog: () => {} });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  console.log('\n[mobile 前缀剥离] 模拟从 /mobile/ 进入时的资源请求');

  // 核心复现：页面在 /mobile/casePage/caseIndex.html 时，相对路径 ../css → /mobile/css/header.css
  // 没有 /mobile 目录，必须靠前缀剥离才能找到根目录的 css
  ok('/mobile/css/header.css → 剥离 → 200（之前 404！）',
    (await get(base + '/mobile/css/header.css')) === 200, `got ${await get(base + '/mobile/css/header.css')}`);
  ok('/mobile/js/common.js → 剥离 → 200',
    (await get(base + '/mobile/js/common.js')) === 200);
  ok('/mobile/image/logo.png → 剥离 → 200',
    (await get(base + '/mobile/image/logo.png')) === 200);

  console.log('\n[mobile 前缀剥离] /m/ 前缀同样剥离');
  ok('/m/css/header.css → 剥离 → 200',
    (await get(base + '/m/css/header.css')) === 200);

  console.log('\n[不影响] 正常路径仍工作');
  ok('/css/header.css 直接访问 → 200', (await get(base + '/css/header.css')) === 200);
  ok('/casePage/caseIndex.html → 200', (await get(base + '/casePage/caseIndex.html')) === 200);

  console.log('\n[通用前缀剥离] 任意项目前缀都能剥离（seo/pc/任意名）');
  // 造一个 seo 子目录场景：/seo/image/x → 根 /image/x
  fs.mkdirSync(path.join(root, 'seo'));
  fs.mkdirSync(path.join(root, 'seo', 'page'));
  fs.writeFileSync(path.join(root, 'seo', 'page', 'index.html'),
    '<link rel="stylesheet" href="../../css/header.css">');
  ok('/seo/css/header.css → 剥 seo → 200', (await get(base + '/seo/css/header.css')) === 200);
  ok('/seo/image/logo.png → 剥 seo → 200', (await get(base + '/seo/image/logo.png')) === 200);
  ok('/pc/css/header.css → 剥 pc → 200（任意前缀）', (await get(base + '/pc/css/header.css')) === 200);
  ok('/whatever/js/common.js → 剥 whatever → 200', (await get(base + '/whatever/js/common.js')) === 200);

  console.log('\n[通用前缀剥离] 两级前缀');
  ok('/a/b/css/header.css → 剥两级 → 200', (await get(base + '/a/b/css/header.css')) === 200);

  console.log('\n[不影响] 真不存在的资源仍 404');
  ok('/mobile/noexist.xyz → 404（不是无脑 200）', (await get(base + '/mobile/noexist.xyz')) === 404);
  ok('/seo/noexist.xyz → 404', (await get(base + '/seo/noexist.xyz')) === 404);

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n================结果================`);
  console.log(`✅ 通过 ${pass} ｜ ❌ 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('异常：', e); process.exit(1); });
