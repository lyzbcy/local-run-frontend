// 真实项目端到端诊断：起预览服务，像真实浏览器一样（遵守 <base href>）请求每个页面和资源。
// 输出：页面数 / 资源请求数 / 200 / 404 / 其他。
// 运行：node test/diag-real.js

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { createPreviewServer } = require('../src/main/preview-server');

function get(url, redirects = 0) {
  return new Promise(resolve => {
    if (redirects > 5) return resolve({ status: -2, body: '' });
    const req = http.get(url, res => {
      // 跟随 301/302（目录补斜杠等）
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(get(next, redirects + 1));
      }
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers || {} }));
    }).on('error', e => resolve({ status: -1, body: '', err: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ status: -3, body: '' }); });
  });
}

// 从 HTML 解析 <base href>、link href、script src、img src。
function parseHtmlRefs(html, pageUrl) {
  const base = { href: null };
  let m = html.match(/<base[^>]*\shref=["']([^"']*)["']/i);
  if (m) base.href = m[1];
  // 计算 base URL（页面 URL 的目录 + base.href）
  let baseUrlForResolve;
  if (base.href) {
    baseUrlForResolve = new URL(base.href, pageUrl);
    // <base href="/home/page/"> 是目录引用，浏览器会用它作为整个解析根
  } else {
    // 无 base：相对路径相对页面所在目录
    const u = new URL(pageUrl);
    baseUrlForResolve = new URL('./', u);
  }
  const refs = [];
  const push = (attr, re) => {
    let mm; const r = new RegExp(re, 'gi');
    while ((mm = r.exec(html))) refs.push({ attr, raw: mm[1] });
  };
  push('link', '<link[^>]*\\shref=["\']([^"\']*)["\']');
  push('script', '<script[^>]*\\ssrc=["\']([^"\']*)["\']');
  push('img', '<img[^>]*\\ssrc=["\']([^"\']*)["\']');
  push('img-srcset', '<img[^>]*\\ssrcset=["\']([^"\']*)["\']');
  // 把每个 raw 解析成绝对 URL（像浏览器）；跳过 data:、锚点、外部 http(s)
  const resolved = [];
  for (const r of refs) {
    const raw = r.raw;
    if (!raw || raw.startsWith('data:') || raw.startsWith('#')) continue;
    if (/^https?:\/\//i.test(raw) || raw.startsWith('//')) continue; // 外链或协议相对
    if (raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) continue;
    let abs;
    try { abs = new URL(raw, baseUrlForResolve).pathname + (new URL(raw, baseUrlForResolve).search || ''); }
    catch { continue; }
    // srcset 多 URL
    if (r.attr === 'img-srcset') {
      // 形如 "a.png 1x, b.png 2x"
      for (const part of raw.split(',')) {
        const u = part.trim().split(/\s+/)[0];
        if (!u || /^https?:|^data:|^\/\//.test(u)) continue;
        try { const a2 = new URL(u, baseUrlForResolve); resolved.push({ attr: 'srcset', path: a2.pathname + (a2.search || '') }); } catch {}
      }
      continue;
    }
    resolved.push({ attr: r.attr, path: abs });
  }
  return { baseHref: base.href, refs: resolved };
}

async function diagnoseProject(name, root) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`项目：${name}`);
  console.log(`路径：${root}`);
  console.log('='.repeat(70));
  const { server } = await createPreviewServer({ root, projectName: name, port: 0, onLog: () => {} });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // 1. 目录页
  const nav = await get(`${base}/__nav__`);
  const pageLinks = [];
  if (nav.status === 200) {
    const re = /href=["'](\/[^"']*\.(?:html?))["']/gi;
    let mm;
    while ((mm = re.exec(nav.body))) pageLinks.push(mm[1]);
  }
  // 兜底：如果目录页没扫到（maxDepth=2 可能漏），直接用文件系统扫
  if (pageLinks.length === 0) {
    const walk = (dir, d) => {
      if (d > 3) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', 'zeen-tools'].includes(e.name)) continue;
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, d + 1);
        else if (e.name.endsWith('.html')) pageLinks.push('/' + path.relative(root, p).split(path.sep).join('/'));
      }
    };
    try { walk(root, 0); } catch {}
  }
  const uniqPages = [...new Set(pageLinks)].sort();
  console.log(`目录页: HTTP ${nav.status} ｜ 扫到页面: ${uniqPages.length}`);

  // 2. 请求每个页面
  let pages200 = 0, pages404 = 0, pagesOther = 0;
  const pageResults = [];
  for (const p of uniqPages) {
    const r = await get(base + p);
    if (r.status === 200) pages200++;
    else if (r.status === 404) pages404++;
    else pagesOther++;
    pageResults.push({ path: p, status: r.status });
  }
  console.log(`页面状态: 200=${pages200}  404=${pages404}  其他=${pagesOther}`);

  // 3. 解析每个 200 页面的资源，逐个请求
  let res200 = 0, res404 = 0, resOther = 0, resTotal = 0;
  const sample404 = [];
  const baseHrefUsage = {};
  const seen = new Set();
  for (const pr of pageResults) {
    if (pr.status !== 200) continue;
    const r = await get(base + pr.path);
    const { baseHref, refs } = parseHtmlRefs(r.body, base + pr.path);
    if (baseHref) baseHrefUsage[baseHref] = (baseHrefUsage[baseHref] || 0) + 1;
    for (const ref of refs) {
      const key = ref.path;
      if (seen.has(key)) continue;
      seen.add(key);
      resTotal++;
      const rr = await get(base + key);
      if (rr.status === 200) res200++;
      else if (rr.status === 404) { res404++; if (sample404.length < 25) sample404.push({ from: pr.path, baseHref, attr: ref.attr, req: key }); }
      else resOther++;
    }
  }

  console.log(`\n资源状态（已去重）: 共=${resTotal}  200=${res200}  404=${res404}  其他=${resOther}`);
  const brokenRate = resTotal ? (res404 / resTotal * 100).toFixed(1) : '0';
  console.log(`资源 404 率: ${brokenRate}%`);
  console.log(`页面使用的 <base href> 分布:`, baseHrefUsage);
  if (sample404.length) {
    console.log(`\n--- 404 资源样本（最多25条）---`);
    for (const s of sample404) {
      console.log(`  [${s.attr}] 页=${s.path}  base=${s.baseHref}  → 请求 ${s.req}`);
    }
  }

  server.close();
  return { project: name, pages: uniqPages.length, pages200, pages404, pagesOther, resTotal, res200, res404, resOther };
}

(async () => {
  const results = [];
  const SEO = '/Users/zeen/Documents/共享/工作/微盛/开发工作/源文件';
  const MOB = '/Users/zeen/Documents/共享/工作/微盛/学习/官网国际化-mobile/mobile-wshoto-admin-feature-v1212583-首屏防闪修复';
  if (fs.existsSync(SEO)) results.push(await diagnoseProject('SEO（微盛源文件）', SEO));
  else console.log('跳过 SEO：路径不存在');
  if (fs.existsSync(MOB)) results.push(await diagnoseProject('MOBILE（国际化 mobile）', MOB));
  else console.log('跳过 MOBILE：路径不存在');

  console.log(`\n${'#'.repeat(70)}`);
  console.log(`# 汇总`);
  console.log('#'.repeat(70));
  console.log('项目'.padEnd(24), '页面', '页200', '页404', '资源', '资200', '资404', '404率');
  for (const r of results) {
    const rate = r.resTotal ? (r.res404 / r.resTotal * 100).toFixed(0) + '%' : '-';
    console.log(r.project.padEnd(24), String(r.pages).padStart(4), String(r.pages200).padStart(4), String(r.pages404).padStart(4),
      String(r.resTotal).padStart(6), String(r.res200).padStart(6), String(r.res404).padStart(6), rate.padStart(6));
  }
  // 退出码：有 404 就非0
  const has404 = results.some(r => r.res404 > 0 || r.pages404 > 0);
  process.exit(has404 ? 1 : 0);
})().catch(e => { console.error('诊断异常：', e); process.exit(2); });
