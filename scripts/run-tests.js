const { readdirSync } = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');
for (const file of readdirSync(path.join(__dirname, '../test')).filter(f => /^test-.*\.js$/.test(f)).sort()) {
  console.log(`\nRunning ${file}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, '../test', file)], { stdio: 'inherit', timeout: 120000 });
  if (r.error) console.error(r.error.message);
  if (r.status !== 0) process.exit(1);
}
