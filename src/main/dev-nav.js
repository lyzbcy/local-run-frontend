// 框架项目的开发导航服务：扫描 src/router 的路由定义，生成可点的目录页。
// 复用 demo-admin/zeen-tools/dev-nav-server.js 的思路（正则抽 path/title）。
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

// 渲染 token 区。tc 为 null 时完全不渲染（开源友好：对不需要登录态的项目零干扰）。
// tc 存在时渲染完整的可配置 UI（后端/cookie名/校验路径/方法 都能改，改完写回 store）。
function tokenBlock(tc, hasCookieToken) {
  if (!tc) return ''; // 探测不到 = 不显示
  const detected = tc.autoDetected
    ? `<div class="tk-detected">✨ 已从项目代码自动探测到后端地址（来源：<code>${escapeHtml(tc.source || '未知')}</code>）。字段不对可手动修改。</div>`
    : '';
  return `
<div class="tk" id="tokenBlock">
  <h2>本地登录态（注入 token）</h2>
  <div class="desc">
    <b>原理</b>：很多后台项目（CRM/管理端类）在 <code>127.0.0.1</code> 上无法直接登录，需要从测试环境「搬」token 过来。<br>
    token 写进 cookie 后，<code>本页 dev server</code> 立即获得登录态（cookie 同 <code>127.0.0.1</code> 不分端口）。<br>
    这是<b>真实鉴权</b>（非绕过）——请求带 <code>Authorization: Bearer &lt;token&gt;</code> 去后端真校验，失效就 401。
    <br><br><b>不需要登录态的项目请忽略此区域</b>，直接点下面的路由即可。
  </div>
  ${detected}
  <details class="tk-cfg" ${tc.autoDetected ? '' : 'open'}>
    <summary>⚙️ 后端配置（点开修改）</summary>
    <div class="tk-cfg-grid">
      <label>后端地址<input type="text" id="cfgBackend" value="${escapeHtml(tc.testBackend || '')}" placeholder="https://your-test-backend.com"></label>
      <label>登录页 URL<input type="text" id="cfgLoginUrl" value="${escapeHtml(tc.loginUrl || '')}" placeholder="https://your-test-backend.com/login"></label>
      <label>cookie 名<input type="text" id="cfgCookieName" value="${escapeHtml(tc.cookieName || 'token')}" placeholder="token"></label>
      <label>校验接口路径<input type="text" id="cfgCheckPath" value="${escapeHtml(tc.checkPath || '')}" placeholder="/api/user/info（留空则不校验）"></label>
      <label>校验方法
        <select id="cfgCheckMethod">
          <option value="GET" ${(tc.checkMethod || 'GET').toUpperCase() === 'GET' ? 'selected' : ''}>GET</option>
          <option value="POST" ${tc.checkMethod === 'POST' ? 'selected' : ''}>POST</option>
        </select>
      </label>
    </div>
    <button class="btn btn-ghost" id="btnSaveCfg" style="margin-top:8px">保存配置</button>
  </details>
  <div class="desc" style="margin-top:14px;margin-bottom:8px">
    <b>怎么拿 token（推荐方法）</b>：打开 <a href="${escapeHtml(tc.loginUrl || tc.testBackend)}" target="_blank">${escapeHtml(tc.loginUrl || tc.testBackend)}</a> 并登录 → F12 → <b>Network（网络）</b> → 刷新页面随便点一个接口请求 → <b>Request Headers（请求标头）</b> → 找 <code>authorization: Bearer xxx</code> → 复制 Bearer 后面那整串 → 粘贴到下面。<br>
    <span style="color:var(--text-3)">（不推荐从 Application → Cookies 复制：那里可能有多条同名/过期的 cookie，容易拿错。若用 Network 方法仍提示失效，说明你复制的值确实过期了，重新登录后再取。）</span>
  </div>
  <div class="tk-row">
    <input type="text" id="tokenInput" placeholder="把从 ${escapeHtml(tc.testBackend || '后端')} 复制的 ${escapeHtml(tc.cookieName || 'token')} 粘贴到这里…" autocomplete="off">
    <button class="btn btn-pri" id="btnApply">应用 token</button>
    <button class="btn btn-ghost" id="btnCheck">重新校验</button>
    <button class="btn btn-danger" id="btnClear">清除</button>
  </div>
  <div class="tk-status" id="tkStatus"></div>
  <div class="tk-meta" id="tkMeta"></div>
</div>`;
}

// ===== token 注入配置：完全自适应，零硬编码 =====
// 设计原则：开源软件不能内置任何特定公司/项目的域名、接口、cookie 名。
// 自动从项目代码里探测，探不到就完全隐藏 token 区（对不需要登录态的项目零干扰）。
// 项目可在 store 里存 tokenConfig 覆盖自动探测结果。
//
// 探测顺序：
// 1. 项目 .env / .env.development 里的 VITE_API_BASE / API_BASE / VUE_APP_API 等
// 2. 项目 src 下的 axios baseURL / request baseURL 配置
// 3. package.json name/description 含特定关键字
// 探测出 testBackend 后，loginUrl 默认 = testBackend + /login，
// cookieName 默认 'token'，checkPath 默认用 /bff/ 或 /api/ 第一个匹配。
// 用户可在目录页 token 区 UI 里改任意字段（覆盖写入 store）。

function tryReadFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// 从 .env* 文件里抽 API 后端地址
function detectBackendFromEnv(root) {
  const candidates = ['.env.development.local', '.env.development', '.env.local', '.env'];
  // 注意：VUE_APP_BASE_URL 是 vue-cli 生态最常见的 API 基址约定（demo-admin 等真实项目在用）。
  // 正则要求值必须是完整 http(s) URL，所以 VUE_APP_COS_URL='/' 这类相对路径不会误命中；
  // 但 POSTER_URL/CDN_URL 等非后端 key 不在名单里，不会被误当后端。
  const keys = [
    'VITE_API_BASE', 'VITE_BASE_API', 'VITE_APP_API_BASE', 'VITE_GLOB_API_URL',
    'VUE_APP_API_BASE', 'VUE_APP_BASE_API', 'VUE_APP_BASE_URL', 'VUE_APP_API_URL',
    'REACT_APP_API_BASE', 'API_BASE'
  ];
  for (const f of candidates) {
    const txt = tryReadFile(path.join(root, f));
    if (!txt) continue;
    for (const k of keys) {
      const re = new RegExp('^\\s*' + k + '\\s*=\\s*["\']?(https?://[^"\'\\s#]+)', 'm');
      const m = txt.match(re);
      if (m && m[1]) return { backend: trimSlash(m[1]), source: `${f}:${k}` };
    }
  }
  return null;
}

function trimSlash(s) { return String(s).replace(/\/+$/, ''); }

// 从 src 代码里抽 axios baseURL（扫一层常见目录，限深度避免慢）
function detectBackendFromSrc(root) {
  const dirs = ['src', 'api', 'request', 'utils'];
  const urlRe = /baseURL\s*[:=]\s*['"`](https?:\/\/[^'"`#]+)['"`]/;
  const envRe = /baseURL\s*[:=]\s*['"`]([^'"`]+)['"`]/; // 可能是变量，先抓出来再判
  for (const d of dirs) {
    const dir = path.join(root, d);
    if (!fs.existsSync(dir)) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !/\.(js|ts|mjs|jsx|tsx)$/.test(e.name)) continue;
      const txt = tryReadFile(path.join(dir, e.name));
      if (!txt) continue;
      const m1 = txt.match(urlRe);
      if (m1 && m1[1] && /^https?:/.test(m1[1])) return { backend: trimSlash(m1[1]), source: `${d}/${e.name}:baseURL` };
      // 变量型 baseURL（如 baseURL: import.meta.env.VITE_API_BASE）交给 env 探测兜底
      const m2 = txt.match(envRe);
      if (m2 && m2[1] && /env/i.test(m2[1])) continue;
    }
  }
  return null;
}

// 从项目源码推断「校验路径」候选列表（证据式：只收源码里真实存在的接口路径）。
// 思路：登录后第一个要鉴权的接口最能验 token。按语义排序：
//   dashboard（登录后首页数据）> getUser/userInfo/currentUser（用户态）> private（鉴权标记）。
// 返回 [{path, method}]，最多 5 个；扫不到返回 []。
// 扫描范围：src/api 优先（绝大多数项目 API 集中在此），没有再扫 src 根（限文件数防慢）。
function inferCheckPathCandidates(projectRoot) {
  const found = new Map(); // path -> {score, method}
  const URL_RE = /url\s*:\s*['"`](\/[^'"`\s]{3,120})['"`]/g;
  const METHOD_RE = /method\s*:\s*['"`](get|post)['"`]/i;

  const scanFile = (abs) => {
    let txt;
    try { txt = fs.readFileSync(abs, 'utf8'); } catch { return; }
    if (txt.length > 512 * 1024) txt = txt.slice(0, 512 * 1024);
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(txt))) {
      const p = m[1];
      // 跳过静态资源/路由型路径，只收像接口的
      if (/\.(html|png|jpg|css|js|svg|json)$/i.test(p)) continue;
      let score = 0;
      if (/dashboard/i.test(p)) score += 3;
      if (/getuser|userinfo|currentuser|\/user\/|mine|profile|getinfo/i.test(p)) score += 2;
      if (/private|auth|permission|menu/i.test(p)) score += 1;
      if (score === 0) continue;
      // 邻近找 method（接口定义一般是 { url: '...', method: 'post' } 的对象字面量）
      const ctx = txt.slice(Math.max(0, m.index - 200), m.index + 300);
      const mm = ctx.match(METHOD_RE);
      const method = mm ? mm[1].toUpperCase() : 'GET';
      const prev = found.get(p);
      if (!prev || prev.score < score) found.set(p, { score, method });
    }
  };

  const walk = (dir, budget) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return budget; }
    for (const e of entries) {
      if (budget.n <= 0) return budget.n;
      if (e.isDirectory()) {
        if (EXCLUDE_DIR.has(e.name) || e.name.startsWith('.')) continue;
        walk(path.join(dir, e.name), budget);
      } else if (e.isFile() && /\.(ts|js|jsx|tsx|mjs|vue)$/.test(e.name)) {
        budget.n--;
        scanFile(path.join(dir, e.name));
      }
    }
    return budget.n;
  };

  // 优先 src/api（小而准），不够再扫 src（限 400 个文件）
  const apiDir = path.join(projectRoot, 'src', 'api');
  if (fs.existsSync(apiDir)) walk(apiDir, { n: 300 });
  if (found.size < 3 && fs.existsSync(path.join(projectRoot, 'src'))) {
    walk(path.join(projectRoot, 'src'), { n: 400 });
  }

  return [...found.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 5)
    .map(([p, v]) => ({ path: p, method: v.method }));
}

// 从项目源码推断「自定义请求头」——校验 token 时必须复刻 app 真实请求的头，
// 否则后端网关（BFF 类常见：要求 x-clientType 之类的客户端标识）会拒绝校验请求，
// 把有效 token 误判成过期（真实踩坑：demo-admin 缺 x-clientType-header 一律 401）。
// 证据式扫描：headers['x-xxx'] = EXPR / setRequestHeader('x-xxx', EXPR) / 'x-xxx': EXPR。
// 值是字面量直接用；是变量则跨文件解析 <变量名>: '字面量'（如 CLIENT_INFO → 'pc'）；
// 解析不了的（随机数/函数调用，如 x-requestMsgId-header）跳过。
// 返回 { 'x-xxx': 'value' }，扫不到返回 {}。
function inferCustomHeaders(projectRoot) {
  const headers = new Map(); // name -> value 表达式
  let allText = []; // 收集源码文本，供变量解析
  const HEADER_RE = /(?:headers\[\s*['"]([xX][\w-]+)['"]\s*\]\s*=\s*|setRequestHeader\(\s*['"]([xX][\w-]+)['"]\s*,\s*|['"]([xX][\w-]+)['"]\s*:\s*)([^;\n\r}]+)/g;

  const scanFile = (abs) => {
    let txt;
    try { txt = fs.readFileSync(abs, 'utf8'); } catch { return; }
    if (txt.length > 512 * 1024) txt = txt.slice(0, 512 * 1024);
    allText.push(txt);
    let m;
    HEADER_RE.lastIndex = 0;
    while ((m = HEADER_RE.exec(txt))) {
      const name = (m[1] || m[2] || m[3] || '').toLowerCase();
      if (!name || name === 'x-requestid' || /msgid|traceid|correlation/i.test(name)) continue; // 随机值头无意义
      if (!headers.has(name)) headers.set(name, m[4].trim());
    }
  };

  const walk = (dir, budget) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (budget.n <= 0) return;
      if (e.isDirectory()) {
        if (EXCLUDE_DIR.has(e.name) || e.name.startsWith('.')) continue;
        walk(path.join(dir, e.name), budget);
      } else if (e.isFile() && /\.(ts|js|mjs|jsx|tsx|vue)$/.test(e.name)) {
        budget.n--;
        scanFile(path.join(dir, e.name));
      }
    }
  };
  // 请求装配一般在 src/utils（requestService/axios 拦截器），不够再扫 src
  walk(path.join(projectRoot, 'src', 'utils'), { n: 100 });
  walk(path.join(projectRoot, 'src'), { n: 200 });

  const resolveValue = (expr) => {
    // 字面量
    let lit = expr.match(/^['"]([^'"]{1,60})['"]$/);
    if (lit) return lit[1];
    // 变量：跨文件找 <变量名>: '字面量' 或 <变量名> = '字面量'
    const ident = expr.match(/^([A-Za-z_$][\w$.]*)$/);
    if (ident) {
      const varName = ident[1].split('.').pop();
      const re = new RegExp('\\b' + varName.replace(/\$/g, '\\$') + '\\s*[:=]\\s*[\'"]([\\w. -]{1,40})[\'"]');
      for (const txt of allText) {
        const mm = txt.match(re);
        if (mm) return mm[1];
      }
    }
    return null; // 模板串/表达式（随机值等）解析不了
  };

  const out = {};
  let count = 0;
  for (const [name, expr] of headers) {
    const v = resolveValue(expr);
    if (v && /^[\w.-]+$/.test(v)) { out[name] = v; if (++count >= 8) break; }
  }
  return out;
}

// 综合探测：返回完整 tokenConfig，或 null（探不到就完全隐藏 token 区）
function detectTokenConfig(projectRoot) {
  const fromEnv = detectBackendFromEnv(projectRoot);
  const fromSrc = detectBackendFromSrc(projectRoot);
  const found = fromEnv || fromSrc;
  if (!found) return null;
  const candidates = inferCheckPathCandidates(projectRoot);
  const cfg = {
    testBackend: found.backend,
    loginUrl: found.backend + '/login',
    cookieName: 'token',
    checkPath: candidates.length ? candidates[0].path : '',
    checkMethod: candidates.length ? candidates[0].method : 'GET',
    // 候选列表：checkPath 校验失败（404/405）时按序换下一个试，试通的记住
    checkPathCandidates: candidates,
    // 自定义请求头：校验时复刻 app 的真实请求头（BFF 网关常要求客户端标识）
    customHeaders: inferCustomHeaders(projectRoot),
    autoDetected: true,
    source: found.source
  };
  return cfg;
}

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

// 真校验 token：用通用 Bearer 头请求 checkPath，401/402 = 失效。
// 业务码判断放宽：code===0 / '0' / '00000' / success===true 都算成功。
function verifyToken(token, cfg) {
  return new Promise(resolve => {
    if (!token || token.length < 8) { resolve({ ok: false, code: 0, msg: 'token 太短' }); return; }
    if (!cfg.checkPath) { resolve({ ok: false, code: 0, msg: '未配置校验路径（请在下方填入一个需要登录的接口路径，如 /api/user/info）' }); return; }
    let url;
    try { url = new URL(cfg.testBackend + cfg.checkPath); }
    catch { resolve({ ok: false, code: 0, msg: '后端地址或校验路径格式错误' }); return; }
    // 按协议选模块：后端可能是 http（本地 dev 后端很常见）或 https（远程测试环境）
    const transport = url.protocol === 'http:' ? require('http') : require('https');
    const method = (cfg.checkMethod || 'GET').toUpperCase();
    // 请求头：Bearer + 项目自定义头（复刻 app 真实请求，BFF 网关常要求 x-clientType 之类客户端标识，
    // 缺了会把有效 token 误判 401）+ POST 时的 JSON 声明
    const req = transport.request(url, {
      method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
        ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
        ...(cfg.customHeaders || {})
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        const code = res.statusCode;
        if (code === 401 || code === 402 || code === 403) { resolve({ ok: false, code, msg: 'token 已失效（后端拒绝）' }); return; }
        if (code >= 200 && code < 300) {
          // 2xx：尝试解析看业务码
          try {
            const body = JSON.parse(raw);
            const bizOk = body && (body.code === 0 || body.code === '0' || body.code === '00000' || body.success === true || body.ok === true || body.status === 0);
            resolve({
              ok: !!bizOk,
              code: body && body.code,
              msg: bizOk ? 'token 有效' : (body && body.msg || '后端业务码非成功'),
              username: ((body && body.data && (
                body.data.username || body.data.nickname || body.data.name ||
                (body.data.user && (body.data.user.username || body.data.user.nickname || body.data.user.name)) ||
                (body.data.userInfo && (body.data.userInfo.username || body.data.userInfo.nickname))
              )) || '') + (((body && body.data && body.data.tenantEdition && (body.data.tenantEdition.corpName || body.data.tenantEdition.company)) || '') ? ' @ ' + ((body.data.tenantEdition.corpName || body.data.tenantEdition.company)) : '')
            });
          } catch {
            // 2xx 但非 JSON：token 本身是被接受的（后端只是返回了 HTML/空），算有效
            resolve({ ok: true, msg: 'token 有效（后端返回非 JSON）' });
          }
          return;
        }
        resolve({ ok: false, code, msg: `后端返回 ${code}（可能 checkPath 不对，或跨域/路由未命中）` });
      });
    });
    req.on('error', err => resolve({ ok: false, code: -1, msg: '网络错误：' + err.message }));
    if ((cfg.checkMethod || 'GET').toUpperCase() !== 'GET') req.write('{}');
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
.tk-detected{font-size:12px;color:var(--primary-d);background:var(--primary-bg);padding:8px 12px;border-radius:8px;margin-bottom:12px;font-family:-apple-system,sans-serif;line-height:1.6}
.tk-detected code{background:rgba(124,58,237,.15);padding:1px 5px;border-radius:4px}
.tk-cfg{background:var(--bg);border-radius:12px;padding:12px 14px;margin-bottom:14px;font-family:-apple-system,sans-serif}
.tk-cfg summary{cursor:pointer;font-size:13px;color:var(--text-2);user-select:none}
.tk-cfg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-top:12px}
.tk-cfg-grid label{display:flex;flex-direction:column;font-size:11px;color:var(--text-3);gap:4px}
.tk-cfg-grid input,.tk-cfg-grid select{padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:var(--card);color:var(--text);font-family:inherit}
.tk-cfg-grid input:focus,.tk-cfg-grid select:focus{outline:none;border-color:var(--primary)}
</style></head><body>
<div class="hd"><div class="hd-top">
  <div><h1>${escapeHtml(projectName)} · 开发导航</h1>
  <div class="s">扫描到 ${total} 个路由 ｜ <a href="${devBaseUrl}/" target="_blank">打开首页 ${devBaseUrl}/</a></div></div>
  <input class="search-box" id="search" placeholder="搜索路由路径或名称…" autocomplete="off">
</div></div>
<div class="wrap">

${tokenBlock(tc, hasCookieToken)}

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
const TOKEN_ENABLED = ${tc ? 'true' : 'false'};
const HAS_TOKEN = ${hasCookieToken ? 'true' : 'false'};
const el = id => document.getElementById(id);

if (TOKEN_ENABLED) {
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
      if(cj.ok){ show('ok','✓ 登录态已建立'+(cj.username?('：'+cj.username):'')); meta('上次校验：'+fmtTime()+' · token 有效，现在可以点路由进入页面。'); }
      else { show('err','✗ cookie 已写但 token 校验失败：'+(cj.msg||'')); meta('上次校验：'+fmtTime()+' · '+((cj.code===401||cj.code===402)?'token 已过期，请重新复制。':'请确认 token 和「校验接口路径」是否正确。')); }
    }catch(e){ show('err','✗ '+e.message); }
  }
  async function checkToken(){
    show('info','校验中…');
    const r = await fetch('/api/token-check');
    const j = await r.json();
    if(j.ok){ show('ok','✓ token 有效'+(j.username?('：'+j.username):'')); meta('上次校验：'+fmtTime()); }
    else { show('err','✗ '+ (j.msg||'未登录')); meta('上次校验：'+fmtTime()+' · '+(j.code===401?'token 已过期':'请先粘贴 token，或检查校验路径')); }
  }
  async function clearToken(){
    if(!confirm('确定清除本地 token cookie 吗？')) return;
    await fetch('/api/token',{method:'DELETE'});
    show('info','已清除'); meta(''); el('tokenInput').value='';
  }
  async function saveCfg(){
    const cfg = {
      testBackend: el('cfgBackend').value.trim(),
      loginUrl: el('cfgLoginUrl').value.trim(),
      cookieName: el('cfgCookieName').value.trim() || 'token',
      checkPath: el('cfgCheckPath').value.trim(),
      checkMethod: el('cfgCheckMethod').value
    };
    try{
      const r = await fetch('/api/token-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
      const j = await r.json();
      if(j.ok){ show('ok','✓ 配置已保存，刷新页面生效'); setTimeout(()=>location.reload(), 600); }
      else { show('err','✗ 保存失败：'+(j.msg||'')); }
    }catch(e){ show('err','✗ '+e.message); }
  }
  el('btnApply').onclick=applyToken; el('btnCheck').onclick=checkToken; el('btnClear').onclick=clearToken;
  var btnSaveCfg = el('btnSaveCfg'); if(btnSaveCfg) btnSaveCfg.onclick=saveCfg;
  if(HAS_TOKEN) checkToken(); else { show('','未注入 token（需要登录态的项目请按上方步骤粘贴）'); }
}

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

// 启动导航 server。
// tokenConfig：用户已保存的配置（来自 store）。若为 null 则自动探测项目代码。
//   - 自动探测到 → 显示 token 区，标记 autoDetected，用户可改后保存
//   - 探测不到 → 不显示 token 区（对不需要登录态的项目零干扰）
// onSaveConfig：用户在 UI 改配置后回调，由 main 写回 store（持久化）。
function createDevNavServer({ projectRoot, projectName, devBaseUrl, onLog, tokenConfig, onSaveConfig }) {
  const log = (...a) => { try { (onLog || console.log)(...a); } catch {} };
  const routes = scanRoutes(projectRoot);
  log(`[nav] 扫描到 ${routes.length} 个路由`);

  // 合并配置：用户保存的 > 自动探测的。两者都没有 = null（不显示 token 区）
  // 防护1：用户保存了空对象（testBackend 为空）→ 当作未配置，重新探测
  // 防护2：用户保存时留空的字段（尤其 checkPath）→ 回填本次自动探测值，
  //        避免早期保存的旧配置（checkPath 空）永远压住新的探测结果
  const auto = detectTokenConfig(projectRoot);
  let tc;
  if (tokenConfig && tokenConfig.testBackend) {
    tc = { ...(auto || {}), ...tokenConfig };
    if (!tc.checkPath && auto && auto.checkPath) tc.checkPath = auto.checkPath;
    if (!tc.checkPathCandidates || !tc.checkPathCandidates.length) {
      if (auto && auto.checkPathCandidates) tc.checkPathCandidates = auto.checkPathCandidates;
    }
  } else {
    tc = auto;
  }
  if (tc) log(`[nav] token 配置来源：${tc.autoDetected ? '自动探测（' + (tc.source || '') + '）' : '用户保存'} → ${tc.testBackend}${tc.checkPath ? '，校验路径 ' + tc.checkPath : ''}`);

  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    const cookies = parseCookies(req.headers.cookie);
    const cookieName = tc ? (tc.cookieName || 'token') : 'token';

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(renderDevNav(projectName, devBaseUrl, routes, tc, !!(tc && cookies[cookieName])));
      return;
    }

    // 以下 token 相关接口，仅当 tc 存在时才有意义
    if (!tc) {
      if (url.startsWith('/api/token')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"msg":"本项目未启用 token 注入"}'); return; }
    } else {
      // token 写入
      if (url === '/api/token' && req.method === 'POST') {
        const raw = await new Promise(r => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>r(b)); });
        let parsed; try { parsed = JSON.parse(raw); } catch { res.writeHead(400); res.end('{"ok":false,"msg":"非 JSON"}'); return; }
        const token = parsed && parsed.token;
        if (!token || typeof token !== 'string' || token.length < 8) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"msg":"token 不合法"}'); return;
        }
        res.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(token)}; Path=/; Max-Age=604800; SameSite=Lax`);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
      }
      // token 校验（带候选路径轮试：checkPath 404/405 时按探测候选换下一个，试通自动记住）
      if (url === '/api/token-check' && req.method === 'GET') {
        const token = cookies[cookieName] ? decodeURIComponent(cookies[cookieName]) : '';
        if (!token) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"code":0,"msg":"本地无 token cookie"}'); return; }
        let result = await verifyToken(token, tc);
        const pathWrong = (r) => r && !r.ok && (r.code === 404 || r.code === 405 ||
          /未配置校验路径|可能 checkPath 不对/.test(r.msg || ''));
        // 鉴权拒绝兜底：401/402/403 可能是缺自定义请求头（藏在 node_modules 请求库里，源码扫不到）。
        // 补上 BFF 网关惯用的客户端标识头重试一次，成功则把生效的头持久化。
        const authRejected = (r) => r && !r.ok && (r.code === 401 || r.code === 402 || r.code === 403);
        if (authRejected(result)) {
          let host = '';
          try { host = new URL(tc.testBackend).host; } catch {}
          const existing = tc.customHeaders && (tc.customHeaders['x-clienttype-header'] || tc.customHeaders['x-clientType-header']);
          const compatHeaders = {
            ...(tc.customHeaders || {}),
            'x-clienttype-header': existing || 'pc',
            ...(host ? { 'x-header-host': host } : {})
          };
          const r2 = await verifyToken(token, { ...tc, customHeaders: compatHeaders });
          if (r2.ok) {
            result = { ...r2, msg: (r2.msg || '') + '（已自动补齐客户端标识请求头）' };
            tc = { ...tc, customHeaders: compatHeaders };
            try { if (onSaveConfig) onSaveConfig(tc); } catch {}
            log('[nav] 补齐自定义请求头后校验通过，已记住');
          }
        }
        if (pathWrong(result)) {
          const candidates = (tc.checkPathCandidates || [])
            .filter(c => c && c.path && c.path !== tc.checkPath);
          for (const c of candidates) {
            const tryCfg = { ...tc, checkPath: c.path, checkMethod: c.method || 'GET' };
            const r2 = await verifyToken(token, tryCfg);
            if (!pathWrong(r2)) {
              result = { ...r2, msg: (r2.msg || '') + `（自动换用校验路径 ${c.path}，已记住）` };
              // 试通的路径写回配置并持久化，下次直接用
              tc = { ...tc, checkPath: c.path, checkMethod: c.method || 'GET' };
              try { if (onSaveConfig) onSaveConfig(tc); } catch {}
              log(`[nav] 校验路径自动命中：${c.path}（${c.method || 'GET'}）`);
              break;
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); return;
      }
      // token 清除
      if (url === '/api/token' && req.method === 'DELETE') {
        res.setHeader('Set-Cookie', `${cookieName}=; Path=/; Max-Age=0`);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
      }
      // 配置保存（用户在 UI 改了后端/cookie/路径后点保存）
      if (url === '/api/token-config' && req.method === 'POST') {
        const raw = await new Promise(r => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>r(b)); });
        let parsed; try { parsed = JSON.parse(raw); } catch { res.writeHead(400); res.end('{"ok":false,"msg":"非 JSON"}'); return; }
        // 更新运行时 tc，并回调 main 持久化
        tc = { ...tc, ...parsed, autoDetected: false };
        try { if (onSaveConfig) onSaveConfig(tc); } catch (e) { log('[nav] 保存配置回调失败：' + e.message); }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
      }
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

module.exports = { createDevNavServer, scanRoutes, extractRoutes, detectTokenConfig };
