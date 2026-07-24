// 复现真实 bug：vite(framework) 只绑 IPv6，static 项目端口探测必须发现它并顺延。
// 子 agent 用 lsof 证实 vite 绑 IPv6 *:8091，旧探测只查 IPv4 漏判 → 两个进程都 8091。
// 运行：node test/test-ipv6-port.js

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipv6-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<title>首页</title>');
  const BASE = 28091;

  console.log('\n[复现] 模拟 vite：先绑 IPv6 ::（dual-stack，真实 vite 行为），再启动 static 项目');
  // 模拟 vite 真实行为：绑 :: （IPv6 any，dual-stack，等价于 lsof 里的 *:8091）
  const vite = net.createServer();
  await new Promise((res, rej) => { vite.listen(BASE, '::', res); vite.on('error', rej); });

  const r = await runner.startProject(
    { id: 's', name: 'static', path: root, type: 'static', framework: false, port: BASE },
    [BASE, BASE + 5], (m) => {}
  );
  // 关键断言：static 项目必须避开 BASE（被 IPv6 vite 占了），拿到 BASE+1 或更大
  ok('static 避开 IPv6 占用的 BASE，顺延到 BASE+1+',
    r.ok && r.instance.port > BASE, `got ${r.ok && r.instance.port}`);
  ok('static 的端口和 vite 不同', r.ok && r.instance.port !== BASE, `got ${r.ok && r.instance.port}`);

  runner.stopProject('s');
  vite.close();

  console.log('\n[对照] IPv6 没占时，static 正常拿到 BASE');
  const r2 = await runner.startProject(
    { id: 's2', name: 'static2', path: root, type: 'static', framework: false, port: null },
    [BASE, BASE + 5], () => {}
  );
  ok('无占用时拿到 BASE', r2.ok && r2.instance.port === BASE, `got ${r2.ok && r2.instance.port}`);
  runner.stopProject('s2');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n================结果================`);
  console.log(`✅ 通过 ${pass} ｜ ❌ 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('异常：', e); process.exit(1); });
