// 框架项目的开发导航服务：扫描 src/router 的路由定义，生成可点的目录页。
// 复用 qv-admin/zeen-tools/dev-nav-server.js 的思路（正则抽 path/title）。
// 启动一个独立的小 http server，页面里的链接指向 dev server 的真实端口。

const http = require('http');
const fs = require('fs');
const path = require('path');

const EXCLUDE_DIR = new Set(['node_modules', '.git', 'dist', 'build']);

function walkRouterFiles(dir, files = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return files; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIR.has(e.name) || e.name.startsWith('.')) continue;
      walkRouterFiles(path.join(dir, e.name), files);
    } else if (e.isFile() && /\.(ts|js|jsx|tsx)$/.test(e.name)) {
      files.push(path.join(dir, e.name));
    }
  }
  return files;
}

// 从路由文件抽 path/title。返回 [{path, title, module}]
function extractRoutes(filePath, projectRoot) {
  const rel = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  let src;
  try { src = fs.readFileSync(filePath, 'utf8'); }
  catch { return []; }
  const routes = [];
  const pathRe = /path\s*:\s*['"`]([^'"`]+)['"`]/g;
  const titleRe = /title\s*:\s*['"`]([^'"`]+)['"`]/g;
  const nameRe = /name\s*:\s*['"`]([^'"`]+)['"`]/g;
  const paths = [];
  let m;
  while ((m = pathRe.exec(src)) !== null) paths.push(m[1]);
  if (!paths.length) return routes;
  const titleMatch = titleRe.exec(src);
  const nameMatch = nameRe.exec(src);
  const label = (titleMatch && titleMatch[1]) || (nameMatch && nameMatch[1]) || rel;
  for (const p of paths) {
    // 跳过动态参数过多的、通配、空
    if (!p || p === '*' || p === '/') continue;
    if ((p.match(/:/g) || []).length > 3) continue;
    routes.push({ path: p, title: label, module: rel });
  }
  return routes;
}

function scanRoutes(projectRoot) {
  const routerDir = path.join(projectRoot, 'src', 'router');
  if (!fs.existsSync(routerDir)) return [];
  const files = walkRouterFiles(routerDir);
  let all = [];
  for (const f of files) all = all.concat(extractRoutes(f, projectRoot));
  const seen = new Set();
  return all.filter(r => seen.has(r.path) ? false : (seen.add(r.path), true));
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// token 配置：默认用 qv-admin 这类企微项目的典型值（最常见案例）。
// 项目可通过 navTokenConfig 覆盖（testBackend/loginUrl/cookieName/checkPath）。
const DEFAULT_TOKEN_CONFIG = {
  testBackend: 'https://platform-test.wshoto.com',
  loginUrl: 'https://platform-test.wshoto.com/login',
  cookieName: 'token',
  // 校验 token 用的接口（dashboard 是登录后第一个接口，能顺带验有效性）
  checkPath: '/bff/index/private/pc/dashboard',
  checkMethod: 'POST'
};

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > -1) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
  });
  return out;
}

// 真校验 token：发到测试后端 dashboard，401/402 = 失效，业务码成功 = 有效。
function verifyToken(token, cfg) {
  const https = require('https');
  return new Promise(resolve => {
    if (!token || token.length < 8) { resolve({ ok: false, code: 0, msg: 'token 太短' }); return; }
    const url = new URL(cfg.testBackend + cfg.checkPath);
    const req = https.request(url, {
      method: cfg.checkMethod || 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'x-clientType-header': 'pc',
        'x-header-host': url.host
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        const code = res.statusCode;
        if (code === 401 || code === 402) { resolve({ ok: false, code, msg: 'token 已失效（后端拒绝）' }); return; }
        try {
          const body = JSON.parse(raw);
          const bizOk = body && (body.code === '00000' || body.code === 0 || body.code === '0');
          if (bizOk) {
            const u = (body.data && body.data.user) || {};
            const t = (body.data && body.data.tenantEdition) || {};
            resolve({ ok: true, username: u.username || '（未知）', tenantName: t.corpName || t.company || t.tenantName || '（未知）' });
          } else {
            resolve({ ok: false, code: body && body.code, msg: body && body.msg || '后端业务码非成功' });
          }
        } catch { resolve({ ok: false, code, msg: '后端返回非 JSON（可能这个接口路径不对，请在配置里改 checkPath）' }); }
      });
    });
    req.on('error', err => resolve({ ok: false, code: -1, msg: '网络错误：' + err.message }));
    req.write('{}');
    req.end();
  });
}

function renderDevNav(projectName, devBaseUrl, routes, tokenCfg, hasCookieToken) {
  // 按模块分组
  const groups = new Map();
  for (const r of routes) {
    if (!groups.has(r.module)) groups.set(r.module, []);
    groups.get(r.module).push(r);
  }
  const total = routes.length;
  const blocks = [...groups.entries()].map(([mod, items]) => {
    const links = items.map(r =>
      `<a class="r" href="${devBaseUrl}${r.path}" target="_blank" title="${escapeHtml(r.module)}" data-search="${escapeHtml((r.path + ' ' + r.title).toLowerCase())}"><span class="rp">${escapeHtml(r.path)}</span><span class="rt">${escapeHtml(r.title)}</span></a>`
    ).join('');
    return `<div class="grp"><div class="gh">${escapeHtml(mod)} <span class="gc">${items.length}</span></div><div class="gl">${links}</div></div>`;
  }).join('');

  const tc = tokenCfg;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(projectName)} · 开发导航</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=ZCOOL+KuaiLe&display=swap" rel="stylesheet">
<style>
:root{--bg:#FAF8FF;--bg-soft:#F5F0FA;--card:#fff;--primary:#7C3AED;--primary-d:#6D28D9;--primary-bg:#F0EBFA;
--pink:#EC4899;--pink-bg:#FCE7F3;--text:#4C1D95;--text-2:#6B7280;--text-3:#9CA3AF;--border:#EDE7F5;
--shadow:0 4px 16px rgba(124,58,237,.08);--shadow-lg:0 12px 32px rgba(124,58,237,.16)}
*{box-sizing:border-box}
body{margin:0;font-family:"ZCOOL KuaiLe",-apple-system,"PingFang SC",sans-serif;background:var(--bg);color:var(--text)}
.hd{padding:20px 28px;background:linear-gradient(135deg,#7C3AED,#EC4899);color:#fff;position:sticky;top:0;z-index:3;box-shadow:0 4px 20px rgba(124,58,237,.25)}
.hd-top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;max-width:1100px;margin:0 auto}
.hd h1{margin:0;font-size:22px;font-weight:400;letter-spacing:1px}
.hd .s{font-size:13px;opacity:.92;margin-top:4px;font-family:-apple-system,sans-serif}
.hd .s a{color:#fff;text-decoration:underline}
.search-box{background:rgba(255,255,255,.22);border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:9px 18px;color:#fff;font-size:14px;width:260px;max-width:100%;font-family:-apple-system,sans-serif}
.search-box::placeholder{color:rgba(255,255,255,.75)}.search-box:focus{outline:none;background:rgba(255,255,255,.32)}
.wrap{max-width:1100px;margin:0 auto;padding:20px 28px 80px}
.tk{background:var(--card);border-radius:18px;padding:20px 24px;margin-bottom:22px;box-shadow:var(--shadow);border-left:4px solid var(--pink)}
.tk h2{margin:0 0 10px;font-size:18px;color:var(--primary-d);font-weight:400}
.tk .desc{font-size:13px;color:var(--text-2);line-height:1.8;margin-bottom:12px;font-family:-apple-system,sans-serif}
.tk .desc b{color:var(--text)}.tk code{background:var(--primary-bg);padding:1px 6px;border-radius:6px;font-size:12px;color:var(--primary-d)}
.tk-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.tk-row input{flex:1;min-width:260px;padding:10px 14px;border:1px solid var(--border);border-radius:12px;font-size:13px;font-family:-apple-system,sans-serif;background:var(--bg)}
.tk-row input:focus{outline:none;border-color:var(--primary)}
.btn{padding:9px 16px;border:none;border-radius:12px;cursor:pointer;font-size:13px;font-family:-apple-system,sans-serif;transition:transform .15s}
.btn:hover{transform:translateY(-1px)}
.btn-pri{background:var(--primary);color:#fff}.btn-ghost{background:var(--bg-soft);color:var(--text-2)}.btn-danger{background:#f53f3f;color:#fff}
.tk-status{font-size:13px;min-height:20px;margin-bottom:4px;font-family:-apple-system,sans-serif}.tk-status.ok{color:#10b981}.tk-status.err{color:#f53f3f}.tk-status.info{color:var(--primary)}
.tk-meta{font-size:12px;color:var(--text-3);font-family:-apple-system,sans-serif}
.grp{margin-bottom:22px}.gh{font-size:15px;color:var(--primary-d);margin-bottom:10px;display:flex;align-items:center;gap:8px;font-family:ui-monospace,monospace}
.gc{background:var(--primary-bg);color:var(--primary);padding:1px 9px;border-radius:999px;font-size:11px;margin-left:4px;font-family:-apple-system,sans-serif}
.gl{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.r{display:flex;flex-direction:column;gap:3px;padding:12px 16px;background:var(--card);border:1px solid var(--border);border-radius:14px;text-decoration:none;color:var(--text);transition:all .18s;box-shadow:var(--shadow)}
.r:hover{transform:translateY(-2px);border-color:var(--primary);box-shadow:var(--shadow-lg)}
.rp{font-size:13px;font-family:ui-monospace,monospace;color:var(--primary);font-weight:500}.rt{font-size:11px;color:var(--text-3);font-family:-apple-system,sans-serif}
.no-match{display:none;text-align:center;padding:40px;color:var(--text-3);font-family:-apple-system,sans-serif}
.ft{text-align:center;padding:24px 0 0;color:var(--text-3);font-size:12px;font-family:-apple-system,sans-serif}
.fab{position:fixed;right:28px;bottom:28px;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#7C3AED,#EC4899);color:#fff;border:none;cursor:pointer;font-size:24px;box-shadow:0 8px 24px rgba(124,58,237,.4);z-index:10;transition:transform .2s;display:flex;align-items:center;justify-content:center}
.fab:hover{transform:scale(1.1) rotate(8deg)}
.modal{position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center}
.modal.show{display:flex}
.modal-mask{position:absolute;inset:0;background:rgba(76,29,149,.4);backdrop-filter:blur(2px)}
.modal-card{position:relative;background:var(--card);border-radius:24px;padding:28px 32px;width:480px;max-width:92vw;box-shadow:0 24px 60px rgba(124,58,237,.3)}
.modal-card h2{margin:0 0 4px;font-size:22px;color:var(--primary-d);text-align:center;font-weight:400}
.modal-card .intro{text-align:center;color:var(--text-2);font-size:13px;line-height:1.8;margin:14px 0 22px;font-family:-apple-system,sans-serif}
.modal-card .intro b{color:var(--pink)}
.qr-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.qr-cell{text-align:center}
.qr-cell img{width:110px;height:110px;object-fit:cover;border-radius:14px;border:2px solid var(--border)}
.qr-cell .label{font-size:12px;color:var(--text-2);margin-top:8px;font-family:-apple-system,sans-serif}
.author{display:flex;align-items:center;gap:12px;margin-top:22px;padding:14px;background:var(--bg-soft);border-radius:14px}
.author img{width:48px;height:48px;border-radius:50%}
.author .atext{font-size:13px;color:var(--text-2);line-height:1.6;font-family:-apple-system,sans-serif}
.author .atext a{color:var(--primary);text-decoration:none}
.modal-close{position:absolute;top:14px;right:18px;background:none;border:none;font-size:24px;color:var(--text-3);cursor:pointer}
</style></head><body>
<div class="hd"><div class="hd-top">
  <div><h1>${escapeHtml(projectName)} · 开发导航</h1>
  <div class="s">扫描到 ${total} 个路由 ｜ <a href="${devBaseUrl}/" target="_blank">打开首页 ${devBaseUrl}/</a></div></div>
  <input class="search-box" id="search" placeholder="搜索路由路径或名称…" autocomplete="off">
</div></div>
<div class="wrap">

<div class="tk">
  <h2>本地登录态（注入 token）</h2>
  <div class="desc">
    <b>原理</b>：很多后台项目（企微/CRM 类）在 <code>127.0.0.1</code> 上无法扫码登录，需要从测试环境「搬」token 过来。<br>
    token 写进 cookie 后，<code>${devBaseUrl}</code> 的项目立即获得登录态（cookie 同 <code>127.0.0.1</code> 不分端口）。<br>
    这是<b>真实鉴权</b>（非绕过）——请求带 <code>Authorization: Bearer &lt;token&gt;</code> 去后端真校验，失效就 401。<br>
    <b>怎么拿 token</b>：打开 <a href="${tc.loginUrl}" target="_blank">${tc.loginUrl}</a> 登录 → F12 → Application → Cookies → 复制 <code>${tc.cookieName}</code> 的值 → 粘贴到下面 → 点「应用 token」。
    <br><br><b>不需要登录态的项目请忽略此区域</b>，直接点下面的路由即可。
  </div>
  <div class="tk-row">
    <input type="text" id="tokenInput" placeholder="把从 ${tc.testBackend} 复制的 ${tc.cookieName} 粘贴到这里…" autocomplete="off">
    <button class="btn btn-pri" id="btnApply">应用 token</button>
    <button class="btn btn-ghost" id="btnCheck">重新校验</button>
    <button class="btn btn-danger" id="btnClear">清除</button>
  </div>
  <div class="tk-status" id="tkStatus"></div>
  <div class="tk-meta" id="tkMeta"></div>
</div>

${blocks || '<div class="no-match" style="display:block">没扫到路由（可能路由不在 src/router 下）。直接打开首页吧。</div>'}
<div class="no-match" id="noMatch">没找到匹配的路由</div>
<div class="ft">由 本地运行前端项目 生成 · 链接指向 dev server</div>
</div>

<button class="fab" id="fab" title="关于捞鱼">🐟</button>
<div class="modal" id="aboutModal">
  <div class="modal-mask" id="modalMask"></div>
  <div class="modal-card">
    <button class="modal-close" id="modalClose">×</button>
    <h2>关于这个工具</h2>
    <div class="intro">「本地运行前端项目」一键启动任意前端项目，<b>不往项目里写任何文件</b>。<br>开源免费，希望对你有用 🐟</div>
    <div class="qr-grid">
      <div class="qr-cell"><img src="https://lyzbcy.github.io/local-run-frontend/assets/reward-qr.jpg" alt="赞赏"><div class="label">请喝奶茶</div></div>
      <div class="qr-cell"><img src="https://lyzbcy.github.io/local-run-frontend/assets/sticker-qr.png" alt="表情包"><div class="label">星星布丁表情包</div></div>
      <div class="qr-cell"><img src="https://lyzbcy.github.io/local-run-frontend/assets/group-qr.jpg" alt="粉丝群"><div class="label">加入粉丝群</div></div>
    </div>
    <div class="author">
      <img src="https://lyzbcy.github.io/local-run-frontend/assets/sticker/mascot.png" alt="捞鱼">
      <div class="atext">「一个弱小但有梦想的开发者 🐟」<br><a href="https://lyzbcy.github.io/" target="_blank">了解捞鱼 →</a></div>
    </div>
  </div>
</div>
<script>
const HAS_TOKEN = ${hasCookieToken ? 'true' : 'false'};
const TEST_BACKEND = ${JSON.stringify(tc.testBackend)};
const el = id => document.getElementById(id);
function show(kind, html){ el('tkStatus').className='tk-status '+kind; el('tkStatus').innerHTML=html; }
function meta(html){ el('tkMeta').innerHTML=html; }
function fmtTime(){ return new Date().toLocaleTimeString('zh-CN',{hour12:false}); }

async function applyToken(){
  const token = el('tokenInput').value.trim();
  if(!token){ show('err','⚠ 请先粘贴 token'); return; }
  show('info','正在写入 cookie 并校验…');
  try{
    const r = await fetch('/api/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
    const j = await r.json();
    if(!j.ok){ show('err','✗ 写入失败：'+(j.msg||'')); return; }
    const c = await fetch('/api/token-check',{method:'GET'});
    const cj = await c.json();
    if(cj.ok){ show('ok','✓ 登录态已建立：'+(cj.username||'')+' @ '+(cj.tenantName||'')); meta('上次校验：'+fmtTime()+' · token 有效，现在可以点路由进入页面。'); }
    else { show('err','✗ cookie 已写但 token 校验失败：'+(cj.msg||'')); meta('上次校验：'+fmtTime()+' · '+((cj.code===401||cj.code===402)?'token 已过期，请重新复制。':'请确认 token 正确。')); }
  }catch(e){ show('err','✗ '+e.message); }
}
async function checkToken(){
  show('info','校验中…');
  const r = await fetch('/api/token-check');
  const j = await r.json();
  if(j.ok){ show('ok','✓ token 有效：'+(j.username||'')+' @ '+(j.tenantName||'')); meta('上次校验：'+fmtTime()); }
  else { show('err','✗ '+ (j.msg||'未登录')); meta('上次校验：'+fmtTime()+' · '+(j.code===401?'token 已过期':'请先粘贴 token')); }
}
async function clearToken(){
  if(!confirm('确定清除本地 token cookie 吗？')) return;
  await fetch('/api/token',{method:'DELETE'});
  show('info','已清除'); meta(''); el('tokenInput').value='';
}
el('btnApply').onclick=applyToken; el('btnCheck').onclick=checkToken; el('btnClear').onclick=clearToken;
if(HAS_TOKEN) checkToken(); else { show('','未注入 token（需要登录态的项目请按上方步骤粘贴）'); }

// 搜索过滤路由
var sinput = document.getElementById('search');
var noMatch = document.getElementById('noMatch');
if(sinput){
  sinput.addEventListener('input', function(){
    var q = sinput.value.trim().toLowerCase();
    var grps = document.querySelectorAll('.grp');
    var totalShown = 0;
    grps.forEach(function(g){
      var rs = g.querySelectorAll('.r'); var shown = 0;
      rs.forEach(function(r){
        var s = r.getAttribute('data-search')||'';
        var hit = !q || s.indexOf(q) !== -1;
        r.style.display = hit ? '' : 'none'; if(hit) shown++;
      });
      g.style.display = shown ? '' : 'none'; totalShown += shown;
    });
    if(noMatch) noMatch.style.display = totalShown ? 'none' : '';
  });
}
// 关于弹窗
var modal = document.getElementById('aboutModal');
function openAbout(){ if(modal) modal.classList.add('show'); }
function closeAbout(){ if(modal) modal.classList.remove('show'); }
var fab = document.getElementById('fab'); if(fab) fab.addEventListener('click', openAbout);
var mc = document.getElementById('modalClose'); if(mc) mc.addEventListener('click', closeAbout);
var mask = document.getElementById('modalMask'); if(mask) mask.addEventListener('click', closeAbout);
document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeAbout(); });
</script>
</body></html>`;
}

// 启动导航 server。tokenConfig 可选（覆盖默认的后端地址/登录页/cookie名/校验路径）。
function createDevNavServer({ projectRoot, projectName, devBaseUrl, onLog, tokenConfig }) {
  const log = (...a) => { try { (onLog || console.log)(...a); } catch {} };
  const routes = scanRoutes(projectRoot);
  log(`[nav] 扫描到 ${routes.length} 个路由`);
  const tc = { ...DEFAULT_TOKEN_CONFIG, ...(tokenConfig || {}) };

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const cookies = parseCookies(req.headers.cookie);

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(renderDevNav(projectName, devBaseUrl, routes, tc, !!cookies[tc.cookieName]));
      return;
    }
    // token 写入
    if (url === '/api/token' && req.method === 'POST') {
      const raw = await new Promise(r => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>r(b)); });
      let parsed; try { parsed = JSON.parse(raw); } catch { res.writeHead(400); res.end('{"ok":false,"msg":"非 JSON"}'); return; }
      const token = parsed && parsed.token;
      if (!token || typeof token !== 'string' || token.length < 8) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"msg":"token 不合法"}'); return;
      }
      res.setHeader('Set-Cookie', `${tc.cookieName}=${encodeURIComponent(token)}; Path=/; Max-Age=604800; SameSite=Lax`);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
    }
    // token 校验
    if (url === '/api/token-check' && req.method === 'GET') {
      const token = cookies[tc.cookieName] ? decodeURIComponent(cookies[tc.cookieName]) : '';
      if (!token) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"code":0,"msg":"本地无 token cookie"}'); return; }
      const result = await verifyToken(token, tc);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
    }
    // token 清除
    if (url === '/api/token' && req.method === 'DELETE') {
      res.setHeader('Set-Cookie', `${tc.cookieName}=; Path=/; Max-Age=0`);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
    }
    res.writeHead(404); res.end('Not Found');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const navUrl = `http://127.0.0.1:${port}/`;
      log(`[nav] 导航页 → ${navUrl}`);
      resolve({ server, port, navUrl, routeCount: routes.length });
    });
  });
}

module.exports = { createDevNavServer, scanRoutes, extractRoutes };
