// 一次性截图脚本：用隐藏的 Electron 窗口渲染页面并截图。
// 用法：npx electron test/screenshot.js <url> <out.png> [width] [height]
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const [url, out, w, h] = process.argv.slice(2);
if (!url || !out) { console.error('usage: electron screenshot.js <url> <out.png> [w] [h]'); app.exit(1); }

const width = parseInt(w || '1200', 10);
const height = parseInt(h || '900', 10);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width, height, show: false,
    webPreferences: { offscreen: true, contextIsolation: true }
  });

  // 对落地页，从 file:// 或 http:// 加载
  await win.loadURL(url);

  // 给点渲染时间
  await new Promise(r => setTimeout(r, 2500));

  // 滚动到底再截长图？MVP 直接截视口
  const img = await win.webContents.capturePage();
  const buf = img.toPNG();
  fs.writeFileSync(out, buf);
  console.log('saved:', out, '(' + buf.length + ' bytes)');
  app.quit();
});

app.on('window-all-closed', () => app.quit());
