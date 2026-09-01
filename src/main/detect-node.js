// 探测系统 node（框架项目启动需要）。
// .app 双击启动时 PATH 很短，不含 nvm/volta 等，所以不能只靠 which，要扫所有常见安装位置。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function detectNode() {
  const home = process.env.HOME || '';
  // 候选 node 路径（按优先级）。nvm 要展开版本目录，单独处理。
  const candidates = [
    '/opt/homebrew/bin/node',        // homebrew arm64
    '/usr/local/bin/node',           // homebrew intel / 官方 pkg
    '/usr/bin/node',                 // 系统自带
    path.join(home, '.volta/bin/node'), // volta
    path.join(home, '.fnm/aliases/default/bin/node') // fnm
  ];
  // nvm：可能有多个版本，取最新（目录名按版本号排序）
  try {
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(nvmDir).filter(v => v.startsWith('v')).sort();
      if (versions.length) candidates.push(path.join(nvmDir, versions[versions.length - 1], 'bin', 'node'));
    }
  } catch {}
  // 再试 which（万一 PATH 里就有）
  try {
    const which = execFileSync('which', ['node'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (which) candidates.unshift(which.split(/\r?\n/)[0]); // which 的优先
  } catch {}

  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      try {
        const ver = execFileSync(p, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim();
        return { path: p, version: ver, binDir: path.dirname(p) };
      } catch {
        return { path: p, version: null, binDir: path.dirname(p) };
      }
    }
  }
  return null;
}

module.exports = { detectNode };
