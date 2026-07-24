// 项目类型识别器。
// 按证据强弱判定，命中即归类。全部用写死的启发式规则，不依赖 AI。

const fs = require('fs');
const path = require('path');

function readPackageJson(root) {
  const p = path.join(root, 'package.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function exists(...parts) {
  try { return fs.existsSync(path.join(...parts)); }
  catch { return false; }
}

function hasDep(pkg, names) {
  if (!pkg) return false;
  const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return names.some(n => Object.prototype.hasOwnProperty.call(all, n));
}

function hasScript(pkg, name) {
  return !!(pkg && pkg.scripts && pkg.scripts[name]);
}

function hasHtmlInRoot(root) {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && (e.name.endsWith('.html') || e.name.endsWith('.htm'))) return true;
    }
  } catch {}
  return false;
}

// 主入口。返回 { type, startCommand, framework, hints }
//   type: 'vite' | 'next' | 'nuxt' | 'vue-cli' | 'react-scripts' | 'angular' | 'static' | 'unknown'
//   startCommand: 启动命令字符串（static 为 null）
//   framework: true 表示走 dev server（非 static）
function detect(root) {
  if (!exists(root)) return { type: 'unknown', startCommand: null, framework: false };
  const pkg = readPackageJson(root);

  // next
  if (hasDep(pkg, ['next'])) {
    return { type: 'next', framework: true, startCommand: hasScript(pkg, 'dev') ? 'npm run dev' : 'next dev' };
  }
  // nuxt
  if (hasDep(pkg, ['nuxt']) || hasDep(pkg, ['nuxt-edge'])) {
    return { type: 'nuxt', framework: true, startCommand: hasScript(pkg, 'dev') ? 'npm run dev' : 'nuxt dev' };
  }
  // angular
  if (exists(root, 'angular.json') || hasDep(pkg, ['@angular/cli'])) {
    return { type: 'angular', framework: true, startCommand: hasScript(pkg, 'start') ? 'npm start' : 'ng serve' };
  }
  // vite（注意 vue-cli 项目也可能装了 vite，但通常 vite 项目以 vite.config 为标志）
  if (exists(root, 'vite.config.js') || exists(root, 'vite.config.ts') || exists(root, 'vite.config.mjs')) {
    return { type: 'vite', framework: true, startCommand: hasScript(pkg, 'dev') ? 'npm run dev' : 'vite' };
  }
  if (hasDep(pkg, ['vite'])) {
    return { type: 'vite', framework: true, startCommand: hasScript(pkg, 'dev') ? 'npm run dev' : 'vite' };
  }
  // vue-cli
  if (exists(root, 'vue.config.js') || hasDep(pkg, ['@vue/cli-service'])) {
    return { type: 'vue-cli', framework: true, startCommand: hasScript(pkg, 'serve') ? 'npm run serve' : 'vue-cli-service serve' };
  }
  // react-scripts (CRA)
  if (hasDep(pkg, ['react-scripts'])) {
    return { type: 'react-scripts', framework: true, startCommand: hasScript(pkg, 'start') ? 'npm start' : 'react-scripts start' };
  }
  // 兜底：有 scripts.dev 但识别不出框架 → 当作通用框架走 npm run dev
  if (pkg && hasScript(pkg, 'dev') && exists(root, 'node_modules')) {
    return { type: 'generic-dev', framework: true, startCommand: 'npm run dev' };
  }
  // 静态
  if (hasHtmlInRoot(root) || hasNestedHtml(root)) {
    return { type: 'static', framework: false, startCommand: null };
  }

  return { type: 'unknown', startCommand: null, framework: false };
}

// 浅扫一层子目录有没有 html（mobile 项目常在 casePage/schemePage 下）
function hasNestedHtml(root, depth = 1) {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || ['node_modules', 'dist', 'build'].includes(e.name)) continue;
      const sub = path.join(root, e.name);
      try {
        const subEntries = fs.readdirSync(sub, { withFileTypes: true });
        for (const se of subEntries) {
          if (se.isFile() && (se.name.endsWith('.html') || se.name.endsWith('.htm'))) return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

module.exports = { detect, readPackageJson, hasHtmlInRoot };
