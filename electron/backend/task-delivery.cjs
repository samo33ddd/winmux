'use strict';

const { execFile } = require('node:child_process');
const { fail, integer, string } = require('./shared.cjs');

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VIEW_FIELDS = 'number,url,state,isDraft,author,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,reviewDecision,reviews,latestReviews,mergeStateStatus,mergeable,mergedAt';
const CODE_ORDER = ['SOURCE_MISMATCH', 'BASE_MISMATCH', 'HEAD_MISMATCH', 'STALE_HEAD', 'AMBIGUOUS_PR', 'NOT_FOUND', 'NO_INDEPENDENT_APPROVAL', 'CHECKS_FAILED', 'CHECKS_PENDING', 'CHECKS_UNKNOWN', 'MERGE_BLOCKED', 'UNCERTAIN_SUBMIT', 'UNCERTAIN_MERGE', 'UNAVAILABLE'];

function defaultRun(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ stdout: stdout || '', stderr: stderr || '', code: error ? error.code : 0 });
    });
  });
}

function repository(value) {
  if (!REPO.test(value)) fail('INVALID_ARGUMENT', 'repository must be owner/name');
  return value;
}

function branch(value) {
  const parts = value.split('/');
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('-') || value.endsWith('/') || value.endsWith('.lock') || parts.some(part => !part || part === '.' || part === '..')) {
    fail('INVALID_ARGUMENT', 'Invalid branch name');
  }
  return value;
}

function login(value) {
  if (typeof value === 'string') return value;
  return value && typeof value.login === 'string' ? value.login : '';
}

function ordered(blockers) {
  const known = CODE_ORDER.filter(code => blockers.includes(code));
  return known.concat(blockers.filter(code => !known.includes(code)));
}

function createTaskDelivery(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('INVALID_ARGUMENT', 'options must be an object');
  const repo = repository(string(options.repo, 'repo', 200));
  const base = branch(string(options.base, 'base', 200));
  const gh = string(options.gh || 'gh', 'gh', 260);
  if (/[\r\n\0]/.test(gh)) fail('INVALID_ARGUMENT', 'Invalid gh executable');
  if (options.run !== undefined && typeof options.run !== 'function') fail('INVALID_ARGUMENT', 'run must be a function');
  const run = options.run || defaultRun;

  function taskSpec(task) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) fail('INVALID_ARGUMENT', 'task must be an object');
    for (const key of ['command', 'args', 'admin', 'script', 'shell']) {
      if (Object.prototype.hasOwnProperty.call(task, key)) fail('INVALID_ARGUMENT', `task.${key} is not accepted`);
    }
    const source = repository(string(task.source, 'source', 200));
    const head = branch(string(task.head, 'head', 200));
    const sha = string(task.sha, 'sha', 40).toLowerCase();
    if (!SHA.test(sha)) fail('INVALID_ARGUMENT', 'sha must be 40 hex characters');
    const spec = { source, head, sha };
    if (task.number !== undefined) spec.number = integer(task.number, 'number', 1, 1000000000);
    if (task.title !== undefined) spec.title = task.title;
    if (task.body !== undefined) spec.body = task.body;
    return spec;
  }

  function finish(action, spec, blockers, pr, extra = {}) {
    const codes = ordered(blockers);
    return {
      ok: codes.length === 0,
      action,
      code: codes[0] || null,
      blockers: codes,
      reconciled: extra.reconciled === true,
      repo,
      base,
      source: spec.source,
      head: spec.head,
      sha: spec.sha,
      number: pr && Number.isInteger(pr.number) ? pr.number : null,
      url: pr && typeof pr.url === 'string' ? pr.url : null,
      headOid: pr && typeof pr.headRefOid === 'string' ? pr.headRefOid.toLowerCase() : null,
      state: pr && pr.state ? String(pr.state).toUpperCase() : null,
    };
  }

  async function invoke(args) {
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) fail('INVALID_ARGUMENT', 'Invalid gh arguments');
    if (args.some(arg => /^(--admin|--auto|--delete-branch|--squash|--rebase)(?:=|$)/.test(arg) || arg === '-d')) fail('INVALID_ARGUMENT', 'Refusing unsafe gh flags');
    const result = await run(gh, args);
    if (!result || typeof result.stdout !== 'string' || (result.stderr !== undefined && typeof result.stderr !== 'string') || typeof result.code !== 'number') {
      fail('INVALID_ARGUMENT', 'gh runner returned an invalid result');
    }
    return { stdout: result.stdout, stderr: typeof result.stderr === 'string' ? result.stderr : '', code: result.code };
  }

  function sameBaseUrl(url, number) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return false;
      const pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase();
      return pathname === `/${repo.toLowerCase()}/pull/${number}`;
    } catch {
      return false;
    }
  }

  function sameSource(pr, source) {
    const owner = login(pr.headRepositoryOwner).toLowerCase();
    const expectedOwner = source.split('/')[0].toLowerCase();
    const named = pr.headRepository && typeof pr.headRepository.nameWithOwner === 'string' ? pr.headRepository.nameWithOwner.toLowerCase() : '';
    const name = pr.headRepository && typeof pr.headRepository.name === 'string' ? pr.headRepository.name.toLowerCase() : '';
    if (!owner || owner !== expectedOwner) return false;
    if (named) return named === source.toLowerCase();
    return Boolean(name) && `${owner}/${name}` === source.toLowerCase();
  }

  function identityBlockers(pr, spec) {
    const blockers = [];
    if (!sameSource(pr, spec.source)) blockers.push('SOURCE_MISMATCH');
    if (pr.baseRefName !== base || !sameBaseUrl(pr.url, pr.number)) blockers.push('BASE_MISMATCH');
    if (pr.headRefName !== spec.head) blockers.push('HEAD_MISMATCH');
    if (typeof pr.headRefOid !== 'string' || pr.headRefOid.toLowerCase() !== spec.sha) blockers.push('STALE_HEAD');
    return blockers;
  }

  function reviewOid(review) {
    const commit = review && review.commit;
    const value = commit && typeof commit === 'object' ? commit.oid : commit;
    return typeof value === 'string' ? value.toLowerCase() : '';
  }

  function reviewBlockers(pr, sha) {
    const author = login(pr.author).toLowerCase();
    const rows = Array.isArray(pr.reviews) ? pr.reviews : [];
    const latest = new Map();
    for (const review of [...rows].sort((left, right) => String(left.submittedAt || '').localeCompare(String(right.submittedAt || '')))) {
      const name = login(review.author).toLowerCase();
      if (name) latest.set(name, review);
    }
    const onHead = [...latest.values()].filter(review => reviewOid(review) === sha && login(review.author).toLowerCase() !== author);
    const approved = Boolean(author) && onHead.some(review => review.state === 'APPROVED');
    const changes = onHead.some(review => review.state === 'CHANGES_REQUESTED') || pr.reviewDecision === 'CHANGES_REQUESTED' || pr.reviewDecision === 'REVIEW_REQUIRED';
    return approved && !changes ? [] : ['NO_INDEPENDENT_APPROVAL'];
  }

  function classifyChecks(payload) {
    if (!Array.isArray(payload)) return ['CHECKS_UNKNOWN'];
    const blockers = [];
    for (const check of payload) {
      const bucket = check && check.bucket;
      const state = String(check && check.state || '').toUpperCase();
      const failed = bucket === 'fail' || bucket === 'cancel' || ['FAILURE', 'FAILED', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(state);
      const pending = bucket === 'pending' || ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', 'REQUESTED'].includes(state);
      const passed = bucket === 'pass' || state === 'SUCCESS' || ((bucket === 'skipping' || state === 'SKIPPED' || state === 'NEUTRAL') && !failed);
      if (failed) blockers.push('CHECKS_FAILED');
      else if (pending) blockers.push('CHECKS_PENDING');
      else if (!passed) blockers.push('CHECKS_UNKNOWN');
    }
    return blockers;
  }

  async function checkBlockers(number) {
    let result;
    try {
      result = await invoke(['pr', 'checks', String(number), '--repo', repo, '--required', '--json', 'name,state,bucket']);
    } catch {
      return ['CHECKS_UNKNOWN'];
    }
    const text = result.stdout.trim();
    if (!text) return result.code === 8 ? ['CHECKS_PENDING'] : ['CHECKS_UNKNOWN'];
    try {
      const checks = JSON.parse(text);
      if (result.code !== 0 && result.code !== 8 && (!Array.isArray(checks) || !checks.length)) return ['CHECKS_UNKNOWN'];
      return classifyChecks(checks);
    }
    catch { return ['CHECKS_UNKNOWN']; }
  }

  function readiness(pr, gate) {
    const state = String(pr.state || '').toUpperCase();
    if (pr.isDraft || state === 'CLOSED' || state !== 'OPEN' && state !== 'MERGED') return ['MERGE_BLOCKED'];
    if (state === 'MERGED') return [];
    if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY' || pr.mergeStateStatus === 'BEHIND') return ['MERGE_BLOCKED'];
    if (gate.length) return [];
    return pr.mergeStateStatus === 'CLEAN' && pr.mergeable === 'MERGEABLE' ? [] : ['MERGE_BLOCKED'];
  }

  async function openBlockers(pr, spec) {
    if (String(pr.state || '').toUpperCase() === 'MERGED') return [];
    const review = reviewBlockers(pr, spec.sha);
    const checks = await checkBlockers(pr.number);
    return ordered([...review, ...checks, ...readiness(pr, [...review, ...checks])]);
  }

  async function view(number) {
    let result;
    try { result = await invoke(['pr', 'view', String(number), '--repo', repo, '--json', VIEW_FIELDS]); }
    catch { return { unavailable: true }; }
    if (result.code !== 0) return /not found|could not resolve/i.test(result.stderr) ? { pr: null } : { unavailable: true };
    try {
      const pr = JSON.parse(result.stdout);
      return pr && typeof pr === 'object' && Number.isInteger(pr.number) ? { pr } : { unavailable: true };
    } catch { return { unavailable: true }; }
  }

  async function resolve(spec) {
    if (spec.number) return view(spec.number);
    let result;
    try {
      result = await invoke(['pr', 'list', '--repo', repo, '--base', base, '--head', spec.head, '--state', 'open', '--limit', '30', '--json', VIEW_FIELDS]);
    } catch { return { unavailable: true }; }
    if (result.code !== 0) return { unavailable: true };
    let rows;
    try { rows = JSON.parse(result.stdout); }
    catch { return { unavailable: true }; }
    if (!Array.isArray(rows)) return { unavailable: true };
    // shortcut: a full page of 30 is ambiguous because gh --head cannot filter owner:branch, raise only if one branch exceeds 30 open PRs
    if (rows.length >= 30) return { ambiguous: true };
    const matched = rows.filter(pr => pr.headRefName === spec.head && pr.baseRefName === base && sameSource(pr, spec.source));
    if (matched.length > 1) return { ambiguous: true };
    return matched.length === 1 ? { pr: matched[0] } : { pr: null };
  }

  function numberFrom(stdout) {
    const match = stdout.match(/https?:\/\/\S+\/pull\/(\d+)/);
    if (!match) return null;
    const number = Number(match[1]);
    return Number.isInteger(number) && sameBaseUrl(match[0], number) ? number : null;
  }

  async function confirmCreated(spec, number) {
    if (number) {
      const viewed = await view(number);
      if (viewed.pr) return viewed;
    }
    return resolve(spec);
  }

  async function status(task) {
    const spec = taskSpec(task);
    const found = await resolve(spec);
    if (found.unavailable) return finish('status', spec, ['UNAVAILABLE']);
    if (found.ambiguous) return finish('status', spec, ['AMBIGUOUS_PR']);
    if (!found.pr) return finish('status', spec, ['NOT_FOUND']);
    const identity = identityBlockers(found.pr, spec);
    if (identity.length) return finish('status', spec, identity, found.pr);
    return finish('status', spec, await openBlockers(found.pr, spec), found.pr);
  }

  async function submit(task) {
    const spec = taskSpec(task);
    const found = await resolve(spec);
    if (found.unavailable) return finish('submit', spec, ['UNAVAILABLE']);
    if (found.ambiguous) return finish('submit', spec, ['AMBIGUOUS_PR']);
    if (found.pr) return finish('submit', spec, identityBlockers(found.pr, spec), found.pr);
    const title = string(spec.title, 'title', 256);
    const body = spec.body === undefined ? '' : spec.body;
    if (typeof body !== 'string' || body.includes('\0') || body.length > 65536) fail('INVALID_ARGUMENT', 'body must be a string of at most 65536 characters');
    let created = null;
    try {
      created = await invoke(['pr', 'create', '--repo', repo, '--base', base, '--head', `${spec.source.split('/')[0]}:${spec.head}`, '--title', title, '--body', body]);
    } catch { created = null; }
    const confirmed = await confirmCreated(spec, created && created.code === 0 ? numberFrom(created.stdout) : null);
    const reconciled = !(created && created.code === 0 && confirmed.pr && identityBlockers(confirmed.pr, spec).length === 0);
    if (confirmed.ambiguous) return finish('submit', spec, ['AMBIGUOUS_PR'], null, { reconciled: true });
    if (!confirmed.pr) return finish('submit', spec, ['UNCERTAIN_SUBMIT'], null, { reconciled: true });
    return finish('submit', spec, identityBlockers(confirmed.pr, spec), confirmed.pr, { reconciled });
  }

  async function merge(task) {
    const spec = taskSpec(task);
    const found = await resolve(spec);
    if (found.unavailable) return finish('merge', spec, ['UNAVAILABLE']);
    if (found.ambiguous) return finish('merge', spec, ['AMBIGUOUS_PR']);
    if (!found.pr) return finish('merge', spec, ['NOT_FOUND']);
    const identity = identityBlockers(found.pr, spec);
    if (identity.length) return finish('merge', spec, identity, found.pr);
    if (String(found.pr.state || '').toUpperCase() === 'MERGED') return finish('merge', spec, [], found.pr, { reconciled: true });
    const blockers = await openBlockers(found.pr, spec);
    if (blockers.length) return finish('merge', spec, blockers, found.pr);
    const again = await view(found.pr.number);
    if (!again.pr) return finish('merge', spec, ['UNAVAILABLE'], found.pr, { reconciled: true });
    const moved = identityBlockers(again.pr, spec);
    if (moved.length) return finish('merge', spec, moved, again.pr, { reconciled: true });
    const review = reviewBlockers(again.pr, spec.sha);
    const checks = await checkBlockers(again.pr.number);
    const ready = ordered([...review, ...checks, ...readiness(again.pr, [...review, ...checks])]);
    if (ready.length) return finish('merge', spec, ready, again.pr, { reconciled: true });
    let uncertain = false;
    try {
      const merged = await invoke(['pr', 'merge', String(again.pr.number), '--repo', repo, '--merge', '--match-head-commit', spec.sha]);
      uncertain = merged.code !== 0;
    } catch { uncertain = true; }
    const confirm = await view(again.pr.number);
    if (confirm.pr && String(confirm.pr.state || '').toUpperCase() === 'MERGED' && identityBlockers(confirm.pr, spec).length === 0) {
      return finish('merge', spec, [], confirm.pr, { reconciled: uncertain });
    }
    if (confirm.pr && identityBlockers(confirm.pr, spec).includes('STALE_HEAD')) return finish('merge', spec, ['STALE_HEAD'], confirm.pr, { reconciled: true });
    return finish('merge', spec, ['UNCERTAIN_MERGE'], confirm.pr, { reconciled: Boolean(confirm.pr) });
  }

  return { status, submit, merge };
}

module.exports = { createTaskDelivery };
