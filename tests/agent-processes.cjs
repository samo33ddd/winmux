'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { findPrimaryAgents } = require('../electron/agent-processes.cjs');

const root = 100;
const localAppData = 'D:/fixture/local-app-data';
const env = { LOCALAPPDATA: localAppData };
const nativeOmp = path.win32.join(localAppData, 'omp', 'omp.exe');
function proc(pid, ppid, name, executable, commandLine, createdAt) {
  return { pid, ppid, name, executable, commandLine, ...(createdAt ? { createdAt } : {}) };
}
function ids(rows) {
  return rows.map(row => `${row.agentId}:${row.pid}`);
}

test('two independent Codex roots stay separate', () => {
  const rows = [
    proc(110, root, 'pwsh.exe', 'C:/Program Files/PowerShell/7/pwsh.exe', 'pwsh'),
    proc(120, root, 'cmd.exe', 'C:/Windows/System32/cmd.exe', 'cmd'),
    proc(111, 110, 'codex.exe', 'C:/tools/codex.exe', 'codex', '2026-11-15T10:00:00.000Z'),
    proc(121, 120, 'node.exe', 'C:/Program Files/nodejs/node.exe', '"C:/Program Files/nodejs/node.exe" "D:/packages/node_modules/@openai/codex/bin/codex.js"'),
  ];
  const found = findPrimaryAgents(root, rows, { env });
  assert.deepEqual(ids(found), ['codex:111', 'codex:121']);
  assert.equal(found[0].generation, '2026-11-15T10:00:00.000Z');
  assert.equal(Object.hasOwn(found[1], 'generation'), false);
});

test('an OMP root hides nested Codex and OMP workers', () => {
  const rows = [
    proc(200, root, 'omp.exe', nativeOmp, 'omp'),
    proc(201, 200, 'codex.exe', 'C:/tools/codex.exe', 'codex'),
    proc(202, 200, 'omp.exe', nativeOmp, 'omp'),
    proc(203, 202, 'node.exe', 'C:/Program Files/nodejs/node.exe', 'node D:/packages/node_modules/@openai/codex/bin/codex.js'),
  ];
  const found = findPrimaryAgents(root, rows, { env });
  assert.deepEqual(found, [{ agentId: 'omp', label: 'OMP', pid: 200 }]);
});

test('mentions do not make an unrelated entry an agent', () => {
  const rows = [
    proc(300, root, 'node.exe', 'C:/Program Files/nodejs/node.exe', 'node C:/tools/app.js --agent codex --prompt "run claude omp hermes pi"'),
    proc(301, root, 'python.exe', 'C:/Python/python.exe', 'python C:/tools/notes.py hermes_cli'),
    proc(302, root, 'codex.exe', 'C:/tools/codex.exe', 'codex app-server proxy'),
    proc(303, root, 'node.exe', 'C:/Program Files/nodejs/node.exe', 'node D:/packages/node_modules/@openai/codex/bin/codex.js app-server proxy'),
  ];
  assert.deepEqual(findPrimaryAgents(root, rows, { env }), []);
});

test('cycles, bounds, reused parents, and missing ids stay bounded', () => {
  const rows = [
    proc(1, 2, 'cmd.exe', 'C:/Windows/System32/cmd.exe', 'cmd'),
    proc(2, 1, 'pwsh.exe', 'C:/Program Files/PowerShell/7/pwsh.exe', 'pwsh'),
    { pid: 'bad', ppid: root, name: 'codex.exe', executable: 'C:/codex.exe', commandLine: 'codex' },
    { pid: 3, ppid: 'bad', name: 'codex.exe', executable: 'C:/codex.exe', commandLine: 'codex' },
  ];
  for (let index = 0; index < 70; index += 1) {
    const pid = 1000 + index;
    rows.push(proc(pid, index === 0 ? root : pid - 1, 'cmd.exe', 'C:/Windows/System32/cmd.exe', 'cmd'));
  }
  rows.push(proc(2000, 1063, 'codex.exe', 'C:/codex.exe', 'codex'));
  const found = findPrimaryAgents(root, rows);
  assert.equal(found.length <= 64, true);
  assert.equal(found.some(row => row.pid === 2000), false);
  assert.deepEqual(findPrimaryAgents(0, rows), []);
  assert.deepEqual(findPrimaryAgents(root, null), []);
});

test('Claude, Pi, and Hermes use executable or exact module entries', () => {
  const entry = 'D:/packages/node_modules/@mariozechner/pi-coding-agent/dist/cli.js';
  const rows = [
    proc(400, root, 'claude.exe', 'C:/tools/claude.exe', 'claude'),
    proc(401, root, 'node.exe', 'C:/Program Files/nodejs/node.exe', `node "${entry}"`),
    proc(402, root, 'python.exe', 'D:/runtimes/python.exe', 'python -I -m hermes_cli'),
    proc(403, root, 'hermes.exe', 'D:/profile/AppData/Local/hermes/bin/hermes.exe', 'hermes'),
    proc(404, root, 'pi.exe', 'C:/tools/pi.exe', 'pi'),
  ];
  assert.deepEqual(ids(findPrimaryAgents(root, rows, { env })), ['claude:400', 'pi:401', 'hermes:402', 'hermes:403', 'pi:404']);
});

test('a generic node or non-native OMP executable is not an agent', () => {
  const rows = [
    proc(500, root, 'node.exe', 'C:/Program Files/nodejs/node.exe', 'node'),
    proc(501, root, 'omp.exe', 'D:/tools/omp.exe', 'omp'),
    proc(502, root, 'python.exe', 'C:/Python/python.exe', 'python -c "import hermes_cli"'),
  ];
  assert.deepEqual(findPrimaryAgents(root, rows, { env }), []);
  assert.deepEqual(findPrimaryAgents(root, [proc(503, root, 'omp.exe', nativeOmp, 'omp')], { env: {} }), []);
});
