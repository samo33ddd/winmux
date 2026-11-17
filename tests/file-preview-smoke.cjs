const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { readFilePreview, previewMetadata, validateInput } = require('../electron/file-preview.cjs');

const root = path.resolve(__dirname, '..', '.artifacts');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

function fixtureClient(cwd, profile, dataDir = path.join(cwd, '.winmux-data')) {
  const workspace = { id:'workspace', cwd, profileId:profile.id, panes:[{ id:'pane', cwd, profileId:profile.id }] };
  const client = {
    environmentCalls:0,
    request:async method => {
      if (method === 'state') return { workspaces:[workspace], settings:{ activeWorkspaceId:workspace.id } };
      client.environmentCalls++;
      if (method === 'environment') return { profiles:[profile] };
      throw new Error(`Unexpected method ${method}`);
    },
  };
  client.dataDir = dataDir;
  return client;
}

async function windowsChecks(fixture) {
  const profile = { id:'powershell', environment:'windows' };
  const client = fixtureClient(fixture, profile);
  const textPath = path.join(fixture, 'nested', 'hello world.txt');
  await fs.mkdir(path.dirname(textPath), { recursive:true });
  await fs.writeFile(textPath, 'Hello Winmux\nПривет');
  await fs.writeFile(path.join(fixture, 'pixel.png'), png);
  await fs.writeFile(path.join(fixture, 'binary.bin'), Buffer.from([1, 0, 2, 3]));
  const oversized = path.join(fixture, 'oversized.png');
  await fs.writeFile(oversized, png);
  await fs.truncate(oversized, 12 * 1024 * 1024 + 1);
  // The selected instance's private data directory is denied for every caller.
  const dataDir = path.join(fixture, 'private-data');
  await fs.mkdir(path.join(dataDir, 'hooks', 'session'), { recursive:true });
  await fs.writeFile(path.join(dataDir, 'ipc-token'), 'WINMUX_SENTINEL_TOKEN');
  await fs.writeFile(path.join(dataDir, 'ui-control.json'), '{"token":"WINMUX_SENTINEL_UI"}');
  await fs.writeFile(path.join(dataDir, 'hooks', 'session', 'hook.json'), 'WINMUX_SENTINEL_HOOK');
  const privateClient = { client, dataDir };
  for (const target of [
    path.join(dataDir, 'ipc-token'),
    path.join(dataDir, 'ui-control.json'),
    path.join(dataDir, 'hooks', 'session', 'hook.json'),
    pathToFileURL(path.join(dataDir, 'ipc-token')).href,
    path.join(dataDir, 'IPC-TOKEN').toUpperCase().endsWith('IPC-TOKEN') ? path.join(dataDir, 'ipc-token').toUpperCase() : '',
  ]) {
    const error = await readFilePreview({ ...privateClient, paneId:'pane', path:target }).then(() => null).catch(candidate => candidate);
    assert(error, `Private preview was not rejected: ${target}`);
    assert.equal(error.code, 'INVALID_FILE_PATH', `Unexpected code for ${target}: ${error.message}`);
    assert.match(error.message, /private data/i);
    assert(!error.message.includes('SENTINEL'), 'Rejection must not include contents');
  }
  // A junction alias of the data directory must not bypass the guard.
  const junction = path.join(fixture, 'data-alias');
  try { await fs.symlink(dataDir, junction, 'junction'); } catch (error) { if (error.code !== 'EPERM') throw error; }
  if (await fs.stat(junction).then(() => true).catch(() => false)) {
    await assert.rejects(
      () => readFilePreview({ ...privateClient, paneId:'pane', path:path.join(junction, 'ipc-token') }),
      error => error.code === 'INVALID_FILE_PATH',
      'Junction alias to the data directory must be rejected',
    );
  }
  // 8.3 short-name aliases must not bypass the guard either.
  try {
    const shortName = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${path.join(dataDir, 'ipc-token')}") do @echo %~sI`], { windowsHide:true, timeout:10000 }).toString().trim();
    if (/~/.test(shortName)) {
      await assert.rejects(
        () => readFilePreview({ ...privateClient, paneId:'pane', path:shortName }),
        error => error.code === 'INVALID_FILE_PATH',
        `8.3 alias ${shortName} must be rejected`,
      );
    }
  } catch {}
  // A sibling directory sharing the private prefix is ordinary data, not denied.
  const sibling = path.join(fixture, 'private-data-extra');
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(sibling, 'note.txt'), 'ordinary file');
  assert.equal((await readFilePreview({ ...privateClient, paneId:'pane', path:path.join(sibling, 'note.txt') })).text, 'ordinary file');
  // Missing dataDir input is a programming error, not a silent bypass.
  await assert.rejects(() => readFilePreview({ client, paneId:'pane', path:textPath }), /data directory/);

  const relative = await readFilePreview({ client, dataDir:client.dataDir, paneId:'pane', path:'nested/hello world.txt' });
  assert.equal(relative.kind, 'text');
  assert.equal(relative.text, 'Hello Winmux\nПривет');
  const absolute = await readFilePreview({ client, dataDir:client.dataDir, paneId:'pane', path:textPath });
  assert.equal(absolute.path, await fs.realpath(textPath));
  const fileUri = await readFilePreview({ client, dataDir:client.dataDir, paneId:'pane', path:pathToFileURL(textPath).href });
  assert.equal(fileUri.kind, 'text');
  const image = await readFilePreview({ client, dataDir:client.dataDir, paneId:'pane', path:'pixel.png' });
  assert.equal(image.kind, 'image');
  assert(image.dataUrl.startsWith('data:image/png;base64,'));
  const binary = await readFilePreview({ client, dataDir:client.dataDir, paneId:'pane', path:'binary.bin' });
  assert.deepEqual([binary.kind, binary.size], ['binary', 4]);
  assert.equal((await readFilePreview({ client, dataDir:client.dataDir, path:'nested/hello world.txt', paneId:'pane' })).workspaceId, 'workspace');
  const metadata = previewMetadata(image);
  assert.equal('dataUrl' in metadata, false);
  assert.equal('text' in metadata, false);

  await assert.rejects(() => readFilePreview({ client, dataDir:client.dataDir, paneId:'pane', path:'missing.png' }), /File not found/);
  await assert.rejects(() => readFilePreview({ client, dataDir:client.dataDir, paneId:'pane', path:'nested' }), /not a directory/);
  await assert.rejects(() => readFilePreview({ client, dataDir:client.dataDir, paneId:'pane', path:oversized }), /12 MB/);
  await assert.rejects(() => readFilePreview({ client, dataDir:client.dataDir, paneId:'missing', path:'hello world.txt' }), /pane is closed/);
  await assert.rejects(() => readFilePreview({ client, dataDir:client.dataDir, workspaceId:'unknown', path:'hello world.txt' }), /Workspace is closed/);
  assert.equal(client.environmentCalls, 16, 'Explicit closed workspace and pane errors must happen before environment or file access');
}

function validations() {
  for (const value of ['javascript:alert(1)', 'data:text/plain,x', 'http://example.test/x', 'https://example.test/x', 'file://server/share/x.png', 'file:///%5cserver/share/x.png', '/\\server/share/x.png', 'C:\\bad\nname.txt', 'file:///C:/bad%0aname.txt']) {
    assert.throws(() => validateInput(value), /local|UNC|control|File URL/i, value);
  }
  assert.equal(validateInput('file:///E:/shots/image.png').input, 'E:\\shots\\image.png');
  assert.equal(validateInput('file://localhost/E:/shots/image.png').absolute, true);
}

async function wslChecks(fixture) {
  let distro;
  try {
    distro = execFileSync('wsl.exe', ['--list', '--quiet'], { timeout:10000, windowsHide:true })
      .toString('utf16le').replace(/\u0000/g, '').split(/\r?\n/).map(value => value.trim()).find(Boolean);
  } catch {
    return 'WSL unavailable; skipped';
  }
  if (!distro) return 'WSL unavailable; skipped';
  const unused = path.join(fixture, 'unused-data'); await fs.mkdir(unused, { recursive:true }); const linux = `/mnt/${fixture[0].toLowerCase()}${fixture.slice(2).replace(/\\/g, '/')}`;
  const profile = { id:`wsl:${distro}`, environment:'wsl', distro };
  const client = fixtureClient(linux, profile);
  const text = await readFilePreview({ ...client, client, dataDir:unused, paneId:'pane', path:'nested/hello world.txt' });
  // WSL panes see the Windows data directory through /mnt/<drive>; the same
  // private files must be rejected before contents are returned.
  const privateData = path.join(fixture, 'private-data');
  await fs.mkdir(privateData, { recursive:true });
  await fs.writeFile(path.join(privateData, 'ipc-token'), 'WINMUX_SENTINEL_TOKEN');
  const wslPrivate = `/mnt/${privateData[0].toLowerCase()}${privateData.slice(2).replace(/\\/g, '/')}`;
  const wslClient = { client, dataDir:privateData };
  for (const target of [`${wslPrivate}/ipc-token`, privateData, privateData.replace(/\\/g, '/')]) {
    const error = await readFilePreview({ ...wslClient, paneId:'pane', path:target }).then(() => null).catch(candidate => candidate);
    assert(error, `WSL private preview was not rejected: ${target}`);
    assert.match(error.message, /private data/i, `Unexpected WSL rejection for ${target}: ${error.message}`);
  }
  const control = await readFilePreview({ ...wslClient, paneId:'pane', path:'nested/hello world.txt' });
  assert.equal(control.text, 'Hello Winmux\nПривет');
  assert.equal(text.text, 'Hello Winmux\nПривет');
  const image = await readFilePreview({ ...client, client, dataDir:unused, paneId:'pane', path:'pixel.png' });
  assert(image.dataUrl.startsWith('data:image/png;base64,'));
  return `WSL ${distro}: relative text and image verified`;
}

(async () => {
  await fs.mkdir(root, { recursive:true });
  const fixture = await fs.mkdtemp(path.join(root, 'file-preview-smoke-'));
  try {
    validations();
    await windowsChecks(fixture);
    const wsl = await wslChecks(fixture);
    console.log(JSON.stringify({
      status:'passed',
      results:[
        'bounded text, image, binary, relative, absolute and file URI reads passed',
        'missing files, directories, oversized images and unsafe paths rejected',
        'pipe metadata excludes preview payload bytes',
        wsl,
      ],
    }, null, 2));
  } finally {
    await fs.rm(fixture, { recursive:true, force:true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
