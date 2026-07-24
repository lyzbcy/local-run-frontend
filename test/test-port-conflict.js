// 验证静态项目端口冲突时正确顺延（复现 vite 占 8091、静态项目也分到 8091 的 bug）。
// 运行：node test/test-port-conflict.js

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const runner = require('../src/main/runner.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

(async () => {
  // 造一个临时静态项目
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portconflict-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<title>首页</title>');

  // 先用一个独立端口区间，避免和真实服务冲突
  const BASE = 19091;

  console.log('\n[场景1] 没有占用 → 拿到起始端口');
  const r1 = await runner.startProject(
    { id: 's1', name: 'p1', path: root, type: 'static', framework: false, port: null },
    [BASE, BASE + 5], () => {}
  );
  ok('第一个项目拿到 BASE (' + BASE + ')', r1.ok && r1.instance.port === BASE, `got ${r1.ok && r1.instance.port}`);
  runner.stopProject('s1');

  console.log('\n[场景2] 用真实 listen 占住 BASE（模拟 vite），静态项目必须顺延');
  const blocker = net.createServer();
  await new Promise(res => blocker.listen(BASE, '127.0.0.1', res));
  // 再占 BASE+1（模拟多个占用）
  const blocker2 = net.createServer();
  await new Promise(res => blocker2.listen(BASE + 1, '127.0.0.1', res));

  const r2 = await runner.startProject(
    { id: 's2', name: 'p2', path: root, type: 'static', framework: false, port: null },
    [BASE, BASE + 5], (msg) => {}
  );
  // BASE 和 BASE+1 被占，应该拿到 BASE+2
  ok('被占两个端口后顺延到 BASE+2 (' + (BASE + 2) + ')', r2.ok && r2.instance.port === BASE + 2,
    `got ${r2.ok && r2.instance.port}`);
  runner.stopProject('s2');
  blocker.close(); blocker2.close();

  console.log('\n[场景3] project.port 优先，被占则顺延');
  const blocker3 = net.createServer();
  await new Promise(res => blocker3.listen(BASE + 3, '127.0.0.1', res));
  const r3 = await runner.startProject(
    { id: 's3', name: 'p3', path: root, type: 'static', framework: false, port: BASE + 3 },
    [BASE, BASE + 5], () => {}
  );
  ok('prefer(BASE+3) 被占 → 顺延到 BASE+4', r3.ok && r3.instance.port === BASE + 4,
    `got ${r3.ok && r3.instance.port}`);
  runner.stopProject('s3');
  blocker3.close();

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n================结果================`);
  console.log(`✅ 通过 ${pass} ｜ ❌ 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('异常：', e); process.exit(1); });
