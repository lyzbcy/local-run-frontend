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
      `<a class="r" href="${devBaseUrl}${r.path}" target="_blank" title="${escapeHtml(r.module)}"><span class="rp">${escapeHtml(r.path)}</span><span class="rt">${escapeHtml(r.title)}</span></a>`
    ).join('');
    return `<div class="grp"><div class="gh">${escapeHtml(mod)} <span class="gc">${items.length}</span></div><div class="gl">${links}</div></div>`;
  }).join('');

  const tc = tokenCfg;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(projectName)} · 开发导航</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f7fa;color:#1d2129}
.hd{padding:18px 24px;background:linear-gradient(135deg,#409eff,#36cfc9);color:#fff;position:sticky;top:0;z-index:2}
.hd h1{margin:0;font-size:18px;font-weight:600}.hd .s{font-size:13px;opacity:.9;margin-top:4px}
.hd .s a{color:#fff;text-decoration:underline}
.wrap{max-width:1100px;margin:0 auto;padding:18px 24px}
.tk{background:#fff;border-radius:10px;padding:18px 22px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.06);border-left:4px solid #ff7d00}
.tk h2{margin:0 0 10px;font-size:16px}.tk .desc{font-size:13px;color:#4e5969;line-height:1.8;margin-bottom:12px}
.tk .desc b{color:#1d2129}.tk code{background:#f2f3f5;padding:1px 6px;border-radius:3px;font-size:12px;color:#d46b08}
.tk-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.tk-row input{flex:1;min-width:260px;padding:9px 12px;border:1px solid #e5e6eb;border-radius:6px;font-size:13px}
.btn{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500}
.btn-pri{background:#409eff;color:#fff}.btn-ghost{background:#f2f3f5;color:#4e5969}.btn-danger{background:#f53f3f;color:#fff}
.tk-status{font-size:13px;min-height:20px;margin-bottom:4px}.tk-status.ok{color:#00b42a}.tk-status.err{color:#f53f3f}.tk-status.info{color:#409eff}
.tk-meta{font-size:12px;color:#86909c}
.grp{margin-bottom:18px}.gh{font-size:14px;font-weight:600;color:#4e5969;margin-bottom:8px;font-family:ui-monospace,monospace}
.gc{background:#f2f3f5;padding:1px 7px;border-radius:8px;font-size:11px;margin-left:6px;color:#86909c}
.gl{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px}
.r{display:flex;flex-direction:column;gap:2px;padding:10px 14px;background:#fff;border:1px solid #e5e6eb;border-radius:8px;text-decoration:none;color:#1d2129;transition:all .15s}
.r:hover{transform:translateY(-1px);border-color:#409eff;box-shadow:0 4px 12px rgba(64,158,255,.15)}
.rp{font-size:13px;font-family:ui-monospace,monospace;color:#409eff;font-weight:500}.rt{font-size:11px;color:#86909c}
.ft{text-align:center;padding:24px;color:#c9cdd4;font-size:12px}
</style></head><body>
<div class="hd"><h1>🧭 ${escapeHtml(projectName)}</h1>
<div class="s">扫描到 ${total} 个路由 ｜ <a href="${devBaseUrl}/" target="_blank">打开首页 ${devBaseUrl}/</a></div></div>
<div class="wrap">

<div class="tk">
  <h2>🔑 本地登录态（注入 token）</h2>
  <div class="desc">
    <b>原理</b>：很多后台项目（企微/CRM 类）在 <code>127.0.0.1</code> 上无法扫码登录，需要从测试环境「搬」token 过来。<br>
    token 写进 cookie 后，<code>${devBaseUrl}</code> 的项目立即获得登录态（cookie 同 <code>127.0.0.1</code> 不分端口）。<br>
    这是<b>真实鉴权</b>（非绕过）——所有请求带 <code>Authorization: Bearer &lt;token&gt;</code> 去后端真校验，失效就 401。<br>
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

${blocks || '<div style="text-align:center;padding:40px;color:#86909c">没扫到路由（可能路由不在 src/router 下）。直接打开首页吧。</div>'}
<div class="ft">由 本地运行前端项目 生成 · 链接指向 dev server</div>
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
