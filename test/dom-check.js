// DOM 检查：渲染 URL，把 img 加载情况 + 关键文本写到 stdout（逐行）。
// 注意：executeJavaScript 的第一参必须是字符串代码（不是函数）。
// 用法：npx electron test/dom-check.js <url>
const { app, BrowserWindow } = require('electron');
const url = process.argv[2];

function log(s) { process.stdout.write(String(s) + '\n'); }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 2400, show: false });
  try {
    await win.loadURL(url);
    await new Promise(r => setTimeout(r, 2500));

    const run = (code) => win.webContents.executeJavaScript(code);

    log('IMG_COUNT=' + await run(`document.querySelectorAll('img').length`));
    log('IMGS=' + await run(`JSON.stringify([...document.querySelectorAll('img')].map(im => im.getAttribute('src') + ' loaded=' + (im.naturalWidth>0) + ' w=' + im.naturalWidth))`));
    log('H1=' + await run(`document.querySelector('h1') ? document.querySelector('h1').textContent : 'none'`));
    log('VERSION_BADGE=' + await run(`document.querySelector('.version-badge') ? document.querySelector('.version-badge').textContent : 'none'`));
    log('DOWNLOAD_BTN=' + await run(`document.querySelector('#downloadBtn') ? document.querySelector('#downloadBtn').textContent.trim() : 'none'`));
    log('FEATURE_COUNT=' + await run(`document.querySelectorAll('.feature').length`));
    log('QR_CELL_COUNT=' + await run(`document.querySelectorAll('.qr-cell').length`));
    log('FALLBACKS_VISIBLE=' + await run(`[...document.querySelectorAll('.qr-fallback')].filter(e => getComputedStyle(e).display !== 'none').length`));
    log('UPDATE_BAR_SHOWN=' + await run(`document.getElementById('updateBar').classList.contains('show') ? 'yes' : 'no'`));
  } catch (e) {
    log('ERR=' + e.message);
  }
  app.quit();
});
app.on('window-all-closed', () => app.quit());
setTimeout(() => { try { app.quit(); } catch (e) {} process.exit(0); }, 15000);
