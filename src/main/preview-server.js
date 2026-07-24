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

// 生成目录页 HTML。baseUrl 是 server 的根（http://host:port），htmlFiles 是 scanHtmlFiles 结果。
function renderNavPage(projectName, baseUrl, htmlFiles) {
  const items = htmlFiles.map(f => {
    const title = extractTitle(f.abs) || path.basename(f.rel);
    const isIndex = /(^|\/)index\.html?$/i.test(f.rel);
    return { rel: f.rel, title, isIndex };
  });
  // 首页排前面
  items.sort((a, b) => {
    if (a.isIndex !== b.isIndex) return a.isIndex ? -1 : 1;
    return a.rel.localeCompare(b.rel);
  });

  const cards = items.map(it => {
    const href = baseUrl + it.rel;
    const tag = it.isIndex ? '<span class="tag">首页</span>' : '';
    return `<a class="card" href="${href}" target="_blank">
      <div class="ct">${escapeHtml(it.title)}${tag}</div>
      <div class="cu">${escapeHtml(it.rel)}</div>
    </a>`;
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
  .hd { padding:20px 28px; background:linear-gradient(135deg,#409eff,#36cfc9); color:#fff;
        position:sticky; top:0; z-index:2; box-shadow:0 2px 8px rgba(0,0,0,.08); }
  .hd h1 { margin:0; font-size:20px; font-weight:600; }
  .hd .sub { font-size:13px; opacity:.9; margin-top:6px; }
  .hd .sub a { color:#fff; text-decoration:underline; }
  .wrap { max-width:1200px; margin:0 auto; padding:20px 28px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:14px; }
  .card { display:flex; flex-direction:column; gap:6px; padding:16px 18px; background:#fff;
          border:1px solid #e5e6eb; border-radius:10px; text-decoration:none; color:#1d2129;
          transition:all .18s; }
  .card:hover { transform:translateY(-2px); border-color:#409eff; box-shadow:0 6px 16px rgba(64,158,255,.18); }
  .ct { font-size:15px; font-weight:500; display:flex; align-items:center; gap:8px; }
  .cu { font-size:12px; color:#86909c; word-break:break-all; font-family:ui-monospace,Menlo,monospace; }
  .tag { font-size:11px; background:#e8f3ff; color:#409eff; padding:2px 8px; border-radius:10px; font-weight:400; }
  .empty { text-align:center; padding:60px 20px; color:#86909c; }
  .ft { text-align:center; padding:30px; color:#c9cdd4; font-size:12px; }
  .ft a { color:#409eff; text-decoration:none; }
</style>
</head>
<body>
<div class="hd">
  <h1>${escapeHtml(projectName)} · 目录页</h1>
  <div class="sub">共 ${items.length} 个页面 ｜ <a href="${baseUrl}/" target="_blank">打开首页 ${baseUrl}/</a></div>
</div>
<div class="wrap">
  ${items.length
    ? `<div class="cards">${cards}</div>`
    : `<div class="empty">没扫到 html 页面。<br>这个项目可能是框架项目，直接 <a href="${baseUrl}/" target="_blank">打开首页</a> 试试。</div>`}
  <div class="ft">由 <a href="https://github.com/lyzbcy/local-run-frontend" target="_blank">本地运行前端项目</a> 生成</div>
</div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// routeAliases 形如 { '/m/case': '/casePage/caseIndex.html' }，来自 detector 或用户配置。
function createPreviewServer({ root, projectName, port, routeAliases = {}, onLog }) {
  const log = (...a) => { try { (onLog || console.log)(...a); } catch {} };

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

    // mobile 前缀剥离：很多移动端项目 HTML 用相对路径引用资源，
    // 从 /mobile/xxx 或 /m/xxx 进入时，相对路径会多一层 /mobile 前缀导致 404。
    // 这里做通用兜底：如果带 /mobile/ 或 /m/ 前缀且文件不存在，剥掉前缀重试。
    const stripMobilePrefix = (p) => {
      if (p.startsWith('/mobile/')) return p.replace('/mobile/', '/');
      if (p.startsWith('/m/') && !routeAliases[p]) return p.replace('/m/', '/');
      return p;
    };

    let filePath = path.normalize(path.join(root, urlPath));

    // 防穿越
    if (!filePath.startsWith(root)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    // mobile 前缀剥离兜底：文件不存在时，剥掉 /mobile/ 或 /m/ 前缀重试
    if (!fs.existsSync(filePath) && (urlPath.startsWith('/mobile/') || urlPath.startsWith('/m/'))) {
      const stripped = stripMobilePrefix(urlPath);
      if (stripped !== urlPath) {
        const strippedPath = path.normalize(path.join(root, stripped));
        if (strippedPath.startsWith(root) && fs.existsSync(strippedPath)) {
          filePath = strippedPath;
        }
      }
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
