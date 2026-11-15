'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const workflowPath = path.resolve(__dirname, '../.github/workflows/release.yml');

function extractRunScript(yaml, stepName) {
  const lines = yaml.replace(/\r\n/g, '\n').split('\n');
  const stepIndex = lines.findIndex(line => line.trim() === `- name: ${stepName}`);
  assert.notEqual(stepIndex, -1, `missing workflow step: ${stepName}`);
  let runIndex = -1;
  for (let index = stepIndex + 1; index < lines.length; index += 1) {
    if (/^\s+- /.test(lines[index])) break;
    if (/^\s+run:\s*\|$/.test(lines[index])) {
      runIndex = index;
      break;
    }
  }
  assert.notEqual(runIndex, -1, `missing run block for: ${stepName}`);
  const runIndent = lines[runIndex].match(/^\s*/)[0].length;
  const script = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = line.match(/^\s*/)[0].length;
    if (line.trim() && indent <= runIndent) break;
    script.push(line.trim() ? line.slice(runIndent + 2) : '');
  }
  return `${script.join('\n')}\n`;
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function createFixture(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-release-test-'));
  const assetsRoot = path.join(root, 'release-assets');
  const binRoot = path.join(root, 'bin');
  fs.mkdirSync(assetsRoot);
  fs.mkdirSync(binRoot);

  const setup = 'Winmux-Setup-1.2.3-x64.exe';
  const portable = 'Winmux-Portable-1.2.3-x64.exe';
  fs.writeFileSync(path.join(assetsRoot, setup), 'setup executable fixture');
  fs.writeFileSync(path.join(assetsRoot, portable), 'portable executable fixture');
  fs.writeFileSync(
    path.join(assetsRoot, 'SHA256SUMS.txt'),
    `${sha256(path.join(assetsRoot, setup))}  ${setup}\n${sha256(path.join(assetsRoot, portable))}  ${portable}\n`,
  );
  fs.writeFileSync(path.join(assetsRoot, 'release-notes.md'), 'Regression fixture release.\n');

  const scriptPath = path.join(root, 'publish.ps1');
  const yaml = fs.readFileSync(workflowPath, 'utf8');
  fs.writeFileSync(scriptPath, extractRunScript(yaml, 'Verify assets, upload to draft, and publish'));

  const statePath = path.join(root, 'gh-state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    created: scenario === 'existing-draft',
    existingDraft: scenario === 'existing-draft',
    published: false,
  }));
  const callsPath = path.join(root, 'gh-calls.jsonl');
  fs.writeFileSync(callsPath, '');

  const driverPath = path.join(binRoot, 'gh-fake.cjs');
  fs.writeFileSync(driverPath, String.raw`
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(args) + '\n');
const statePath = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const tag = 'v1.2.3';
const releaseId = 123456789;
const assetsRoot = path.join(process.env.GITHUB_WORKSPACE, 'release-assets');
const assetNames = [
  'Winmux-Setup-1.2.3-x64.exe',
  'Winmux-Portable-1.2.3-x64.exe',
  'SHA256SUMS.txt',
];
function release(draft) {
  const assets = assetNames.map((name, index) => {
    const filename = path.join(assetsRoot, name);
    return {
      name: process.env.FAKE_SCENARIO === 'malformed-assets' && index === 0 ? 'unexpected.exe' : name,
      state: 'uploaded',
      size: fs.statSync(filename).size,
      digest: 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
    };
  });
  return {
    id: releaseId,
    tag_name: process.env.FAKE_SCENARIO === 'tag-mismatch' && draft ? 'v9.9.9' : tag,
    draft,
    assets,
    html_url: 'https://example.test/releases/' + tag,
  };
}
function fail(message) {
  console.error(message);
  process.exit(12);
}
if (args[0] === 'api') {
  const endpoint = args[args.length - 1];
  if (endpoint.endsWith('/commits/' + tag)) {
    console.log(JSON.stringify({ sha: process.env.RELEASE_COMMIT }));
  } else if (endpoint.includes('/releases?per_page=100')) {
    const releases = state.existingDraft || state.created ? [release(true)] : [];
    console.log(JSON.stringify([releases]));
  } else if (endpoint.endsWith('/releases/' + releaseId)) {
    console.log(JSON.stringify(release(true)));
  } else if (endpoint.endsWith('/releases/tags/' + tag)) {
    if (!state.published) fail('published endpoint requested before release edit');
    console.log(JSON.stringify(release(false)));
  } else {
    fail('unexpected api endpoint: ' + endpoint);
  }
} else if (args[0] === 'release' && args[1] === 'create') {
  state.created = true;
  save();
} else if (args[0] === 'release' && args[1] === 'upload') {
  state.uploaded = true;
  save();
} else if (args[0] === 'release' && args[1] === 'edit') {
  if (!state.uploaded) fail('release edit requested before upload');
  state.published = true;
  save();
} else {
  fail('unexpected gh command: ' + args.join(' '));
}
`);
  fs.writeFileSync(path.join(binRoot, 'gh.cmd'), '@echo off\r\nnode "%~dp0gh-fake.cjs" %*\r\n');

  return {
    root,
    assetsRoot,
    scriptPath,
    callsPath,
    statePath,
    env: {
      ...process.env,
      PATH: `${binRoot}${path.delimiter}${process.env.PATH || ''}`,
      GITHUB_WORKSPACE: root,
      GITHUB_STEP_SUMMARY: path.join(root, 'summary.md'),
      GH_TOKEN: 'fake-token',
      GH_REPO: 'example/winmux',
      RELEASE_TAG: 'v1.2.3',
      RELEASE_VERSION: '1.2.3',
      RELEASE_COMMIT: '0123456789abcdef0123456789abcdef01234567',
      FAKE_SCENARIO: scenario,
      FAKE_GH_CALLS: callsPath,
      FAKE_GH_STATE: statePath,
    },
  };
}

function runPublisher(scenario) {
  const fixture = createFixture(scenario);
  try {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', fixture.scriptPath], {
      cwd: fixture.root,
      encoding: 'utf8',
      env: fixture.env,
    });
    const state = JSON.parse(fs.readFileSync(fixture.statePath, 'utf8'));
    const calls = fs.readFileSync(fixture.callsPath, 'utf8')
      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { result, state, calls };
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('downloads the artifact ID into the release-assets root', () => {
  const yaml = fs.readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
  const download = yaml.match(/- uses: actions\/download-artifact@v4\n([\s\S]*?)(?=\n\s+- name:)/);
  assert.ok(download, 'missing actions/download-artifact step');
  assert.match(download[1], /artifact-ids: \$\{\{ needs\.build\.outputs\.artifact-id \}\}/);
  assert.match(download[1], /path: release-assets/);
  assert.match(download[1], /merge-multiple: true/);
});

for (const scenario of ['new-draft', 'existing-draft']) {
  test(`publishes through a draft release ID (${scenario})`, () => {
    const { result, calls, state } = runPublisher(scenario);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(state.published, true);
    const draftIndex = calls.findIndex(args => args.join(' ').endsWith('/releases/123456789'));
    const editIndex = calls.findIndex(args => args[0] === 'release' && args[1] === 'edit');
    const taggedIndex = calls.findIndex(args => args.join(' ').endsWith('/releases/tags/v1.2.3'));
    assert.ok(draftIndex !== -1 && draftIndex < editIndex && editIndex < taggedIndex);
    assert.equal(calls.filter(args => args[0] === 'release' && args[1] === 'create').length, scenario === 'new-draft' ? 1 : 0);
  });
}

for (const scenario of ['malformed-assets', 'tag-mismatch']) {
  test(`rejects a malformed draft before publishing (${scenario})`, () => {
    const { result, calls, state } = runPublisher(scenario);
    assert.notEqual(result.status, 0, 'publisher unexpectedly accepted malformed draft');
    assert.doesNotMatch(result.stderr, /Unexpected api endpoint|published endpoint requested/);
    assert.equal(state.published, false);
    assert.equal(calls.some(args => args[0] === 'release' && args[1] === 'edit'), false);
  });
}
