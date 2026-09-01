// 后端依赖探测：dev server 活着 ≠ 项目可用。
// 前端项目的 API 代理（vite proxy / VITE_BACKEND_PROXY_TARGET）指向的后端
// 如果没起，页面打开也是白屏/登录失败——启动器的健康检查看不见这类故障。
// 这里在 dev server 就绪后，解析项目的代理目标并探测可达性，不可达给警告（不阻止启动）。

const fs = require('fs');
const path = require('path');
const net = require('net');

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
        // target: 'http://xxx' 或 target: backendTarget（变量，跳过）
        const re = /target\s*:\s*[^'"`\n]*['"`](https?:\/\/[^'"`\s]+)['"`]/g;
        let m;
        while ((m = re.exec(txt))) push(m[1], `${f} 的 proxy target`);
        // env.VITE_XXX || 'fallback' 形式的兜底 URL 也算
        const fb = txt.match(/[|]{2}\s*['"`](https?:\/\/[^'"`\s]+)['"`]/);
        if (fb) push(fb[1], `${f} 的 fallback`);
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
async function checkProjectBackends(root, log = () => {}) {
  const results = [];
  try {
    const targets = collectProxyTargets(root);
    if (!targets.length) {
      log('后端探测：未发现代理目标（纯前端项目或未配置 proxy），跳过');
      return results;
    }
    for (const { target, source } of targets) {
      const r = await probeTarget(target);
      const item = { target, source, ...r };
      results.push(item);
      if (r.ok) {
        log(`后端探测：${target} 可达（${r.detail}，来自${source}）`);
      } else {
        log(`⚠️ 后端探测：${target} 不可达（${r.detail}，来自${source}）——页面能打开但接口会失败`);
      }
    }
  } catch (e) {
    log(`后端探测出错（忽略）：${e.message}`);
  }
  return results;
}

module.exports = { collectProxyTargets, probeTarget, checkProjectBackends };
