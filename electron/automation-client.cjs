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
  const client = await connect({ ...(connection ?? {}), signal });
  // An abort that lands while the connection is being established must not wait
  // for the next poll: re-check after the only await before the loop starts.
  if (signal?.aborted) { client.close(); throw abortError(); }
  const deadline = Date.now() + timeoutMs;
  let rejectAbort = () => {};
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(abortError()); });
  const onAbort = () => rejectAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
  aborted.catch(() => {});
  const read = async (includeScreen, requestSignal = null) => client.request('task.run.get', includeScreen ? { runId, includeScreen: true } : { runId }, requestSignal);
  const reasonFor = run => TERMINAL.has(run.status) ? run.status
    : run.status === 'waiting' && run.revision > afterRevision ? 'waiting' : null;
  const expired = Symbol('deadline expired');
  try {
    await requireAutomation(client);
    let firstPoll = true;
    for (;;) {
      let result = expired;
      // Always issue the initial inspection, even for a zero timeout. Later
      // polls must not start once the original deadline has passed.
      if (firstPoll || Date.now() < deadline) {
        firstPoll = false;
        let timer;
        const pollController = new AbortController();
        try {
          const deadlineReached = new Promise(resolve => {
            timer = setTimeout(() => resolve(expired), Math.max(0, deadline - Date.now()));
          });
          // Promise.race handles rejection when the losing poll is cancelled.
          result = await Promise.race([read(false, pollController.signal), deadlineReached, aborted]);
        } finally {
          clearTimeout(timer);
          // An expired poll must not retain its request timer and interrupt the
          // final capture on this connection. This only cancels the local read.
          pollController.abort();
        }
      }
      if (result === expired || reasonFor(result.run) || Date.now() >= deadline) {
        // The capture can observe a newer state than the poll. Only daemon-reported
        // screen errors are recoverable; a failed RPC leaves the latest state unknown.
        const pendingRead = read(true);
        pendingRead.catch(() => {});
        const captured = await Promise.race([pendingRead, aborted]);
        const reason = reasonFor(captured.run);
        if (reason) return { reason, ...captured };
        if (Date.now() >= deadline) return { reason: 'timeout', ...captured };
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await sleep(Math.min(POLL_MS, remaining), signal);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    client.close();
  }
}

module.exports = { startRun, getRun, waitForRun, TERMINAL, MAX_TIMEOUT };
