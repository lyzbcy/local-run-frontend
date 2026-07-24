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

function renderDevNav(projectName, devBaseUrl, routes) {
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

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(projectName)} · 开发导航</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f7fa;color:#1d2129}
.hd{padding:18px 24px;background:linear-gradient(135deg,#409eff,#36cfc9);color:#fff;position:sticky;top:0;z-index:2}
.hd h1{margin:0;font-size:18px;font-weight:600}.hd .s{font-size:13px;opacity:.9;margin-top:4px}
.hd .s a{color:#fff;text-decoration:underline}
.wrap{max-width:1100px;margin:0 auto;padding:18px 24px}
.grp{margin-bottom:18px}.gh{font-size:14px;font-weight:600;color:#4e5969;margin-bottom:8px;font-family:ui-monospace,monospace}
.gc{background:rgba(0,0,0,.1);padding:1px 7px;border-radius:8px;font-size:11px;margin-left:6px}
.gl{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px}
.r{display:flex;flex-direction:column;gap:2px;padding:10px 14px;background:#fff;border:1px solid #e5e6eb;border-radius:8px;text-decoration:none;color:#1d2129;transition:all .15s}
.r:hover{transform:translateY(-1px);border-color:#409eff;box-shadow:0 4px 12px rgba(64,158,255,.15)}
.rp{font-size:13px;font-family:ui-monospace,monospace;color:#409eff;font-weight:500}.rt{font-size:11px;color:#86909c}
.ft{text-align:center;padding:24px;color:#c9cdd4;font-size:12px}
</style></head><body>
<div class="hd"><h1>🧭 ${escapeHtml(projectName)}</h1>
<div class="s">扫描到 ${total} 个路由 ｜ <a href="${devBaseUrl}/" target="_blank">打开首页 ${devBaseUrl}/</a></div></div>
<div class="wrap">${blocks || '<div style="text-align:center;padding:40px;color:#86909c">没扫到路由（可能路由不在 src/router 下）。直接打开首页吧。</div>'}</div>
<div class="ft">由 本地运行前端项目 生成 · 链接指向 dev server</div>
</body></html>`;
}

// 启动导航 server。返回 { server, port, navUrl }。
function createDevNavServer({ projectRoot, projectName, devBaseUrl, onLog }) {
  const log = (...a) => { try { (onLog || console.log)(...a); } catch {} };
  const routes = scanRoutes(projectRoot);
  log(`[nav] 扫描到 ${routes.length} 个路由`);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(renderDevNav(projectName, devBaseUrl, routes));
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
