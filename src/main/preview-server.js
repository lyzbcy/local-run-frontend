// 内嵌静态预览服务器。
// 复用 lyzbcy-zeen-tools 的 local-preview-server.js 思路，改造为"以用户项目为 root、不写任何文件"。
// 关键能力：静态文件服务 + 路由别名 + 目录页注入（GET /__nav__）+ SPA fallback（可选）。

const http = require('http');
const fs = require('fs');
const path = require('path');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf'
};

// 扫描项目里的 html 文件，用于目录页。排除常见非业务目录。
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.output',
  '.cache', '.vscode', '.idea', 'zeen-tools', '.preview', 'coverage'
]);

function scanHtmlFiles(root, maxDepth = 2) {
  const results = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.')) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && (e.name.endsWith('.html') || e.name.endsWith('.htm'))) {
        const abs = path.join(dir, e.name);
        const rel = '/' + path.relative(root, abs).split(path.sep).join('/');
        results.push({ rel, abs });
      }
    }
  };
  walk(root, 0);
  return results;
}

function extractTitle(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    const head = buf.toString('utf8', 0, Math.min(buf.length, 4096));
    const m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m && m[1]) {
      const t = m[1].replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
  } catch {}
  return null;
}

// 生成目录页 HTML。按一级目录自动分类 + 搜索 + 推广区。
function renderNavPage(projectName, baseUrl, htmlFiles) {
  const items = htmlFiles.map(f => {
    const title = extractTitle(f.abs) || path.basename(f.rel);
    const isIndex = /(^|\/)index\.html?$/i.test(f.rel);
    // 一级目录名作为分类（根目录的算"首页"）
    const seg = f.rel.split('/').filter(Boolean);
    const category = seg.length <= 1 ? '首页' : seg[0];
    return { rel: f.rel, title, isIndex, category };
  });

  // 按分类分组，保持顺序：首页优先，其余按名字
  const catOrder = ['首页'];
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.category)) { groups.set(it.category, []); if (!catOrder.includes(it.category)) catOrder.push(it.category); }
    groups.get(it.category).push(it);
  }
  // 每组内：首页优先，再按路径
  for (const arr of groups.values()) {
    arr.sort((a, b) => (a.isIndex !== b.isIndex ? (a.isIndex ? -1 : 1) : a.rel.localeCompare(b.rel)));
  }

  const CAT_ICON = { '首页': '🏠', casePage: '📖', schemePage: '🛠️', page: '📄', common: '🧩' };
  const sections = catOrder.filter(c => groups.get(c).length).map(cat => {
    const list = groups.get(cat);
    const icon = CAT_ICON[cat] || '📁';
    const cards = list.map(it => {
      const href = baseUrl + it.rel;
      const tag = it.isIndex ? '<span class="tag">首页</span>' : '';
      return `<a class="card" href="${href}" target="_blank" data-search="${escapeHtml((it.title + ' ' + it.rel).toLowerCase())}">
        <div class="ct">${escapeHtml(it.title)}${tag}</div>
        <div class="cu">${escapeHtml(it.rel)}</div>
      </a>`;
    }).join('');
    return `<div class="section" data-cat="${escapeHtml(cat)}">
      <div class="section-title">${icon} ${escapeHtml(cat)} <span class="count">${list.length}</span></div>
      <div class="cards">${cards}</div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(projectName)} · 目录页</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
         background:#f5f7fa; color:#1d2129; }
  .hd { padding:18px 28px; background:linear-gradient(135deg,#409eff,#36cfc9); color:#fff;
        position:sticky; top:0; z-index:3; box-shadow:0 2px 8px rgba(0,0,0,.08); }
  .hd-top { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; }
  .hd h1 { margin:0; font-size:20px; font-weight:600; }
  .hd .sub { font-size:13px; opacity:.9; margin-top:6px; }
  .hd .sub a { color:#fff; text-decoration:underline; }
  .search-box { background:rgba(255,255,255,.18); border:1px solid rgba(255,255,255,.3); border-radius:8px;
    padding:8px 14px; color:#fff; font-size:14px; width:280px; max-width:100%; backdrop-filter:blur(4px); }
  .search-box::placeholder { color:rgba(255,255,255,.7); }
  .search-box:focus { outline:none; background:rgba(255,255,255,.28); }
  .wrap { max-width:1200px; margin:0 auto; padding:20px 28px; }
  .section { margin-bottom:24px; }
  .section-title { font-size:15px; font-weight:600; color:#4e5969; margin-bottom:12px;
    display:flex; align-items:center; gap:8px; }
  .count { font-size:12px; background:#e8f3ff; color:#409eff; padding:1px 8px; border-radius:10px; font-weight:400; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:12px; }
  .card { display:flex; flex-direction:column; gap:6px; padding:14px 16px; background:#fff;
          border:1px solid #e5e6eb; border-radius:10px; text-decoration:none; color:#1d2129;
          transition:all .18s; }
  .card:hover { transform:translateY(-2px); border-color:#409eff; box-shadow:0 6px 16px rgba(64,158,255,.18); }
  .ct { font-size:14px; font-weight:500; display:flex; align-items:center; gap:8px; }
  .cu { font-size:11px; color:#86909c; word-break:break-all; font-family:ui-monospace,Menlo,monospace; }
  .tag { font-size:11px; background:#e8f3ff; color:#409eff; padding:2px 8px; border-radius:10px; font-weight:400; }
  .empty { text-align:center; padding:60px 20px; color:#86909c; }
  .no-match { display:none; text-align:center; padding:40px; color:#86909c; }
  /* 推广区 */
  .promo { margin-top:32px; padding:28px; background:#fff; border-radius:14px; box-shadow:0 1px 4px rgba(0,0,0,.06); }
  .promo h2 { margin:0 0 6px; font-size:16px; text-align:center; }
  .promo .pdesc { text-align:center; color:#86909c; font-size:13px; margin-bottom:20px; }
  .qr-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:18px; max-width:520px; margin:0 auto; }
  .qr-cell { text-align:center; }
  .qr-cell img { width:120px; height:120px; object-fit:cover; border-radius:8px; border:1px solid #f0f1f3; }
  .qr-cell .label { font-size:12px; color:#4e5969; margin-top:6px; }
  .ft { text-align:center; padding:24px; color:#c9cdd4; font-size:12px; }
  .ft a { color:#409eff; text-decoration:none; }
</style>
</head>
<body>
<div class="hd">
  <div class="hd-top">
    <div>
      <h1>${escapeHtml(projectName)} · 目录页</h1>
      <div class="sub">共 ${items.length} 个页面，按栏目分类 ｜ <a href="${baseUrl}/" target="_blank">打开首页 ${baseUrl}/</a></div>
    </div>
    <input class="search-box" id="search" placeholder="🔍 搜索页面标题或路径…" autocomplete="off">
  </div>
</div>
<div class="wrap">
  ${items.length
    ? sections
    : `<div class="empty">没扫到 html 页面。<br>这个项目可能是框架项目，直接 <a href="${baseUrl}/" target="_blank">打开首页</a> 试试。</div>`}
  <div class="no-match" id="noMatch">没找到匹配的页面</div>

  <div class="promo">
    <h2>这个工具对你有用吗？</h2>
    <div class="pdesc">「本地运行前端项目」开源免费，一键启动任意前端项目，不往项目里写任何文件。</div>
    <div class="qr-grid">
      <div class="qr-cell"><img src="https://lyzbcy.github.io/local-run-frontend/assets/reward-qr.jpg" alt="赞赏"><div class="label">请作者喝奶茶</div></div>
      <div class="qr-cell"><img src="https://lyzbcy.github.io/local-run-frontend/assets/sticker-qr.png" alt="表情包"><div class="label">星星布丁表情包</div></div>
      <div class="qr-cell"><img src="https://lyzbcy.github.io/local-run-frontend/assets/group-qr.jpg" alt="粉丝群"><div class="label">加入粉丝群</div></div>
    </div>
  </div>

  <div class="ft">由 <a href="https://github.com/lyzbcy/local-run-frontend" target="_blank">本地运行前端项目</a> 生成</div>
</div>
<script>
(function(){
  var input = document.getElementById('search');
  var noMatch = document.getElementById('noMatch');
  var sections = document.querySelectorAll('.section');
  if(!input) return;
  input.addEventListener('input', function(){
    var q = input.value.trim().toLowerCase();
    var totalShown = 0;
    sections.forEach(function(sec){
      var cards = sec.querySelectorAll('.card');
      var shown = 0;
      cards.forEach(function(c){
        var s = c.getAttribute('data-search') || '';
        var hit = !q || s.indexOf(q) !== -1;
        c.style.display = hit ? '' : 'none';
        if(hit) shown++;
      });
      // 整个分类没匹配就隐藏分类标题
      sec.style.display = shown ? '' : 'none';
      totalShown += shown;
    });
    noMatch.style.display = totalShown ? 'none' : '';
  });
})();
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// 扫描项目所有 html 的 <base href>，收集 base 前缀集合。
// 真实项目用 <base href="/mobile/"> 改写相对路径解析根，浏览器据此把 ../css/x 解析成 /mobile/css/x。
// 服务器需知道这些 base 前缀，才能把 /mobile/css/x 正确映射回磁盘根的 /css/x。
// 只收集「以 / 开头、以 / 结尾」的目录型 base（如 /mobile/、/home/page/），按长度降序排（最长前缀优先匹配）。
function scanBaseHrefs(root) {
  const baseSet = new Set();
  const htmls = scanHtmlFiles(root, 3); // 扫深一点，3 层
  for (const f of htmls) {
    try {
      const buf = fs.readFileSync(f.abs);
      const head = buf.toString('utf8', 0, Math.min(buf.length, 4096));
      const m = head.match(/<base[^>]*\shref=["']([^"']*)["']/i);
      if (m && m[1]) {
        let b = m[1];
        // 规范化成 /xxx/ 形式（绝对路径、目录型）
        if (b.startsWith('/') && !b.endsWith('/')) b = b + '/';
        if (b.startsWith('/') && b.endsWith('/') && b !== '/') baseSet.add(b);
      }
    } catch {}
  }
  // 按长度降序，最长前缀优先匹配（/mobile/casePage/ 优先于 /mobile/）
  return [...baseSet].sort((a, b) => b.length - a.length);
}

// routeAliases 形如 { '/m/case': '/casePage/caseIndex.html' }，来自 detector 或用户配置。
function createPreviewServer({ root, projectName, port, routeAliases = {}, onLog }) {
  const log = (...a) => { try { (onLog || console.log)(...a); } catch {} };

  // 启动时扫一次 <base href>，建显式映射表（替代猜测式 prefix-strip）
  const basePrefixes = scanBaseHrefs(root);
  if (basePrefixes.length) log(`[base-href] 检测到 ${basePrefixes.length} 个 base 前缀：${basePrefixes.join(', ')}`);

  // 用 base 前缀把 URL 映射回磁盘根。最长前缀精确匹配，匹配不上就原样返回（不做任何猜测）。
  const mapByBaseHref = (urlPath) => {
    for (const prefix of basePrefixes) {
      if (urlPath.startsWith(prefix)) {
        return '/' + urlPath.slice(prefix.length);
      }
    }
    return urlPath;
  };

  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

    // 目录页注入
    if (urlPath === '/__nav__' || urlPath === '/__nav__/') {
      const html = renderNavPage(projectName, `http://127.0.0.1:${port}`, scanHtmlFiles(root));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
      return;
    }

    // 默认首页
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

    // 别名
    if (routeAliases[urlPath]) urlPath = routeAliases[urlPath];

    // base-href 映射：若请求路径以已知 base 前缀开头，剥掉前缀映射回磁盘根。
    // 这是对 <base href> 语义的正确实现（替代旧的猜测式 prefix-strip，后者会在边界返回错误文件还报200）。
    if (basePrefixes.length) urlPath = mapByBaseHref(urlPath);

    let filePath = path.normalize(path.join(root, urlPath));

    // 防穿越
    if (!filePath.startsWith(root)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    // 解析真实文件路径。先 stat，根据结果决定回退策略。
    fs.stat(filePath, (err, stats) => {
      if (!err && stats.isDirectory()) {
        // 目录访问：按优先级找入口文件
        resolveDirIndex(filePath, (resolved) => {
          if (resolved) serveFile(resolved);
          else serveDirListing(filePath, urlPath); // 都没有 → 目录列表
        });
        return;
      }

      // 不是目录（文件或不存在）
      if (!err && stats.isFile()) return serveFile(filePath);

      // 不存在 → 无后缀时尝试补 .html，再试当目录
      if (!path.extname(filePath)) {
        const htmlCandidate = filePath + '.html';
        if (fs.existsSync(htmlCandidate)) return serveFile(htmlCandidate);
        // 也许是没带斜杠的目录（如 /casePage）
        fs.stat(filePath, (e2, s2) => {
          if (!e2 && s2.isDirectory()) {
            resolveDirIndex(filePath, (resolved) => {
              if (resolved) serveFile(resolved);
              else serveDirListing(filePath, urlPath);
            });
            return;
          }
          notFound();
        });
        return;
      }
      notFound();
    });

    // --- 辅助：目录入口解析。index.html → index.htm → 唯一 html ---
    function resolveDirIndex(dirPath, cb) {
      const candidates = ['index.html', 'index.htm', 'default.html'];
      for (const c of candidates) {
        const full = path.join(dirPath, c);
        if (fs.existsSync(full)) return cb(full);
      }
      // 该目录是否只有一个 html 文件？若是，直接用它当入口
      try {
        const htmls = fs.readdirSync(dirPath).filter(f => f.endsWith('.html') || f.endsWith('.htm'));
        if (htmls.length === 1) return cb(path.join(dirPath, htmls[0]));
      } catch {}
      cb(null);
    }

    // --- 辅助：目录列表（类 nginx autoindex）---
    function serveDirListing(dirPath, reqPath) {
      let entries;
      try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
      catch { return notFound(); }
      // 确保路径以 / 结尾，方便拼链接
      const base = reqPath.endsWith('/') ? reqPath : reqPath + '/';
      const items = entries
        .filter(e => !e.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map(e => {
          const slash = e.isDirectory() ? '/' : '';
          const ico = e.isDirectory() ? '📁' : (e.name.endsWith('.html') ? '📄' : '📦');
          return `<li><a href="${base}${encodeURIComponent(e.name)}${slash}">${ico} ${escapeHtml(e.name)}${slash}</a></li>`;
        }).join('');
      const parent = reqPath !== '/' ? `<li><a href="${base}..">📁 ..</a></li>` : '';
      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(projectName)} · ${escapeHtml(reqPath)}</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1d2129}
h1{font-size:18px;font-weight:600}ul{list-style:none;padding:0}li{padding:8px 12px;border-bottom:1px solid #f0f1f3}
a{color:#409eff;text-decoration:none}a:hover{text-decoration:underline}.path{color:#86909c;font-size:13px;font-family:monospace}
.ft{margin-top:24px;color:#c9cdd4;font-size:12px;text-align:center}</style></head>
<body><h1>${escapeHtml(projectName)}</h1><div class="path">${escapeHtml(reqPath)}</div><ul>${parent}${items || '<li>空目录</li>'}</ul>
<div class="ft">由 本地运行前端项目 生成</div></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
      log(`[200/dir] ${reqPath}`);
    }

    function serveFile(fp) {
      fs.readFile(fp, (e, content) => {
        if (e) return notFound();
        const ext = path.extname(fp).toLowerCase();
        res.writeHead(200, {
          'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache'
        });
        res.end(content);
      });
    }

    function notFound() {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Not Found: ${urlPath}`);
      log(`[404] ${urlPath}`);
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(`[preview] ${projectName} 已启动 → http://127.0.0.1:${port}`);
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

module.exports = { createPreviewServer, scanHtmlFiles, extractTitle };
