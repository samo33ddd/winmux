const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { Terminal } = require('@xterm/headless');

function loadLocalFileLinks() {
  const filename = path.resolve(__dirname, '../src/localFileLinks.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions:{ module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, esModuleInterop:true },
    fileName:filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(output, filename);
  return loaded.exports;
}

const { classifyTerminalLink, findLocalFileLinks, normalizeLocalFileLink, createLocalFileLinkProvider } = loadLocalFileLinks();

test('normalizes local file URLs and rejects remote or control-character paths', () => {
  assert.equal(normalizeLocalFileLink('file:///E:/shots/frame.png'), 'E:\\shots\\frame.png');
  assert.equal(normalizeLocalFileLink('file://localhost/E:/My%20Shots/frame.png:12:4'), 'E:\\My Shots\\frame.png');
  assert.equal(normalizeLocalFileLink('./screens/frame.png:8'), './screens/frame.png');
  assert.equal(normalizeLocalFileLink('image.png'), 'image.png');
  assert.equal(normalizeLocalFileLink('https://example.test/image.png'), null);
  assert.equal(normalizeLocalFileLink('file:///%5cserver/share/image.png'), null);
  assert.equal(normalizeLocalFileLink('/\\server/share/image.png'), null);
  assert.equal(normalizeLocalFileLink('file:///C:/bad%0aname.txt'), null);
});

test('routes OSC8 targets to external HTTP or bounded local file actions', () => {
  assert.deepEqual(classifyTerminalLink('https://example.test/path.png'), { kind:'external', value:'https://example.test/path.png' });
  assert.deepEqual(classifyTerminalLink('file:///E:/shots/frame.png'), { kind:'file', value:'E:\\shots\\frame.png' });
  assert.deepEqual(classifyTerminalLink('./frame.png:12'), { kind:'file', value:'./frame.png' });
  assert.equal(classifyTerminalLink('javascript:alert(1)'), null);
  assert.equal(classifyTerminalLink('data:text/plain,x'), null);
});

test('finds common local path forms without treating HTTP paths as files', () => {
  const line = 'Open C:\\shots\\photo.png:12, ./out/frame.png, "C:\\My Shots\\wide shot.jpg", image.png and https://example.test/image.png';
  const links = findLocalFileLinks(line);
  assert.deepEqual(links.map(item => item.path), [
    'C:\\shots\\photo.png',
    './out/frame.png',
    'C:\\My Shots\\wide shot.jpg',
    'image.png',
  ]);
  assert.equal(links.some(item => item.path.includes('example.test')), false);
  for (const link of links) assert.equal(line.slice(link.start, link.end), link.text);
});

test('matches localhost file URIs as one whole link and protects remote URI suffixes', () => {
  const local = findLocalFileLinks('image: file://localhost/E:/Shots/frame.png:9');
  assert.equal(local.length, 1);
  assert.equal(local[0].text, 'file://localhost/E:/Shots/frame.png:9');
  assert.equal(local[0].path, 'E:\\Shots\\frame.png');
  const remote = findLocalFileLinks('image: file://server/share/frame.png');
  assert.equal(remote.length, 0);
});

test('provider ranges span wrapped rows and activation passes the full path', async () => {
  const terminal = new Terminal({ cols:20, rows:6, allowProposedApi:true });
  await new Promise(resolve => terminal.write(`${'前'.repeat(25)} C:\\shots\\photo.png`, resolve));
  let opened = '';
  const provider = createLocalFileLinkProvider(terminal, value => { opened = value; });
  const links = await new Promise(resolve => provider.provideLinks(3, resolve));
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].range.start, { x:12, y:3 });
  assert.equal(links[0].range.end.y, 4);
  // Plain click must not open; only Ctrl+left-click activates the link.
  links[0].activate(Object.assign(new Event('click'), { ctrlKey:false, button:0 }), links[0].text);
  assert.equal(opened, '');
  links[0].activate(Object.assign(new Event('click'), { ctrlKey:true, button:2 }), links[0].text);
  assert.equal(opened, '');
  links[0].activate(Object.assign(new Event('click'), { ctrlKey:true, button:0 }), links[0].text);
  assert.equal(opened, 'C:\\shots\\photo.png');
  terminal.dispose();
});

test('provider maps surrogate and combining characters before and inside a path', async () => {
  const terminal = new Terminal({ cols:20, rows:4, allowProposedApi:true });
  const expected = 'C:\\shots\\photo🚀.png';
  await new Promise(resolve => terminal.write(`🚀e\u0301 ${expected}`, resolve));
  let opened = '';
  const provider = createLocalFileLinkProvider(terminal, value => { opened = value; });
  const links = await new Promise(resolve => provider.provideLinks(1, resolve));
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].range.start, { x:4, y:1 });
  links[0].activate(Object.assign(new Event('click'), { ctrlKey:false, button:0 }), links[0].text);
  assert.equal(opened, '');
  links[0].activate(Object.assign(new Event('click'), { ctrlKey:true, button:0 }), links[0].text);
  terminal.dispose();
});
