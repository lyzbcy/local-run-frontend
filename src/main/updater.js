// app 内一键更新：下载 release zip → 解压 → 替换 /Applications 里的 .app → 去隔离 → 重启。
// 全程通过 onProgress 回调推送进度，让渲染层显示进度条。
//
// 流程：
//   1. GET GitHub releases/latest，找 mac-arm64 的 zip 资源 URL
//   2. 下载到 ~/Library/Application Support/local-run-frontend-data/update-tmp/update.zip
//   3. 用系统 unzip 解压（mac 自带）
//   4. 找解压出的 .app，用 osascript 请求管理员权限 cp -R 替换 /Applications 下的旧 app
//   5. xattr -dr 去掉 quarantine
//   6. app.relaunch() + app.exit(0) 重启
//
// 失败处理：每步都有错误返回，渲染层显示具体卡在哪一步。

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const https = require('https');

const APP_NAME = '本地运行前端项目';
const APP_FILE = `${APP_NAME}.app`;

// 拉最新 release 信息
function fetchLatestRelease(repo) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    https.get(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'local-run-frontend-updater', 'Accept': 'application/vnd.github+json' },
      signal: ctrl.signal
    }, (res) => {
      clearTimeout(t);
      if (res.statusCode !== 200) { reject(new Error(`GitHub 返回 ${res.statusCode}`)); return; }
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('解析 release JSON 失败')); }
      });
    }).on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

// 从 release 资产里挑 mac-arm64 的 zip。优先 mac-arm64，其次通用 mac zip。
function pickMacAsset(release) {
  const assets = (release && release.assets) || [];
  // 优先级：明确 mac-arm64 > universal/darwin > 任意 mac zip
  const score = (name) => {
    const n = name.toLowerCase();
    if (!n.endsWith('.zip')) return -1;
    if (n.includes('mac-arm64') || n.includes('arm64-mac') || n.includes('darwin-arm64')) return 100;
    if (n.includes('universal') || n.includes('x64+arm64')) return 90;
    if (n.includes('mac') || n.includes('darwin')) return 50;
    return -1;
  };
  let best = null, bestScore = -1;
  for (const a of assets) {
    const s = score(a.name || '');
    if (s > bestScore) { best = a; bestScore = s; }
  }
  return best;
}

// 下载文件，带进度回调（onProgress(received, total)）
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let total = 0, received = 0;
    const handle = (res) => {
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return https.get(res.headers.location, handle).on('error', reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败：HTTP ${res.statusCode}`));
        return;
      }
      total = parseInt(res.headers['content-length'] || '0', 10);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
      res.on('error', reject);
    };
    https.get(url, { headers: { 'User-Agent': 'local-run-frontend-updater' } }, handle).on('error', reject);
  });
}

// 异步执行命令（Promise 版）
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} 失败：${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

// 主流程：检查 → 下载 → 解压 → 替换 → 重启。
// onProgress(stage, detail)：stage = 'check'|'download'|'extract'|'replace'|'done'
//   detail 可能是字符串（阶段描述）或 {received,total,percent}（下载进度）
async function performUpdate(repo, onProgress, options = {}) {
  const dataDir = app.getPath('userData');
  const tmpDir = path.join(dataDir, 'update-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  // 1. 检查 release
  onProgress('check', '正在获取最新版本信息…');
  const release = await fetchLatestRelease(repo);
  const asset = pickMacAsset(release);
  if (!asset) throw new Error('当前 release 没有找到 mac 版本的 zip 包。请到 GitHub 手动下载。');
  const version = (release.tag_name || '').replace(/^v/, '');
  onProgress('check', `找到 v${version} → ${asset.name}`);

  // 2. 下载
  onProgress('download', { received: 0, total: asset.size || 0, percent: 0 });
  const zipPath = path.join(tmpDir, asset.name);
  // 支持断点不如直接重下（包小、省复杂度）
  await downloadFile(asset.browser_download_url, zipPath, (received, total) => {
    const percent = total ? Math.round(received / total * 100) : 0;
    onProgress('download', { received, total, percent });
  });

  // 2.1 校验下载完整性（防半下载导致解压失败被误报"没找到 .app"）
  const stat = fs.statSync(zipPath);
  if (asset.size && stat.size !== asset.size) {
    try { fs.unlinkSync(zipPath); } catch {}
    throw new Error(`下载不完整：期望 ${asset.size} 字节，实际 ${stat.size} 字节。请重试。`);
  }

  // 3. 解压
  onProgress('extract', '正在解压…');
  // 清掉旧解压残留
  try { fs.rmSync(path.join(tmpDir, 'extracted'), { recursive: true, force: true }); } catch {}
  fs.mkdirSync(path.join(tmpDir, 'extracted'), { recursive: true });
  await run('unzip', ['-o', '-q', zipPath, '-d', path.join(tmpDir, 'extracted')]);

  // 找解压出的 .app
  const findApp = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name === APP_FILE) return path.join(dir, e.name);
    }
    // 再往下一层（zip 解压常多一层目录）
    for (const e of entries) {
      if (e.isDirectory()) {
        const sub = path.join(dir, e.name);
        const found = findApp(sub);
        if (found) return found;
      }
    }
    return null;
  };
  const newAppPath = findApp(path.join(tmpDir, 'extracted'));
  if (!newAppPath) throw new Error('解压后没找到 .app 文件。请到 GitHub 手动下载安装。');
  // 校验 .app 可执行文件存在（防半下载）
  const execPath = path.join(newAppPath, 'Contents', 'MacOS');
  if (!fs.existsSync(execPath)) throw new Error('解压出的 .app 不完整（缺 MacOS 目录）。请重试或手动下载。');

  // 4. 去掉新包 quarantine（替换前先去，避免替换后又被拦）
  try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', newAppPath], { stdio: 'ignore' }); } catch {}

  // 5. 替换 /Applications（需要管理员权限）
  onProgress('replace', '正在替换应用程序（需管理员授权）…');
  const appsDir = '/Applications';
  const targetApp = path.join(appsDir, APP_FILE);
  // 用 AppleScript 的 quoted form of 安全拼接路径（防中文/空格/特殊字符注入）
  // 命令：rm -rf 旧 app && cp -R 新 app 到 /Applications && xattr 去隔离
  const script = `do shell script "rm -rf " & quoted form of ${JSON.stringify(targetApp)} & " && cp -R " & quoted form of ${JSON.stringify(newAppPath)} & " " & quoted form of (POSIX file ${JSON.stringify(appsDir)} as text) & " && xattr -dr com.apple.quarantine " & quoted form of ${JSON.stringify(targetApp)} with administrator privileges`;
  await new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], (err, stdout, stderr) => {
      if (err) reject(new Error('替换失败（可能你取消了授权）：' + (stderr || err.message)));
      else resolve();
    });
  });

  // 6. 清理临时文件
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  // 7. 重启。app.exit() 不触发 before-quit，所以先手动停服务（防端口/进程泄漏）
  onProgress('done', `已更新到 v${version}，正在重启…`);
  setTimeout(() => {
    if (options && typeof options.onBeforeExit === 'function') {
      try { options.onBeforeExit(); } catch {}
    }
    app.relaunch();
    app.exit(0);
  }, 1200);
}

module.exports = { performUpdate, fetchLatestRelease, pickMacAsset };
