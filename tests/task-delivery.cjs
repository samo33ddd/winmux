// Mocked GitHub PR delivery gate. The runner never invokes the network.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createTaskDelivery } = require('../electron/backend/task-delivery.cjs');

const sha = 'a'.repeat(40);
const next = 'b'.repeat(40);
const repo = 'samo33ddd/winmux';
const source = 'task-owner/winmux';
const task = { source, head: 'feat/41', sha, title: 'feat: isolated delivery', body: 'Closes nothing yet' };

function pull(overrides = {}) {
  return {
    number: 41,
    url: `https://github.com/${repo}/pull/41`,
    state: 'OPEN',
    isDraft: false,
    author: { login: 'author' },
    baseRefName: 'main',
    headRefName: 'feat/41',
    headRefOid: sha,
    headRepository: { nameWithOwner: source },
    headRepositoryOwner: { login: 'task-owner' },
    reviewDecision: 'APPROVED',
    latestReviews: [{ author: { login: 'reviewer' }, state: 'APPROVED', commit: { oid: '' }, submittedAt: '2026-11-16T10:00:00Z' }],
    reviews: [{ author: { login: 'reviewer' }, state: 'APPROVED', commit: { oid: sha }, submittedAt: '2026-11-16T10:00:00Z' }],
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    mergedAt: null,
    ...overrides,
  };
}

function checks(state, bucket) {
  return [{ name: 'required-ci', state, bucket }];
}

function scripted(steps) {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    const step = steps.shift();
    if (!step) throw new Error('unexpected gh call');
    if (step.throw) throw new Error('transport failed');
    return step;
  };
  return { calls, run };
}

function gate(steps) {
  const script = scripted(steps);
  return { ...script, delivery: createTaskDelivery({ repo, base: 'main', run: script.run }) };
}

function view(pr, code = 0) {
  return { code, stdout: JSON.stringify(pr), stderr: '' };
}

function listed(pr) {
  return { code: 0, stdout: JSON.stringify([pr]), stderr: '' };
}

test('status fails closed for a stale head, missing review, and required check states', async () => {
  const stale = gate([listed(pull({ headRefOid: next }))]);
  assert.equal((await stale.delivery.status(task)).code, 'STALE_HEAD');

  const unreviewed = gate([listed(pull({ reviewDecision: 'REVIEW_REQUIRED', reviews: [] }))]);
  assert.equal((await unreviewed.delivery.status(task)).code, 'NO_INDEPENDENT_APPROVAL');

  const authorOnly = gate([listed(pull({ reviews: [{ author: { login: 'author' }, state: 'APPROVED', commit: { oid: sha } }] }))]);
  assert.equal((await authorOnly.delivery.status(task)).code, 'NO_INDEPENDENT_APPROVAL');

  const pending = gate([listed(pull()), { code: 8, stdout: JSON.stringify(checks('PENDING', 'pending')), stderr: '' }]);
  assert.equal((await pending.delivery.status(task)).code, 'CHECKS_PENDING');

  const failed = gate([listed(pull()), { code: 1, stdout: JSON.stringify(checks('FAILURE', 'fail')), stderr: '' }]);
  assert.equal((await failed.delivery.status(task)).code, 'CHECKS_FAILED');

  const unknown = gate([listed(pull()), { code: 1, stdout: 'not json', stderr: '' }]);
  assert.equal((await unknown.delivery.status(task)).code, 'CHECKS_UNKNOWN');

  const emptyFailure = gate([listed(pull()), { code: 1, stdout: '[]', stderr: 'unable to inspect required checks' }]);
  assert.equal((await emptyFailure.delivery.status(task)).code, 'CHECKS_UNKNOWN');

  const ready = gate([listed(pull()), { code: 0, stdout: JSON.stringify(checks('SUCCESS', 'pass')), stderr: '' }]);
  const status = await ready.delivery.status(task);
  assert.equal(status.ok, true);
  assert.deepEqual(status.blockers, []);
  assert.equal(ready.calls.at(-1).args.includes('--admin'), false);
});

test('submit reconciles an uncertain creation and never sends a raw command', async () => {
  const created = gate([
    { code: 0, stdout: '[]', stderr: '' },
    { throw: true },
    listed(pull()),
  ]);
  const result = await created.delivery.submit({ ...task, body: 'First paragraph\n\nSecond paragraph' });
  assert.equal(result.ok, true);
  assert.equal(result.reconciled, true);
  assert.equal(result.number, 41);
  const create = created.calls[1].args;
  assert.deepEqual(create.slice(0, 3), ['pr', 'create', '--repo']);
  assert.equal(create.includes(`${source.split('/')[0]}:feat/41`), true);
  assert.equal(created.calls.some(call => call.args.some(arg => arg === '--admin' || arg.includes('&&'))), false);

  const unknown = gate([
    { code: 0, stdout: '[]', stderr: '' },
    { throw: true },
    { code: 0, stdout: '[]', stderr: '' },
  ]);
  const blocked = await unknown.delivery.submit(task);
  assert.equal(blocked.code, 'UNCERTAIN_SUBMIT');
  assert.equal(blocked.reconciled, true);
  assert.equal(unknown.calls.filter(call => call.args[1] === 'create').length, 1);
});

test('merge verifies the actual head and reconciles without retry or admin bypass', async () => {
  const ready = pull();
  const owned = { ...task, number: 41 };
  const success = gate([
    view(ready),
    { code: 0, stdout: JSON.stringify(checks('SUCCESS', 'pass')), stderr: '' },
    view(ready),
    { code: 0, stdout: JSON.stringify(checks('SUCCESS', 'pass')), stderr: '' },
    { code: 0, stdout: '', stderr: '' },
    view(pull({ state: 'MERGED' })),
  ]);
  const merged = await success.delivery.merge(owned);
  assert.equal(merged.ok, true);
  assert.equal(merged.state, 'MERGED');
  const command = success.calls.find(call => call.args[0] === 'pr' && call.args[1] === 'merge').args;
  assert.deepEqual(command, ['pr', 'merge', '41', '--repo', repo, '--merge', '--match-head-commit', sha]);

  const stale = gate([
    view(ready),
    { code: 0, stdout: JSON.stringify(checks('SUCCESS', 'pass')), stderr: '' },
    view(pull({ headRefOid: next })),
  ]);
  const blocked = await stale.delivery.merge(owned);
  assert.equal(blocked.code, 'STALE_HEAD');
  assert.equal(stale.calls.some(call => call.args[1] === 'merge'), false);

  const uncertain = gate([
    view(ready),
    { code: 0, stdout: JSON.stringify(checks('SUCCESS', 'pass')), stderr: '' },
    view(ready),
    { code: 0, stdout: JSON.stringify(checks('SUCCESS', 'pass')), stderr: '' },
    { throw: true },
    { code: 1, stdout: '', stderr: 'temporary failure' },
  ]);
  const unresolved = await uncertain.delivery.merge(owned);
  assert.equal(unresolved.code, 'UNCERTAIN_MERGE');
  assert.equal(uncertain.calls.filter(call => call.args[1] === 'merge').length, 1);

  const regressed = gate([view(ready), { code: 0, stdout: JSON.stringify(checks('SUCCESS', 'pass')), stderr: '' }, view(ready), { code: 8, stdout: JSON.stringify(checks('PENDING', 'pending')), stderr: '' }]);
  assert.equal((await regressed.delivery.merge(owned)).code, 'CHECKS_PENDING');
  assert.equal(regressed.calls.some(call => call.args[1] === 'merge'), false);

  await assert.rejects(() => success.delivery.submit({ ...task, command: 'cmd.exe /c gh' }), /command is not accepted/);
  await assert.rejects(() => success.delivery.merge({ ...task, admin: true }), /admin is not accepted/);
});
