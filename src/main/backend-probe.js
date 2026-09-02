// 后端依赖探测：dev server 活着 ≠ 项目可用。
// 前端项目的 API 代理（vite proxy / VITE_BACKEND_PROXY_TARGET）指向的后端
// 如果没起，页面打开也是白屏/登录失败——启动器的健康检查看不见这类故障。
// 这里在 dev server 就绪后，解析项目的代理目标并探测可达性，不可达给警告（不阻止启动）。

const fs = require('fs');
const path = require('path');
const net = require('net');
const { detectTokenConfig } = require('./dev-nav');

// 明显不是 API 后端的 URL（误报来源：Sentry sourcemap 前缀、仓库地址、文档站）
const NON_BACKEND_RE = /gitlab\.|github\.|sentry|readme|\/docs?\/|\.md($|:)/i;

// Vite loadEnv 的优先级：.env.[mode].local > .env.[mode] > .env.local > .env
const ENV_FILES = [
  '.env.development.local',
  '.env.development',
  '.env.local',
  '.env'
];

// 常见「代理目标」环境变量名（vite/vue-cli/next 生态约定）
const PROXY_ENV_KEYS = [
  'VITE_BACKEND_PROXY_TARGET',
  'VITE_PROXY_TARGET',
  'VITE_API_BASE',
  'NEXT_PUBLIC_API_BASE'
];

function readEnvFile(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const map = {};
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      // 去引号与行内注释
      const q = v.match(/^(['"])(.*)\1$/);
      if (q) v = q[2];
      else v = v.replace(/\s+#.*$/, '').trim();
      map[m[1]] = v;
    }
    return map;
  } catch { return {}; }
}

// 从项目根目录解析「生效中的」后端代理目标。
// 返回 [{ target, source }]，source 是人类可读的来源说明。
function collectProxyTargets(root) {
  const out = [];
  const seen = new Set();
  const push = (target, source) => {
    if (!target || !/^https?:\/\//i.test(target) && !/^[\w.-]+:\d+$/.test(target)) return;
    if (NON_BACKEND_RE.test(target)) return; // Sentry sourcemap 前缀/仓库地址等不是后端
    if (seen.has(target)) return;
    seen.add(target);
    out.push({ target, source });
  };

  // 1) 环境变量（优先级从高到低，每个 key 取第一个命中的文件）
  const envHit = new Map(); // key -> { value, file }
  for (const f of ENV_FILES) {
    const map = readEnvFile(path.join(root, f));
    for (const key of PROXY_ENV_KEYS) {
      if (!envHit.has(key) && map[key]) envHit.set(key, { value: map[key], file: f });
    }
  }
  let envTargetFound = false;
  for (const [key, { value, file }] of envHit) {
    if (value) { push(value, `${file} 的 ${key}`); envTargetFound = true; }
  }

  // 2) vite.config.* 里的字面量 target（env 变量没配置时才是生效值）
  if (!envTargetFound) {
    for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
      const cfg = path.join(root, f);
      if (!fs.existsSync(cfg)) continue;
      try {
        const txt = fs.readFileSync(cfg, 'utf8');
        // target: 'http://xxx'，包括 target: env.VUE_X || 'http://xxx'（变量部分不含引号，天然被覆盖）。
        // 注意：不再独立匹配任意 `|| 'url'`——那会把 Sentry sourcemap 前缀（gitlab 地址）误当后端（真实踩坑）。
        const re = /target\s*:\s*[^'"`\n]*['"`](https?:\/\/[^'"`\s]+)['"`]/g;
        let m;
        while ((m = re.exec(txt))) push(m[1], `${f} 的 proxy target`);
      } catch {}
    }
  }
  return out;
}

// 探测单个目标。任何 HTTP 响应（哪怕 404/500）都算「后端活着」；网络错误才算不可达。
async function probeTarget(target, timeoutMs = 2500) {
  // 裸 host:port → TCP 探测
  if (!/^https?:\/\//i.test(target)) {
    const m = target.match(/^([\w.-]+):(\d+)$/);
    if (!m) return { ok: false, detail: '无法解析的目标' };
    const ok = await new Promise(resolve => {
      const s = net.connect({ host: m[1], port: +m[2] });
      const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
      s.setTimeout(timeoutMs, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
    return ok ? { ok: true, detail: 'TCP 可达' } : { ok: false, detail: 'TCP 连接失败' };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(target, { signal: ctrl.signal, redirect: 'manual' });
    clearTimeout(t);
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (e) {
    const reason = e && e.name === 'AbortError' ? '超时' : (e.cause && e.cause.code) || e.message;
    return { ok: false, detail: String(reason) };
  }
}

// 主入口：解析 + 探测全部目标。永不 throw。
// 有不可达的代理目标时，交叉验证 .env 里的 API 基址（token 探测识别的那个）是否直连可达——
// 很多项目接口根本不走 vite proxy 而是直连 VUE_APP_BASE_URL，这种情况代理挂了不影响接口，不该吓用户。
async function checkProjectBackends(root, log = () => {}) {
  const results = [];
  try {
    const targets = collectProxyTargets(root);
    if (!targets.length) {
      log('后端探测：未发现代理目标（纯前端项目或未配置 proxy），跳过');
      return results;
    }
    const bad = [];
    for (const { target, source } of targets) {
      const r = await probeTarget(target);
      const item = { target, source, ...r };
      results.push(item);
      if (r.ok) {
        log(`后端探测：${target} 可达（${r.detail}，来自${source}）`);
      } else {
        bad.push(item);
      }
    }
    // 交叉验证：API 基址直连可达 → 豁免代理不可达的告警
    if (bad.length) {
      let api = null;
      try { api = detectTokenConfig(root); } catch {}
      const apiBase = api && api.testBackend;
      if (apiBase && !bad.some(b => b.target.replace(/\/+$/, '') === apiBase)) {
        const r = await probeTarget(apiBase, 3000);
        if (r.ok) {
          for (const b of bad) b.excused = true;
          log(`后端探测：代理目标不可达，但 API 基址直连可达（${api.source} → ${apiBase}，HTTP ${r.detail || '可达'}）——接口走直连，不影响使用`);
          results.push({ target: apiBase, source: `API 基址直连（${api.source}）`, ...r, direct: true });
        }
      }
      // 没被豁免的才真正告警
      for (const b of bad) {
        if (!b.excused) {
          log(`⚠️ 后端探测：${b.target} 不可达（${b.detail}，来自${b.source}）——页面能打开但接口会失败`);
        }
      }
    }
  } catch (e) {
    log(`后端探测出错（忽略）：${e.message}`);
  }
  return results;
}

module.exports = { collectProxyTargets, probeTarget, checkProjectBackends };
