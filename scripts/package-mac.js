const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { version } = require('../package.json');
const arch = process.argv[2] || process.arch;
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) throw new Error('macOS arm64/x64 required');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'release', arch === 'arm64' ? 'mac-arm64' : 'mac');
const appName = '本地运行前端项目.app';
const appPath = path.join(dir, appName);
if (!fs.existsSync(appPath)) throw new Error(`Missing ${appPath}`);
const stage = fs.mkdtempSync(path.join(root, 'release', 'package-'));
try {
  execFileSync('/usr/bin/ditto', [appPath, path.join(stage, appName)]);
  for (const name of ['一键安装.command', 'install-mac.sh']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(stage, name));
    fs.chmodSync(path.join(stage, name), 0o755);
  }
  fs.writeFileSync(path.join(stage, '安装说明.txt'), `本地运行前端项目 v${version} · Mac ${arch}\n请先退出旧版，再双击 一键安装.command。\n若脚本被系统阻止，请在系统设置→隐私与安全性允许打开。\n应用未进行 Apple 开发者签名或公证；安装脚本只移除本应用的隔离标记，不修改全局安全设置。\n`);
  const zip = path.join(root, 'release', `local-run-frontend-v${version}-mac-${arch}.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', stage, zip]);
  console.log(zip);
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
