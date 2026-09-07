// 平台匹配、限时下载、完整性校验与安装。Mac 先复制再替换，失败恢复旧版。
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const APP_FILE = '本地运行前端项目.app';
let updating = false;

async function fetchLatestRelease(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GitHub 仓库格式不正确');
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'User-Agent': 'local-run-frontend-updater', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  return res.json();
}

function pickMacAsset(release, arch = process.arch) {
  const assets = release?.assets || [];
  return assets.find(a => new RegExp(`(?:mac-${arch}|${arch}-mac|darwin-${arch})\\.zip$`, 'i').test(a.name))
    || assets.find(a => /(?:mac|darwin).*universal.*\.zip$|universal.*(?:mac|darwin).*\.zip$/i.test(a.name))
    // v0.3.0 历史包仅有 arm64，不能让 Intel 误选。
    || (arch === 'arm64' ? assets.find(a => /^local-run-frontend-v0\.[123]\.\d+-mac\.zip$/.test(a.name)) : null)
    || null;
}
function pickUpdateAsset(release, platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return pickMacAsset(release, arch);
  if (platform === 'win32') return (release?.assets || []).find(a => a.name.endsWith(`win-${arch}-setup.exe`)) || null;
  return null;
}

async function downloadFile(url, destPath, onProgress) {
  if (new URL(url).protocol !== 'https:') throw new Error('更新下载必须使用 HTTPS');
  const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const input = Readable.fromWeb(res.body);
  input.on('data', chunk => { received += chunk.length; onProgress?.(received, total); });
  try { await pipeline(input, fs.createWriteStream(destPath, { flags: 'wx' })); }
  catch (e) { fs.rmSync(destPath, { force: true }); throw e; }
}
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => execFile(cmd, args, opts, (err, stdout, stderr) => {
    if (err) reject(new Error(`${cmd} 失败：${stderr || err.message}`));
    else resolve(stdout);
  }));
}
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
function buildMacInstallScript(source, target) {
  return `set -eu
source=${quote(source)}
target=${quote(target)}
stage="$target.update-$$"
backup="$target.backup-$$"
trap 'rm -rf "$stage"' EXIT
/usr/bin/ditto "$source" "$stage"
test -d "$stage/Contents/MacOS"
/usr/bin/xattr -dr com.apple.quarantine "$stage" 2>/dev/null || true
if [ -e "$target" ]; then mv "$target" "$backup"; fi
if mv "$stage" "$target"; then
  rm -rf "$backup"
else
  if [ -e "$backup" ]; then mv "$backup" "$target"; fi
  exit 1
fi`;
}
async function verifyDownload(file, asset) {
  if (asset.size && fs.statSync(file).size !== asset.size) throw new Error('下载不完整，请重试');
  if (asset.digest?.startsWith('sha256:')) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    if ('sha256:' + hash.digest('hex') !== asset.digest) throw new Error('更新包校验失败，请重试');
  }
}
function findApp(dir, depth = 0) {
  if (depth > 3) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.some(e => e.isDirectory() && e.name === APP_FILE)) return path.join(dir, APP_FILE);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findApp(path.join(dir, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}
async function performUpdate(repo, onProgress, options = {}) {
  if (updating) throw new Error('更新正在进行，请稍候');
  if (!app.isPackaged) throw new Error('源码运行时请通过 Git 更新；安装版支持此功能');
  updating = true;
  let tmpDir;
  try {
    onProgress('check', '正在获取最新版本信息…');
    const release = await fetchLatestRelease(repo);
    const asset = pickUpdateAsset(release);
    if (!asset) throw new Error('该版本没有适合当前系统及芯片的安装包，请到 GitHub 查看');
    const version = (release.tag_name || '').replace(/^v/, '');
    tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'local-run-frontend-update-'));
    const packagePath = path.join(tmpDir, path.basename(asset.name));
    onProgress('download', { received: 0, total: asset.size || 0, percent: 0 });
    await downloadFile(asset.browser_download_url, packagePath, (received, total) => {
      onProgress('download', { received, total, percent: total ? Math.round(received / total * 100) : 0 });
    });
    await verifyDownload(packagePath, asset);
    if (process.platform === 'win32') {
      // NSIS 安装器负责关闭旧实例、覆盖和快捷方式，应用不自己覆盖运行中的 exe。
      const child = spawn(packagePath, [], { detached: true, stdio: 'ignore', windowsHide: false });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      onProgress('done', '已打开新版安装向导，应用即将退出；请按向导完成安装。');
      setTimeout(() => { options.onBeforeExit?.(); app.quit(); }, 1200);
      return;
    }
    onProgress('extract', '正在解压…');
    const extracted = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extracted);
    await run('/usr/bin/ditto', ['-x', '-k', packagePath, extracted]);
    const source = findApp(extracted);
    if (!source || !fs.existsSync(path.join(source, 'Contents', 'MacOS'))) throw new Error('更新包中没有完整的应用');
    const target = path.join('/Applications', APP_FILE);
    onProgress('replace', '正在安装新版，失败会保留旧版（需管理员授权）…');
    const script = buildMacInstallScript(source, target);
    await run('/usr/bin/osascript', ['-e', `do shell script ${JSON.stringify(script)} with administrator privileges`]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    onProgress('done', `已安装 v${version}，正在重启…`);
    setTimeout(() => {
      options.onBeforeExit?.();
      app.relaunch({ execPath: path.join(target, 'Contents', 'MacOS', '本地运行前端项目') });
      app.exit(0);
    }, 1200);
  } catch (e) {
    updating = false;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }
}
module.exports = { performUpdate, fetchLatestRelease, pickMacAsset, pickUpdateAsset, buildMacInstallScript, verifyDownload };
