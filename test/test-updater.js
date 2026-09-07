const assert = require('node:assert/strict');
const Module = require('module');
const original = Module._load;
Module._load = function(name, ...args) {
  if (name === 'electron') return { app: {} };
  return original.call(this, name, ...args);
};
const { pickMacAsset, pickUpdateAsset, buildMacInstallScript } = require('../src/main/updater');
Module._load = original;
const assets = ['mac-arm64.zip', 'mac-x64.zip', 'win-x64-setup.exe'].map(name => ({name}));
assert.equal(pickMacAsset({assets}, 'x64')?.name, 'mac-x64.zip', 'Intel Mac must not download ARM package');
assert.equal(pickMacAsset({assets: [assets[0]]}, 'x64'), null, 'No cross-architecture fallback');
assert.equal(pickUpdateAsset({assets}, 'win32', 'x64')?.name, 'win-x64-setup.exe');
assert.equal(pickUpdateAsset({assets}, 'linux', 'x64'), null);
assert.equal(pickMacAsset({assets: [{name: 'local-run-frontend-v0.3.0-mac.zip'}]}, 'arm64')?.name, 'local-run-frontend-v0.3.0-mac.zip');
const script = buildMacInstallScript('/tmp/中文 app.app', '/tmp/Applications/Test.app');
assert.ok(script.indexOf('ditto') < script.indexOf('mv "$target" "$backup"'), 'Copy completes before old app is moved');
assert.ok(script.includes('mv "$backup" "$target"'), 'Failed replacement restores backup');
assert.ok(!script.includes('POSIX file'), 'Never convert target to HFS path');
console.log('updater: 8 checks passed');

(async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const crypto = require('crypto');
  const { execFileSync } = require('child_process');
  const { verifyDownload } = require('../src/main/updater');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-test-'));
  try {
    const file = path.join(dir, 'download');
    fs.writeFileSync(file, 'download');
    await verifyDownload(file, { size: 8, digest: 'sha256:' + crypto.createHash('sha256').update('download').digest('hex') });
    await assert.rejects(verifyDownload(file, { size: 7 }), /不完整/);
    await assert.rejects(verifyDownload(file, { digest: 'sha256:bad' }), /校验失败/);
    if (process.platform === 'darwin') {
      const source = path.join(dir, "新 app's.app");
      const target = path.join(dir, '旧 app.app');
      fs.mkdirSync(path.join(source, 'Contents/MacOS'), { recursive: true });
      fs.writeFileSync(path.join(source, 'marker'), 'new');
      fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'marker'), 'old');
      assert.throws(() => execFileSync('/bin/bash', ['-c', buildMacInstallScript(path.join(dir, 'missing'), target)], { stdio: 'ignore' }));
      assert.equal(fs.readFileSync(path.join(target, 'marker'), 'utf8'), 'old');
      const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'mv'), '#!/bin/bash\ncase "$1" in *.update-*) exit 1;; esac\nexec /bin/mv "$@"\n', { mode: 0o755 });
      assert.throws(() => execFileSync('/bin/bash', ['-c', buildMacInstallScript(source, target)], { env: { ...process.env, PATH: bin + ':' + process.env.PATH }, stdio: 'ignore' }));
      assert.equal(fs.readFileSync(path.join(target, 'marker'), 'utf8'), 'old', 'Replacement failure restores old app');
      execFileSync('/bin/bash', ['-c', buildMacInstallScript(source, target)]);
      assert.equal(fs.readFileSync(path.join(target, 'marker'), 'utf8'), 'new');
      console.log('mac installation: copy failure / replace rollback / success passed');
    }
    console.log('download integrity: 3 checks passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
