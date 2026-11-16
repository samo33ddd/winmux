'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const {
  createGitExecutor,
  createTaskGitService,
  TaskGitError
} = require('../electron/backend/task-git.cjs');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0'
    },
    windowsHide: true
  });
}

async function fixture(t) {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'winmux-task-git-'));
  t.after(() => fsPromises.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await fsPromises.mkdir(repo);
  await fsPromises.writeFile(path.join(repo, 'tracked.txt'), 'initial\n');
  await fsPromises.writeFile(path.join(repo, '.gitignore'), '*.ignored\nignored-dir/\n');
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Winmux Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fixture');
  return { root, repo };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert(error instanceof TaskGitError);
    assert.equal(error.code, code);
    assert.equal(error.operation, 'removeWorktree');
    return true;
  });
}

test('create, inspect, attach, and clean removal', async (t) => {
  const { root, repo } = await fixture(t);
  const service = createTaskGitService();
  const managedPath = path.join(root, 'managed task');
  const importedPath = path.join(root, 'imported task');

  const repository = await service.inspectRepository({ repo });
  assert.equal(path.resolve(repository.root), path.resolve(repo));
  assert.equal(repository.branch, 'main');
  assert((await service.listBranches({ repo })).some((branch) => branch.name === 'main'));

  const created = await service.createWorktree({
    repo,
    path: managedPath,
    branch: 'task/managed',
    base: 'main',
    taskId: 'task-1'
  });
  assert.equal(created.managed, true);
  assert.equal(created.imported, false);
  assert.equal(created.taskId, 'task-1');
  assert.equal(created.branch, 'task/managed');
  assert.match(
    git(repo, 'show-ref', '--verify', 'refs/heads/task/managed').trim(),
    /^[0-9a-f]{40,64}\s/
  );
  assert.doesNotMatch(
    await fsPromises.readFile(path.join(repo, '.git', 'config'), 'utf8'),
    /taskWorktree|\[winmux/i
  );

  git(repo, 'worktree', 'add', '-b', 'task/imported', importedPath, 'main');
  const imported = await service.attachWorktree({ repo, path: importedPath });
  assert.equal(imported.managed, false);
  assert.equal(imported.imported, true);
  assert.equal(imported.branch, 'task/imported');
  const fromLinked = await service.listWorktrees({ repo: importedPath });
  assert.equal(fromLinked.find(item => path.resolve(item.path) === path.resolve(repo)).primary, true);
  assert.equal(fromLinked.find(item => path.resolve(item.path) === path.resolve(importedPath)).primary, false);

  const removed = await service.removeWorktree({
    repo,
    path: managedPath,
    taskId: 'task-1'
  });
  assert.deepEqual(removed, {
    removed: true,
    branch: 'task/managed',
    branchPreserved: true,
    metadataCleared: true
  });
  await assert.rejects(fsPromises.access(managedPath));
  assert.match(
    git(repo, 'show-ref', '--verify', 'refs/heads/task/managed').trim(),
    /^[0-9a-f]{40,64}\s/
  );
  await fsPromises.access(path.join(importedPath, '.git'));
});

test('changed, untracked, ignored data and imported worktrees are preserved', async (t) => {
  const { root, repo } = await fixture(t);
  const service = createTaskGitService();
  const managedPath = path.join(root, 'managed');
  const importedPath = path.join(root, 'imported');
  const replacementPath = path.join(root, 'replacement');

  await service.createWorktree({
    repo,
    path: managedPath,
    branch: 'task/cleanup',
    base: 'main',
    taskId: 'cleanup-task'
  });

  await fsPromises.writeFile(path.join(managedPath, 'tracked.txt'), 'changed\n');
  await expectCode(service.removeWorktree({
    repo,
    path: managedPath,
    taskId: 'cleanup-task'
  }), 'WORKTREE_NOT_CLEAN');
  git(managedPath, 'restore', 'tracked.txt');

  await fsPromises.writeFile(path.join(managedPath, 'untracked.txt'), 'keep\n');
  await expectCode(service.removeWorktree({
    repo,
    path: managedPath,
    taskId: 'cleanup-task'
  }), 'WORKTREE_NOT_CLEAN');
  await fsPromises.rm(path.join(managedPath, 'untracked.txt'));

  await fsPromises.writeFile(path.join(managedPath, 'cache.ignored'), 'keep\n');
  await expectCode(service.removeWorktree({
    repo,
    path: managedPath,
    taskId: 'cleanup-task'
  }), 'WORKTREE_NOT_CLEAN');
  await fsPromises.rm(path.join(managedPath, 'cache.ignored'));

  git(repo, 'worktree', 'add', '-b', 'task/external', importedPath, 'main');
  await assert.rejects(
    service.removeWorktree({ repo, path: importedPath, taskId: 'cleanup-task' }),
    (error) => error instanceof TaskGitError
      && error.code === 'WORKTREE_OWNERSHIP_MISMATCH'
      && error.operation === 'removeWorktree'
  );
  await fsPromises.access(path.join(importedPath, '.git'));
  await fsPromises.access(managedPath);

  const missingTaskId = await service.attachWorktree({ repo, path: importedPath });
  assert.equal(missingTaskId.taskId, null);
  assert.equal(missingTaskId.managed, false);

  await service.createWorktree({
    repo,
    path: replacementPath,
    branch: 'task/replacement',
    base: 'main',
    taskId: 'replacement-task'
  });
  git(repo, 'worktree', 'remove', replacementPath);
  git(repo, 'worktree', 'add', replacementPath, 'task/replacement');
  await expectCode(service.removeWorktree({
    repo,
    path: replacementPath,
    taskId: 'replacement-task'
  }), 'WORKTREE_OWNERSHIP_MISMATCH');
  await fsPromises.access(path.join(replacementPath, '.git'));
});

test('real Git executor uses argument arrays for Windows and WSL', async () => {
  const calls = [];
  const executor = createGitExecutor({
    execFile(file, args, options, callback) {
      calls.push({ file, args, options });
      callback(null, 'ok\n', '');
    }
  });

  const windowsResult = await executor(['rev-parse', '--show-toplevel'], {
    cwd: 'C:\\project',
    environment: 'windows'
  });
  assert.equal(windowsResult.stdout, 'ok\n');
  assert.deepEqual(calls[0].args, ['-C', 'C:\\project', 'rev-parse', '--show-toplevel']);
  assert.equal(calls[0].file, 'git');
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');

  await executor(['worktree', 'list', '--porcelain', '-z'], {
    cwd: '/home/test/project with spaces',
    environment: 'wsl',
    distro: 'Ubuntu'
  });
  assert.equal(calls[1].file, 'wsl.exe');
  assert.deepEqual(calls[1].args, [
    '-d',
    'Ubuntu',
    '--exec',
    'git',
    '-C',
    '/home/test/project with spaces',
    'worktree',
    'list',
    '--porcelain',
    '-z'
  ]);
});

test('real WSL service creates and removes a managed disposable worktree when available', async (t) => {
  let distro;
  try {
    distro = execFileSync('wsl.exe', ['--list', '--quiet'], {
      encoding: 'utf16le',
      timeout: 10_000,
      windowsHide: true
    })
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find((value) => value && !value.toLowerCase().includes('docker'));
  } catch {
    t.skip('WSL is unavailable');
    return;
  }
  if (!distro) {
    t.skip('No WSL distribution is available');
    return;
  }

  const { root, repo } = await fixture(t);
  const wslRepo = `/mnt/${repo[0].toLowerCase()}/${repo.slice(3).replace(/\\/g, '/')}`;
  const wslTarget = path.posix.join(path.posix.dirname(wslRepo), 'wsl-managed');
  const service = createTaskGitService();

  const created = await service.createWorktree({
    repo: wslRepo,
    path: wslTarget,
    branch: 'task/wsl',
    base: 'main',
    taskId: 'wsl-task',
    environment: 'wsl',
    distro
  });
  assert.equal(created.managed, true);
  assert.equal(created.branch, 'task/wsl');

  const removed = await service.removeWorktree({
    repo: wslRepo,
    path: wslTarget,
    taskId: 'wsl-task',
    environment: 'wsl',
    distro
  });
  assert.equal(removed.removed, true);
  assert.equal(removed.branchPreserved, true);
});
