'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const guard = require.resolve('../electron/stdio.cjs');
test('desktop diagnostics tolerate closed launcher stdout and stderr pipes', async () => {
  const child = spawn(process.execPath, ['-e', `
    require(${JSON.stringify(guard)});
    process.on('message', () => {
      process.stdout.write('closed stdout');
      process.stderr.write('closed stderr');
      setTimeout(() => process.exit(0), 100);
    });
    process.send('ready');
  `], { windowsHide:true, stdio:['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  await once(child, 'message');
  child.stdout.destroy();
  child.stderr.destroy();
  child.send('write');
  const [code] = await exited;
  assert.equal(code, 0);
});

test('unexpected output errors are not suppressed', () => {
  const child = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(guard)}); process.stdout.emit('error', Object.assign(new Error('unexpected output error'), { code:'EIO' }));`], { windowsHide:true, encoding:'utf8' });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /unexpected output error/);
});
