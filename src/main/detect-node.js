// Find a usable system Node installation on macOS and Windows, including GUI launches.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function detectNode(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const exists = options.existsSync || fs.existsSync;
  const execute = options.execFileSync || execFileSync;
  const paths = platform === 'win32' ? path.win32 : path;
  const home = env.USERPROFILE || env.HOME || '';
  const candidates = [];
  try {
    const output = execute(platform === 'win32' ? 'where.exe' : 'which', ['node'], {
      env, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    candidates.push(...output.split(/\r?\n/).filter(Boolean));
  } catch {}
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
      if (base) candidates.push(paths.join(base, 'nodejs', 'node.exe'));
    }
    if (env.NVM_SYMLINK) candidates.push(paths.join(env.NVM_SYMLINK, 'node.exe'));
    if (env.VOLTA_HOME) candidates.push(paths.join(env.VOLTA_HOME, 'bin', 'node.exe'));
    candidates.push(paths.join(home, 'AppData', 'Local', 'Volta', 'bin', 'node.exe'));
  } else {
    candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node',
      paths.join(home, '.volta/bin/node'), paths.join(home, '.fnm/aliases/default/bin/node'));
    try {
      const nvmDir = paths.join(home, '.nvm', 'versions', 'node');
      const versions = fs.readdirSync(nvmDir).filter(v => /^v\d/.test(v)).sort((a,b) => a.localeCompare(b, undefined, {numeric:true})).reverse();
      candidates.push(...versions.map(v => paths.join(nvmDir, v, 'bin', 'node')));
    } catch {}
  }
  for (const candidate of [...new Set(candidates)]) {
    if (!candidate || !exists(candidate)) continue;
    try {
      const version = execute(candidate, ['--version'], {env, encoding:'utf8', timeout:3000, windowsHide:true, stdio:['ignore','pipe','ignore']}).trim();
      if (/^v\d+\.\d+\.\d+/.test(version)) return {path:candidate,version,binDir:paths.dirname(candidate)};
    } catch {} // An unusable candidate must not hide a later working installation.
  }
  return null;
}
module.exports = { detectNode };
