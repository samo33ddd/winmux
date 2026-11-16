'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const flush = () => new Promise(resolve => setImmediate(resolve));

test('terminal input remains ordered across bounded Unicode paste chunks and resumes after failure', async () => {
  const { TERMINAL_INPUT_CHUNK_BYTES, TerminalInputQueue } = await import('../src/terminalInput.ts');
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const delivered = [];
  const queue = new TerminalInputQueue(async data => {
    delivered.push(data);
    if (delivered.length === 1) await firstGate;
  }, error => { throw error; });
  const paste = `\x1b[200~${'😀é\r\n\t\0"\\'.repeat(1200)}\x1b[201~`;

  queue.enqueue(paste);
  queue.enqueue('LATER');
  await flush();
  assert.equal(delivered.length, 1);
  releaseFirst();
  await flush();

  assert.equal(delivered.join(''), paste + 'LATER');
  assert.ok(delivered.every(data => Buffer.byteLength(data) <= TERMINAL_INPUT_CHUNK_BYTES));
  assert.ok(delivered.every(data => Buffer.byteLength(JSON.stringify({ paneId: 'pane', data })) < 256 * 1024));

  const failed = [];
  const recovered = [];
  let errors = 0;
  const rejected = new TerminalInputQueue(async data => {
    failed.push(data);
    if (failed.length === 1) {
      await Promise.resolve();
      throw new Error('delivery failed');
    }
    recovered.push(data);
  }, () => { errors++; });
  rejected.enqueue('x'.repeat(TERMINAL_INPUT_CHUNK_BYTES * 2));
  rejected.enqueue('discarded batch tail');
  await flush();
  assert.equal(failed.length, 1);
  assert.equal(errors, 1);

  rejected.enqueue('AFTER FAILURE');
  await flush();
  assert.deepEqual(recovered, ['AFTER FAILURE']);

  rejected.close();
  rejected.enqueue('ignored after disposal');
  await flush();
  assert.deepEqual(recovered, ['AFTER FAILURE']);
  assert.equal(errors, 1);
});

test('a synchronous send failure releases the queue for later input', async () => {
  const { TerminalInputQueue } = await import('../src/terminalInput.ts');
  const delivered = [];
  let errors = 0;
  const queue = new TerminalInputQueue(data => {
    delivered.push(data);
    if (delivered.length === 1) throw new Error('delivery failed');
    return Promise.resolve();
  }, () => { errors++; });

  queue.enqueue('FIRST');
  await flush();
  assert.equal(errors, 1);
  queue.enqueue('SECOND');
  await flush();

  assert.deepEqual(delivered, ['FIRST', 'SECOND']);
});

test('closing a terminal input queue discards pending chunks', async () => {
  const { TerminalInputQueue } = await import('../src/terminalInput.ts');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const delivered = [];
  const queue = new TerminalInputQueue(async data => {
    delivered.push(data);
    if (delivered.length === 1) await gate;
  }, error => { throw error; });

  queue.enqueue('x'.repeat(20 * 1024));
  await flush();
  assert.equal(delivered.length, 1);
  queue.close();
  release();
  await flush();

  assert.equal(delivered.length, 1);
});
