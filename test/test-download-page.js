const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const platforms = ['mac-arm64', 'mac-x64', 'win-x64'];
const assets = platforms.map(platform => ({ name: `local-run-frontend-v0.5.0-${platform}${platform.startsWith('mac') ? '.zip' : '-setup.exe'}`, browser_download_url: `https://github.com/lyzbcy/local-run-frontend/releases/download/v0.5.0/${platform}` }));
const storage = data => ({ getItem: k => data[k] || null, setItem: (k, v) => { data[k] = v; }, removeItem: k => { delete data[k]; } });
async function runPage(sessionData = {}, remote = '0.4.0', releaseAssets = assets) {
  const elements = new Map();
  const calls = [], redirects = [];
  const location = { href: 'https://example.com/index.html', pathname: '/index.html', search: '', replace: url => redirects.push(url) };
  const context = { URL, AbortController, setTimeout, clearTimeout, location,
    sessionStorage: storage(sessionData), localStorage: storage({}), history: { replaceState() {} },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, { classList: { add() {} } }); return elements.get(id); } },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => String(url).includes('version.json') ? { version: remote } : { tag_name: 'v0.5.0', assets: releaseAssets } }; }
  };
  context.window = context;
  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  return { elements, calls, redirects };
}
test('three download buttons select their own latest release asset', async () => {
  for (const platform of platforms) assert.match(html, new RegExp(`id="download-${platform}"`));
  const { elements } = await runPage();
  for (const platform of platforms) assert.equal(elements.get('download-' + platform).href, assets.find(a => a.name.includes(platform)).browser_download_url);
});
test('page version check bypasses cache and refreshes only once per remote version', async () => {
  const session = {};
  const first = await runPage(session, '0.5.0');
  assert.equal(first.calls.find(c => String(c.url).includes('version.json'))?.options.cache, 'no-store');
  assert.equal(first.redirects.length, 1);
  const second = await runPage(session, '0.5.0');
  assert.equal(second.redirects.length, 0);
});
test('missing platform assets do not mislabel fallback buttons as a newer version', async () => {
  const { elements } = await runPage({}, '0.4.0', []);
  assert.equal(elements.get('heroVersion')?.textContent, undefined);
});
