'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

class TaskGitError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'TaskGitError';
    this.code = code;
    this.operation = options.operation || null;
    this.details = options.details || null;
  }
}

function normalizeEnvironment(value = 'windows') {
  if (value !== 'windows' && value !== 'wsl') {
    throw new TaskGitError('INVALID_ARGUMENT', 'environment must be windows or wsl');
  }
  return value;
}

function validateContext(params, operation) {
  if (!params || typeof params !== 'object') {
    throw new TaskGitError('INVALID_ARGUMENT', 'Operation parameters are required', { operation });
  }
  const environment = normalizeEnvironment(params.environment);
  if (environment === 'wsl' && (
    typeof params.distro !== 'string'
    || !params.distro.trim()
    || params.distro.length > 128
    || /[\x00-\x1f]/.test(params.distro)
  )) {
    throw new TaskGitError('INVALID_ARGUMENT', 'distro is required for WSL', { operation });
  }
  return {
    environment,
    distro: environment === 'wsl' ? params.distro : undefined
  };
}

function requireAbsolute(value, name, environment, operation) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value) || value.length > 32_767) {
    throw new TaskGitError('INVALID_ARGUMENT', `${name} must be an absolute path`, { operation });
  }
  const absolute = environment === 'wsl'
    ? path.posix.isAbsolute(value)
    : path.win32.isAbsolute(value);
  if (!absolute) {
    throw new TaskGitError('INVALID_ARGUMENT', `${name} must be an absolute path`, { operation });
  }
  return value;
}

function normalizePath(value, environment) {
  if (environment === 'wsl') return path.posix.normalize(value);
  return path.win32.normalize(value).replace(/\//g, '\\');
}

function pathIdentity(value, environment) {
  const normalized = normalizePath(value, environment);
  return environment === 'wsl' ? normalized : normalized.toLowerCase();
}

function validateTaskId(taskId, operation) {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) {
    throw new TaskGitError(
      'INVALID_ARGUMENT',
      'taskId must contain only letters, numbers, underscores, or hyphens',
      { operation }
    );
  }
}

function validateValue(value, name, operation) {
  if (
    typeof value !== 'string'
    || !value
    || value.length > 1024
    || /[\x00-\x1f]/.test(value)
  ) {
    throw new TaskGitError('INVALID_ARGUMENT', `${name} is invalid`, { operation });
  }
}

function callExecFile(exec, file, args, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({
          stdout: Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || ''),
          stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '')
        });
      }
    };

    let child;
    try {
      child = exec(file, args, options, finish);
    } catch (error) {
      finish(error, '', '');
      return;
    }
    if (child && typeof child.then === 'function') {
      child.then(
        (result) => resolve({
          stdout: Buffer.isBuffer(result?.stdout) ? result.stdout.toString('utf8') : String(result?.stdout || ''),
          stderr: Buffer.isBuffer(result?.stderr) ? result.stderr.toString('utf8') : String(result?.stderr || '')
        }),
        (error) => finish(error, error?.stdout || '', error?.stderr || '')
      );
    }
  });
}

function createGitExecutor(options = {}) {
  const exec = options.execFile || execFile;
  const git = options.git || 'git';
  const wsl = options.wsl || 'wsl.exe';
  const timeout = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer || DEFAULT_MAX_BUFFER;

  if (typeof exec !== 'function') {
    throw new TaskGitError('INVALID_ARGUMENT', 'execFile must be a function');
  }
  if (typeof git !== 'string' || !git || typeof wsl !== 'string' || !wsl) {
    throw new TaskGitError('INVALID_ARGUMENT', 'Git and WSL executable names must be strings');
  }

  return async function executeGit(args, context = {}) {
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new TaskGitError('INVALID_ARGUMENT', 'Git arguments must be strings');
    }
    const environment = normalizeEnvironment(context.environment);
    const cwd = requireAbsolute(context.cwd, 'cwd', environment, 'execute');
    const command = environment === 'wsl' ? wsl : git;
    const commandArgs = environment === 'wsl'
      ? ['-d', context.distro, '--exec', git, '-C', cwd, ...args]
      : ['-C', cwd, ...args];
    return callExecFile(exec, command, commandArgs, {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0'
      },
      maxBuffer,
      timeout,
      windowsHide: true
    });
  };
}

function parseBranches(stdout) {
  const branches = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [name, head, marker, upstream] = line.split('\0');
    if (!name) continue;
    branches.push({
      name,
      head: head || null,
      current: marker === '*',
      upstream: upstream || null
    });
  }
  return branches;
}

function parseWorktrees(stdout) {
  const worktrees = [];
  let current = null;
  for (const field of stdout.split('\0')) {
    if (!field) continue;
    if (field.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = {
        path: field.slice('worktree '.length),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        lockReason: null,
        prunable: false,
        prunableReason: null
      };
      continue;
    }
    if (!current) continue;
    if (field.startsWith('HEAD ')) current.head = field.slice(5);
    else if (field.startsWith('branch ')) current.branch = field.slice(7).replace(/^refs\/heads\//, '');
    else if (field.startsWith('locked')) current.locked = true;
    else if (field.startsWith('prunable')) current.prunable = true;
    else if (field === 'detached') current.detached = true;
    else if (field === 'bare') current.bare = true;
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function statusCounts(stdout) {
  const counts = { tracked: 0, untracked: 0, ignored: 0 };
  for (const record of stdout.split('\0')) {
    if (record.length < 3) continue;
    const state = record.slice(0, 2);
    if (state === '??') counts.untracked += 1;
    else if (state === '!!') counts.ignored += 1;
    else counts.tracked += 1;
  }
  return counts;
}

function safeGitMessage(error) {
  const source = error?.stderr || error?.message || 'Git command failed';
  return String(source).trim().split(/\r?\n/, 1)[0].slice(0, 500) || 'Git command failed';
}

function createTaskGitService(options = {}) {
  const execute = options.execute || createGitExecutor(options);
  if (typeof execute !== 'function') {
    throw new TaskGitError('INVALID_ARGUMENT', 'execute must be a function');
  }
  const records = new Map();
  const store = options.store || {
    get: async (taskId) => records.get(taskId) || null,
    set: async (taskId, record) => {
      records.set(taskId, { ...record });
    },
    delete: async (taskId) => records.delete(taskId),
    entries: async () => [...records.values()]
  };
  if (
    !store
    || ['get', 'set', 'delete', 'entries'].some((method) => typeof store[method] !== 'function')
  ) {
    throw new TaskGitError(
      'INVALID_ARGUMENT',
      'store must implement get, set, delete, and entries'
    );
  }

  async function run(args, context, accepted = [0]) {
    try {
      const result = await execute(args, context);
      const stdout = typeof result === 'string'
        ? result
        : (result?.stdout === undefined ? '' : String(result.stdout));
      return { stdout, status: 0 };
    } catch (error) {
      const status = Number.isInteger(error?.status)
        ? error.status
        : (Number.isInteger(error?.code) ? error.code : null);
      if (status !== null && accepted.includes(status)) {
        const stdout = Buffer.isBuffer(error?.stdout)
          ? error.stdout.toString('utf8')
          : String(error?.stdout || '');
        return { stdout, status };
      }
      throw new TaskGitError('GIT_FAILED', safeGitMessage(error), {
        details: { status },
        cause: error
      });
    }
  }

  async function operation(name, callback) {
    try {
      return await callback();
    } catch (error) {
      if (error instanceof TaskGitError) {
        if (!error.operation) error.operation = name;
        throw error;
      }
      throw new TaskGitError('GIT_FAILED', safeGitMessage(error), {
        operation: name,
        cause: error
      });
    }
  }

  async function inspect(params) {
    const context = validateContext(params, 'inspectRepository');
    const repo = requireAbsolute(params.repo, 'repo', context.environment, 'inspectRepository');
    const cwd = normalizePath(repo, context.environment);
    const rootResult = await run(
      ['rev-parse', '--path-format=absolute', '--show-toplevel'],
      { ...context, cwd }
    );
    const commonResult = await run(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { ...context, cwd }
    );
    const bareResult = await run(['rev-parse', '--is-bare-repository'], { ...context, cwd });
    const branchResult = await run(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      { ...context, cwd },
      [1]
    );
    const headResult = await run(
      ['rev-parse', '--verify', 'HEAD'],
      { ...context, cwd },
      [128]
    );
    return {
      root: rootResult.stdout.trim(),
      commonDir: commonResult.stdout.trim(),
      bare: bareResult.stdout.trim() === 'true',
      branch: branchResult.stdout.trim() || null,
      head: headResult.stdout.trim() || null
    };
  }

  async function listWorktrees(params) {
    return operation('listWorktrees', async () => {
      const context = validateContext(params, 'listWorktrees');
      const repo = requireAbsolute(params.repo, 'repo', context.environment, 'listWorktrees');
      const [worktreeResult, ownership] = await Promise.all([
        run(['worktree', 'list', '--porcelain', '-z'], { ...context, cwd: repo }),
        store.entries()
      ]);

      const recordsByPath = new Map();
      for (const record of ownership) {
        if (!record?.taskId || !record.path || !record.branch || record.environment !== context.environment || record.distro !== context.distro) continue;
        const identity = pathIdentity(record.path, context.environment);
        const records = recordsByPath.get(identity) || [];
        records.push(record);
        recordsByPath.set(identity, records);
      }

      const worktrees = parseWorktrees(worktreeResult.stdout);
      const primary = worktrees[0]?.path;
      return worktrees.map((worktree) => {
        const matches = recordsByPath.get(pathIdentity(worktree.path, context.environment)) || [];
        const owned = matches.length === 1 ? matches[0] : null;
        const managed = Boolean(
          owned
          && owned.branch === worktree.branch
          && pathIdentity(worktree.path, context.environment)
            !== pathIdentity(primary, context.environment)
        );
        return {
          ...worktree,
          primary: pathIdentity(worktree.path, context.environment)
            === pathIdentity(primary, context.environment),
          taskId: managed ? owned.taskId : null,
          managed,
          imported: !managed,
          ownershipConflict: matches.length > 1
        };
      });
    });
  }

  async function listBranches(params) {
    return operation('listBranches', async () => {
      const context = validateContext(params, 'listBranches');
      const repo = requireAbsolute(params.repo, 'repo', context.environment, 'listBranches');
      const result = await run(
        [
          'for-each-ref',
          '--format=%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)',
          'refs/heads'
        ],
        { ...context, cwd: repo }
      );
      return parseBranches(result.stdout);
    });
  }

  async function createWorktree(params) {
    return operation('createWorktree', async () => {
      const context = validateContext(params, 'createWorktree');
      const repo = requireAbsolute(params.repo, 'repo', context.environment, 'createWorktree');
      const target = requireAbsolute(params.path, 'path', context.environment, 'createWorktree');
      validateTaskId(params.taskId, 'createWorktree');
      validateValue(params.branch, 'branch', 'createWorktree');
      validateValue(params.base, 'base', 'createWorktree');
      if (!params.restore && params.branch === params.base) {
        throw new TaskGitError(
          'INVALID_ARGUMENT',
          'branch and base must be different',
          { operation: 'createWorktree' }
        );
      }

      const repository = await inspect(params);
      if (repository.bare) {
        throw new TaskGitError('INVALID_REPOSITORY', 'Bare repositories cannot host task worktrees', {
          operation: 'createWorktree'
        });
      }
      const branches = await listBranches(params);
      if (!params.restore && !branches.some((branch) => branch.name === params.base)) {
        throw new TaskGitError('BASE_BRANCH_NOT_FOUND', 'Base branch is not local', {
          operation: 'createWorktree'
        });
      }
      const existing = await listWorktrees(params);
      if (existing.some(
        (worktree) => pathIdentity(worktree.path, context.environment)
          === pathIdentity(target, context.environment)
      )) {
        throw new TaskGitError('WORKTREE_EXISTS', 'Target is already a worktree', {
          operation: 'createWorktree'
        });
      }
      if (await store.get(params.taskId)) {
        throw new TaskGitError('TASK_ID_IN_USE', 'Task ID already owns worktree metadata', {
          operation: 'createWorktree'
        });
      }

      await run(['check-ref-format', '--branch', params.branch], {
        ...context,
        cwd: repo
      });
      const branchExists = await run(
        ['show-ref', '--verify', '--quiet', `refs/heads/${params.branch}`],
        { ...context, cwd: repo },
        [1]
      );
      if (!params.restore && branchExists.status === 0) {
        throw new TaskGitError('BRANCH_EXISTS', 'Branch already exists', {
          operation: 'createWorktree'
        });
      }
      if (params.restore && branchExists.status !== 0) throw new TaskGitError('BRANCH_NOT_FOUND', 'Task branch does not exist', { operation:'createWorktree' });

      await run(
        params.restore ? ['worktree', 'add', normalizePath(target, context.environment), params.branch] : ['worktree', 'add', '-b', params.branch, normalizePath(target, context.environment), params.base],
        { ...context, cwd: repo }
      );

      const adminDir = await run(
        ['rev-parse', '--path-format=absolute', '--absolute-git-dir'],
        { ...context, cwd: normalizePath(target, context.environment) }
      );
      const marker = randomUUID();
      const markerFile = (context.environment === 'wsl' ? path.posix : path.win32).join(adminDir.stdout.trim(), 'winmux-task-owner');
      await run(['config', '--file', markerFile, 'winmux.taskId', marker], { ...context, cwd:repo });
      await store.set(params.taskId, {
        taskId: params.taskId,
        path: normalizePath(target, context.environment),
        branch: params.branch,
        environment: context.environment,
        distro: context.distro,
        adminDir: adminDir.stdout.trim(), marker
      });

      const created = (await listWorktrees(params)).find(
        (worktree) => pathIdentity(worktree.path, context.environment)
          === pathIdentity(target, context.environment)
      );
      if (!created?.managed) {
        throw new TaskGitError('OWNERSHIP_ERROR', 'Created worktree ownership could not be verified', {
          operation: 'createWorktree'
        });
      }
      return created;
    });
  }

  async function attachWorktree(params) {
    return operation('attachWorktree', async () => {
      const context = validateContext(params, 'attachWorktree');
      requireAbsolute(params.repo, 'repo', context.environment, 'attachWorktree');
      const target = requireAbsolute(params.path, 'path', context.environment, 'attachWorktree');
      const worktree = (await listWorktrees(params)).find(
        (candidate) => pathIdentity(candidate.path, context.environment)
          === pathIdentity(target, context.environment)
      );
      if (!worktree) {
        throw new TaskGitError('WORKTREE_NOT_FOUND', 'Worktree does not belong to this repository', {
          operation: 'attachWorktree'
        });
      }
      if (worktree.primary) {
        throw new TaskGitError('PRIMARY_WORKTREE', 'The primary checkout cannot be attached as a task', {
          operation: 'attachWorktree'
        });
      }
      return worktree;
    });
  }

  async function removeWorktree(params) {
    return operation('removeWorktree', async () => {
      const context = validateContext(params, 'removeWorktree');
      const repo = requireAbsolute(params.repo, 'repo', context.environment, 'removeWorktree');
      const target = requireAbsolute(params.path, 'path', context.environment, 'removeWorktree');
      validateTaskId(params.taskId, 'removeWorktree');

      const record = await store.get(params.taskId);
      if (!record?.path || !record.branch) {
        throw new TaskGitError('WORKTREE_NOT_MANAGED', 'Worktree is not managed by this task', {
          operation: 'removeWorktree'
        });
      }
      if (pathIdentity(record.path, context.environment)
        !== pathIdentity(target, context.environment)) {
        throw new TaskGitError('WORKTREE_OWNERSHIP_MISMATCH', 'Worktree path does not match task ownership', {
          operation: 'removeWorktree'
        });
      }
      if (!record.adminDir || !record.marker) {
        throw new TaskGitError('WORKTREE_OWNERSHIP_MISMATCH', 'Task ownership has no worktree identity', {
          operation: 'removeWorktree'
        });
      }

      const worktree = (await listWorktrees(params)).find(
        (candidate) => pathIdentity(candidate.path, context.environment)
          === pathIdentity(target, context.environment)
      );
      if (!worktree) {
        throw new TaskGitError('WORKTREE_NOT_FOUND', 'Managed worktree is missing', {
          operation: 'removeWorktree'
        });
      }
      if (
        !worktree.managed
        || worktree.taskId !== params.taskId
        || worktree.ownershipConflict
      ) {
        throw new TaskGitError('WORKTREE_NOT_MANAGED', 'Worktree ownership is not unambiguous', {
          operation: 'removeWorktree'
        });
      }
      if (worktree.branch !== record.branch) {
        throw new TaskGitError('WORKTREE_OWNERSHIP_MISMATCH', 'Worktree branch does not match task ownership', {
          operation: 'removeWorktree'
        });
      }
      const adminDir = await run(
        ['rev-parse', '--path-format=absolute', '--absolute-git-dir'],
        { ...context, cwd: normalizePath(worktree.path, context.environment) }
      );
      if (pathIdentity(adminDir.stdout.trim(), context.environment)
        !== pathIdentity(record.adminDir, context.environment)) {
        throw new TaskGitError(
          'WORKTREE_OWNERSHIP_MISMATCH',
          'Worktree Git identity does not match task ownership',
          { operation: 'removeWorktree' }
        );
      }
      const markerFile = (context.environment === 'wsl' ? path.posix : path.win32).join(adminDir.stdout.trim(), 'winmux-task-owner');
      const marker = await run(['config', '--file', markerFile, '--get', 'winmux.taskId'], { ...context, cwd:repo }, [1]);
      if (marker.status !== 0 || marker.stdout.trim() !== record.marker) throw new TaskGitError('WORKTREE_OWNERSHIP_MISMATCH', 'Worktree ownership marker is missing or changed', { operation:'removeWorktree' });
      if (worktree.locked || worktree.bare || worktree.prunable) {
        throw new TaskGitError('WORKTREE_LOCKED', 'Locked, bare, or prunable worktrees cannot be removed', {
          operation: 'removeWorktree'
        });
      }

      const status = await run(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
        { ...context, cwd: normalizePath(worktree.path, context.environment) }
      );
      if (status.stdout) {
        throw new TaskGitError(
          'WORKTREE_NOT_CLEAN',
          'Worktree contains tracked, untracked, or ignored data',
          { operation: 'removeWorktree', details: statusCounts(status.stdout) }
        );
      }

      await run(
        ['worktree', 'remove', normalizePath(worktree.path, context.environment)],
        { ...context, cwd: repo }
      );

      let metadataCleared = true;
      try {
        await store.delete(params.taskId);
      } catch {
        metadataCleared = false;
      }
      return {
        removed: true,
        branch: record.branch,
        branchPreserved: true,
        metadataCleared
      };
    });
  }

  return Object.freeze({
    inspectRepository: (params) => operation('inspectRepository', () => inspect(params)),
    listBranches,
    listWorktrees,
    createWorktree,
    attachWorktree,
    removeWorktree
  });
}

module.exports = {
  TaskGitError,
  createGitExecutor,
  createTaskGitService
};
