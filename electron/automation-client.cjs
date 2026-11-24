'use strict';
// Local automation client. Each entry owns one authenticated connection, never
// retries, and never cancels the run it observes: a closed caller leaves the task
// and its agent untouched.
const { connect } = require('./client.cjs');

const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const MAX_TIMEOUT = 86400000;
const POLL_MS = 250;

function automationUnavailable() {
  return Object.assign(new Error('This Winmux daemon does not support local automation runs; upgrade the daemon'), { code: 'AUTOMATION_UNAVAILABLE' });
}
function abortError() {
  return Object.assign(new Error('Winmux automation wait was aborted'), { code: 'ABORT_ERR' });
}
function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

async function withClient(connection, action) {
  const client = await connect(connection ?? {});
  try { return await action(client); } finally { client.close(); }
}

// Capability is advertised by the daemon that will perform the work. An older
// daemon is refused rather than emulated with blind input.
async function requireAutomation(client) {
  const environment = await client.request('environment');
  if (environment?.capabilities?.automationRuns !== true) throw automationUnavailable();
}

async function startRun(connection, spec) {
  return withClient(connection, async client => {
    await requireAutomation(client);
    return client.request('task.run.start', spec);
  });
}

async function getRun(connection, runId, { includeScreen = false } = {}) {
  return withClient(connection, async client => {
    await requireAutomation(client);
    return client.request('task.run.get', includeScreen ? { runId, includeScreen: true } : { runId });
  });
}

function waitOptions(options) {
  const timeoutMs = options.timeoutMs === undefined ? 600000 : options.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT) throw invalid(`timeoutMs must be an integer between 0 and ${MAX_TIMEOUT}`);
  const afterRevision = options.afterRevision === undefined ? 0 : options.afterRevision;
  if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) throw invalid('afterRevision must be a nonnegative integer');
  return { timeoutMs, afterRevision, signal: options.signal };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForRun(connection, runId, options = {}) {
  const { timeoutMs, afterRevision, signal } = waitOptions(options);
  if (signal?.aborted) throw abortError();
  const client = await connect(connection ?? {});
  // An abort that lands while the connection is being established must not wait
  // for the next poll: re-check after the only await before the loop starts.
  if (signal?.aborted) { client.close(); throw abortError(); }
  const deadline = Date.now() + timeoutMs;
  const aborted = new Promise((_, reject) => { signal?.addEventListener('abort', () => reject(abortError()), { once: true }); });
  aborted.catch(() => {});
  const read = async includeScreen => client.request('task.run.get', includeScreen ? { runId, includeScreen: true } : { runId });
  // A bounded capture is the caller's view of the pane at this moment, never a
  // promise that the response text is complete.
  const finish = async (reason, fallback) => {
    let result;
    const pendingRead = read(true);
    pendingRead.catch(() => {}); // a lane lost to an abort must not surface later
    try { result = await Promise.race([pendingRead, aborted]); }
    catch (error) {
      if (error?.code === 'ABORT_ERR') throw error;
      result = { run: fallback, screen: null, screenError: typeof error?.code === 'string' ? error.code : 'RUN_OUTPUT_UNAVAILABLE' };
    }
    return { reason, ...result };
  };
  try {
    await requireAutomation(client);
    for (;;) {
      const pending = read(false);
      pending.catch(() => {}); // the losing side of an abort race must not surface later
      const result = await Promise.race([pending, aborted]);
      const run = result.run;
      // Every terminal run view is final, including an exit published after its drain.
      if (TERMINAL.has(run.status)) return await finish(run.status, run);
      if (run.status === 'waiting' && run.revision > afterRevision) return await finish('waiting', run);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return await finish('timeout', run);
      await Promise.race([sleep(Math.min(POLL_MS, remaining), signal), aborted]);
    }
  } finally {
    client.close();
  }
}

module.exports = { startRun, getRun, waitForRun, TERMINAL, MAX_TIMEOUT };
