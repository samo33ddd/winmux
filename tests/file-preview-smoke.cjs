const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { readFilePreview, previewMetadata, validateInput } = require('../electron/file-preview.cjs');

const root = path.resolve(__dirname, '..', '.artifacts');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

function fixtureClient(cwd, profile) {
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

  const relative = await readFilePreview({ client, paneId:'pane', path:'nested/hello world.txt' });
  assert.equal(relative.kind, 'text');
  assert.equal(relative.text, 'Hello Winmux\nПривет');
  const absolute = await readFilePreview({ client, paneId:'pane', path:textPath });
  assert.equal(absolute.path, await fs.realpath(textPath));
  const fileUri = await readFilePreview({ client, paneId:'pane', path:pathToFileURL(textPath).href });
  assert.equal(fileUri.kind, 'text');
  const image = await readFilePreview({ client, paneId:'pane', path:'pixel.png' });
  assert.equal(image.kind, 'image');
  assert(image.dataUrl.startsWith('data:image/png;base64,'));
  const binary = await readFilePreview({ client, paneId:'pane', path:'binary.bin' });
  assert.deepEqual([binary.kind, binary.size], ['binary', 4]);
  assert.equal((await readFilePreview({ client, path:'nested/hello world.txt', paneId:'pane' })).workspaceId, 'workspace');
  const metadata = previewMetadata(image);
  assert.equal('dataUrl' in metadata, false);
  assert.equal('text' in metadata, false);

  await assert.rejects(() => readFilePreview({ client, paneId:'pane', path:'missing.png' }), /File not found/);
  await assert.rejects(() => readFilePreview({ client, paneId:'pane', path:'nested' }), /not a directory/);
  await assert.rejects(() => readFilePreview({ client, paneId:'pane', path:oversized }), /12 MB/);
  await assert.rejects(() => readFilePreview({ client, paneId:'missing', path:'hello world.txt' }), /pane is closed/);
  await assert.rejects(() => readFilePreview({ client, workspaceId:'unknown', path:'hello world.txt' }), /Workspace is closed/);
  assert.equal(client.environmentCalls, 9, 'Explicit closed workspace and pane errors must happen before environment or file access');
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
  const linux = `/mnt/${fixture[0].toLowerCase()}${fixture.slice(2).replace(/\\/g, '/')}`;
  const profile = { id:`wsl:${distro}`, environment:'wsl', distro };
  const client = fixtureClient(linux, profile);
  const text = await readFilePreview({ client, paneId:'pane', path:'nested/hello world.txt' });
  assert.equal(text.text, 'Hello Winmux\nПривет');
  const image = await readFilePreview({ client, paneId:'pane', path:'pixel.png' });
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
