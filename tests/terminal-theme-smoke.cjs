'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { terminalEnvironment } = require('../electron/backend/terminal-env.cjs');

const PROBE_SOURCE = `
const { styleText } = require('node:util');
process.stdout.write(JSON.stringify({
  NO_COLOR: process.env.NO_COLOR ?? null,
  FORCE_COLOR: process.env.FORCE_COLOR ?? null,
  CLICOLOR: process.env.CLICOLOR ?? null,
  TERM: process.env.TERM ?? null,
  COLORTERM: process.env.COLORTERM ?? null,
  TERM_PROGRAM: process.env.TERM_PROGRAM ?? null,
  isTTY: process.stdout.isTTY
}) + '\\r\\n');
process.stdout.write(styleText('red', 'AUTO_COLOR') + '\\r\\n');
process.stdout.write('\\x1b[38;2;1;2;3mTRUE_COLOR\\x1b[0m\\r\\n');
`;
const PROBE_ARGUMENT = Buffer.from(PROBE_SOURCE).toString('base64');
const PROBE_BOOTSTRAP = 'eval(Buffer.from(process.argv[1],"base64").toString("utf8"))';
const PTY_RUNNER_SOURCE = `
const pty = require('node-pty');
let output = '';
const terminal = pty.spawn(process.execPath, ['-e', ${JSON.stringify(PROBE_BOOTSTRAP)}, process.argv[2]], {
  name: 'xterm-256color',
  cols: 100,
  rows: 20,
  cwd: process.cwd(),
  env: process.env,
  useConpty: true,
  useConptyDll: true,
});
terminal.onData(data => { output += data; });
terminal.onExit(({ exitCode }) => {
  try { terminal.destroy(); } catch {}
  process.stdout.write(JSON.stringify({ code: exitCode, output }));
  process.exit(0);
});
`;
const PTY_RUNNER_ARGUMENT = Buffer.from(PTY_RUNNER_SOURCE).toString('base64');

function runConpty(environment) {
  const result = spawnSync(process.execPath, ['-e', PROBE_BOOTSTRAP, PTY_RUNNER_ARGUMENT, PROBE_ARGUMENT], {
    cwd: process.cwd(),
    env: environment,
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

async function write(terminal, data) {
  await new Promise(resolve => terminal.write(data, resolve));
}

test('terminal startup removes inherited color decisions and identifies Winmux as truecolor', () => {
  const inherited = {
    NO_COLOR: '1',
    no_color: 'duplicate',
    FORCE_COLOR: '0',
    CLICOLOR: '0',
    TERM: 'dumb',
    COLORTERM: '',
    TERM_PROGRAM: 'Codex CLI helper',
    WINMUX_PANE_ID: 'pane-1',
    KEEP_ME: 'yes',
  };
  const environment = terminalEnvironment(inherited);

  assert.deepEqual(environment, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Winmux',
    WINMUX_PANE_ID: 'pane-1',
    KEEP_ME: 'yes',
  });
  assert.equal(inherited.NO_COLOR, '1');
  assert.equal(inherited.no_color, 'duplicate');
  assert.equal(inherited.TERM, 'dumb');
});

test('real ConPTY proves inherited NO_COLOR suppresses automatic ANSI, not explicit truecolor', () => {
  const polluted = {
    ...process.env,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CLICOLOR: '0',
    TERM: 'dumb',
    COLORTERM: '',
  };
  const inherited = runConpty(polluted);
  const sanitized = runConpty(terminalEnvironment(polluted));

  assert.equal(inherited.code, 0);
  assert.equal(sanitized.code, 0);
  assert.match(inherited.output, /\{"NO_COLOR":"1","FORCE_COLOR":"0","CLICOLOR":"0","TERM":"dumb","COLORTERM":"","TERM_PROGRAM":null,"isTTY":true\}/);
  assert.match(inherited.output, /(?:^|[\r\n])AUTO_COLOR(?:\r\n|$)/);
  assert.doesNotMatch(inherited.output, /\x1b\[31mAUTO_COLOR/);
  assert.match(inherited.output, /\x1b\[38;2;1;2;3mTRUE_COLOR\x1b\[0m/);

  assert.match(sanitized.output, /\{"NO_COLOR":null,"FORCE_COLOR":null,"CLICOLOR":null,"TERM":"xterm-256color","COLORTERM":"truecolor","TERM_PROGRAM":"Winmux","isTTY":true\}/);
  assert.match(sanitized.output, /\x1b\[31mAUTO_COLOR\x1b\[39m/);
  assert.match(sanitized.output, /\x1b\[38;2;1;2;3mTRUE_COLOR\x1b\[0m/);
});

test('serialized reattach preserves ANSI index and truecolor RGB semantics', async () => {
  const first = new Terminal({
    cols: 40,
    rows: 4,
    allowProposedApi: true,
    theme: { red: '#123456', foreground: '#eeeeee', background: '#101010' },
  });
  const serializer = new SerializeAddon();
  first.loadAddon(serializer);
  await write(first, '\x1b[31mANSI16\x1b[0m\r\n\x1b[38;2;1;2;3mTRUECOLOR\x1b[0m');
  const snapshot = serializer.serialize({ scrollback: 10 });
  const ansi = first.buffer.active.getLine(0)?.getCell(0);
  const rgb = first.buffer.active.getLine(1)?.getCell(0);

  assert.equal(ansi?.getChars(), 'A');
  assert.equal(ansi?.getFgColorMode(), 0x01000000);
  assert.equal(ansi?.getFgColor(), 1);
  assert.equal(rgb?.getChars(), 'T');
  assert.equal(rgb?.getFgColorMode(), 0x03000000);
  assert.equal(rgb?.getFgColor(), 0x00010203);

  const reattached = new Terminal({
    cols: 40,
    rows: 4,
    allowProposedApi: true,
    theme: { red: '#abcdef', foreground: '#111111', background: '#fefefe' },
  });
  await write(reattached, snapshot);
  const reattachedAnsi = reattached.buffer.active.getLine(0)?.getCell(0);
  const reattachedRgb = reattached.buffer.active.getLine(1)?.getCell(0);

  assert.equal(reattachedAnsi?.getChars(), 'A');
  assert.equal(reattachedAnsi?.getFgColorMode(), 0x01000000);
  assert.equal(reattachedAnsi?.getFgColor(), 1);
  assert.equal(reattachedRgb?.getChars(), 'T');
  assert.equal(reattachedRgb?.getFgColorMode(), 0x03000000);
  assert.equal(reattachedRgb?.getFgColor(), 0x00010203);

  first.dispose();
  reattached.dispose();
});
