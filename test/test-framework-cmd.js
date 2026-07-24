// 验证框架项目命令拼装 + 端口抓取逻辑。
// 运行：node test/test-framework-cmd.js

const { buildFrameworkArgs, extractPortFromOutput } = require('../src/main/runner');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

console.log('\n[命令拼装] npm run dev 必须用 -- 传参给脚本');
let a = buildFrameworkArgs('npm run dev', 8091);
ok('npm run dev → 带 -- 分隔符', a.includes('--'), `got ${JSON.stringify(a)}`);
ok('端口在 -- 之后', a.indexOf('--') < a.indexOf('8091'), `got ${JSON.stringify(a)}`);
ok('结果形如 [..., "--", "--port", "8091", "--strictPort"]',
  a[a.length-3] === '--port' && a[a.length-2] === '8091' && a[a.length-1] === '--strictPort',
  `got ${JSON.stringify(a)}`);

console.log('\n[命令拼装] 直接调 vite（非 npm）不需要 --');
let b = buildFrameworkArgs('vite', 8091);
ok('vite 直接带 --port', b.includes('--port') && b.includes('8091'));
ok('vite 不带 -- 分隔符', !b.includes('--'));

console.log('\n[命令拼装] next dev');
let c = buildFrameworkArgs('npm run dev', 3000);
ok('next 也走 npm -- 分隔符', c.includes('--') && c.includes('3000'));

console.log('\n[端口抓取] 从 vite/next 输出抓真实端口');
ok('vite 输出 → 抓 5173', extractPortFromOutput('  ➜  Local:   http://localhost:5173/') === '5173');
ok('vite 127.0.0.1 → 抓端口', extractPortFromOutput('  ➜  Local:   http://127.0.0.1:8091/') === '8091');
ok('next 输出 → 抓 3000', extractPortFromOutput('▲ Next.js 14  ready in 1s\n- Local: http://localhost:3000') === '3000');
ok('无端口输出 → null', extractPortFromOutput('starting...') === null);
ok('多行只抓第一个', extractPortFromOutput('foo\nLocal: http://localhost:4321/\nbar') === '4321');

console.log(`\n================结果================`);
console.log(`✅ 通过 ${pass} ｜ ❌ 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
