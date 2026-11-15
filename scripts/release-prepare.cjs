'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function versionForTag(tag, manifest, lock) {
  check(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag), 'Expected a stable vX.Y.Z tag.');
  const version = tag.slice(1);
  check(manifest.version === version && lock.version === version && lock.packages?.['']?.version === version,
    'Tag, package.json, and both package-lock.json versions must match.');
  return version;
}

function successfulCI(runs, commit) {
  const latest = runs.filter(run => run.head_sha === commit && run.head_branch === 'main' &&
    run.event === 'push' && run.path === '.github/workflows/ci.yml')
    .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
  check(latest?.status === 'completed' && latest.conclusion === 'success',
    'The latest ci.yml push run for this exact main commit must be completed and successful. Wait for CI, then rerun the release.');
  return latest;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function api(endpoint, paginate = false) {
  return JSON.parse(run('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), endpoint]));
}

function verify() {
  const { GITHUB_REF_TYPE: refType, GITHUB_REF_NAME: tag, GITHUB_REPOSITORY: repository } = process.env;
  check(refType === 'tag' && /^[\w.-]+\/[\w.-]+$/.test(repository || ''), 'Expected a GitHub repository tag event.');
  const version = versionForTag(tag, JSON.parse(fs.readFileSync('package.json', 'utf8')),
    JSON.parse(fs.readFileSync('package-lock.json', 'utf8')));
  const commit = run('git', ['rev-parse', 'HEAD']);
  check(run('git', ['rev-parse', `${tag}^{commit}`]) === commit, 'Checkout must match the tag commit.');
  // checkout fetch-depth: 0 supplies all branch histories, including origin/main.
  run('git', ['merge-base', '--is-ancestor', commit, 'refs/remotes/origin/main']);
  check(api(`repos/${repository}/commits/${tag}`).sha === commit, 'Remote tag has moved since checkout.');
  const runs = api(`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${commit}&event=push&branch=main&per_page=100`, true)
    .flatMap(page => page.workflow_runs);
  const ci = successfulCI(runs, commit);
  // Completed code review is a maintainer pre-merge gate, not a GitHub APPROVED event.
  const pulls = api(`repos/${repository}/commits/${commit}/pulls?per_page=100`, true).flat();
  const pull = pulls.find(candidate => candidate.merged_at && candidate.base?.ref === 'main' &&
    candidate.base?.repo?.full_name === repository && candidate.merge_commit_sha === commit);
  check(pull, 'Tag commit must be the merge commit of a PR into this repository main branch.');
  check(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required.');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ncommit=${commit}\npr=${pull.number}\n`);
  console.log(`Verified ${tag}: ${commit}, merged PR #${pull.number}, CI ${ci.html_url}`);
}

function changelogEntry(changelog, version) {
  const escaped = version.replace(/\./g, '\\.');
  const heading = new RegExp(`^## \\[?${escaped}\\]?(?:[ \\t][^\\r\\n]*)?\\r?\\n`, 'm');
  const match = heading.exec(changelog);
  check(match, `CHANGELOG.md must contain a section for ${version}.`);
  const body = changelog.slice(match.index + match[0].length).split(/^## /m)[0]
    .replace(/^### (?:Planned release assets|Release assets)[\s\S]*$/mi, '').trim();
  check(body, 'The versioned changelog entry must not be empty.');
  return body;
}

function bundle() {
  const tag = process.env.GITHUB_REF_NAME;
  const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const version = versionForTag(tag, manifest, JSON.parse(fs.readFileSync('package-lock.json', 'utf8')));
  const repository = process.env.GITHUB_REPOSITORY;
  const commit = run('git', ['rev-parse', 'HEAD']);
  const notes = changelogEntry(fs.readFileSync('CHANGELOG.md', 'utf8'), version);
  const output = 'release-assets';
  // Only stage the named deliverables, never an unpacked app or entire build folder.
  fs.mkdirSync(output, { recursive: false });
  const names = [`Winmux-Setup-${version}-x64.exe`, `Winmux-Portable-${version}-x64.exe`];
  const sums = names.map(name => {
    const source = path.join(manifest.build.directories.output, name);
    check(fs.lstatSync(source).isFile(), `Missing regular executable: ${name}`);
    const bytes = fs.readFileSync(source);
    check(bytes.length > 2 && bytes.subarray(0, 2).toString('ascii') === 'MZ', `Invalid Windows executable: ${name}`);
    fs.copyFileSync(source, path.join(output, name));
    return `${createHash('sha256').update(bytes).digest('hex')}  ${name}`;
  });
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
  const base = `https://github.com/${repository}`;
  fs.writeFileSync(path.join(output, 'release-notes.md'), [
    `# Winmux ${tag}`, '', 'Windows x64 desktop preview.', '', notes, '',
    '## Downloads', '',
    `- **Installer:** [${names[0]}](${base}/releases/download/${tag}/${names[0]})`,
    `- **Portable:** [${names[1]}](${base}/releases/download/${tag}/${names[1]})`,
    `- **Checksums:** [SHA256SUMS.txt](${base}/releases/download/${tag}/SHA256SUMS.txt)`, '',
    'Compare the downloaded executable with `Get-FileHash .\\Winmux-*.exe -Algorithm SHA256`.', '',
    '## Build provenance', '', `- Source: [${commit}](${base}/commit/${commit})`,
    `- Merged PR: [#${process.env.RELEASE_PR}](${base}/pull/${process.env.RELEASE_PR})`,
    `- Build and verification: ${base}/actions/runs/${process.env.GITHUB_RUN_ID}`, '',
    '## SHA-256', '', '```text', ...sums, '```', '',
  ].join('\n').replace(/\]\((?!https?:\/\/|#)([^)]+)\)/g, `](${base}/blob/${tag}/$1)`));
  console.log(`Prepared ${names.join(', ')}, SHA256SUMS.txt, and release-notes.md`);
}

if (require.main === module) {
  try {
    const command = process.argv[2];
    if (command === 'verify') verify();
    else if (command === 'bundle') bundle();
    else throw new Error('Usage: node scripts/release-prepare.cjs <verify|bundle>');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { versionForTag, successfulCI, changelogEntry };
