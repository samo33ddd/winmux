'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const SKILL_NAMES = Object.freeze(['winmux-terminal', 'winmux-browser']);
const SKILL_CONNECTION = 'scripts/connection.json';
const RUNTIME_FILES = Object.freeze([
  'cli.cjs',
  'electron/automation-client.cjs',
  'electron/client.cjs',
  'electron/backend/shared.cjs',
  'scripts/browser.cjs',
]);
// Project roots match skills CLI 1.8.1 docs/agents.md, checked 2026-11-15.
const SKILL_DESTINATIONS = Object.freeze({
  'codex': '.agents/skills',
  'claude-code': '.claude/skills',
  'opencode': '.agents/skills',
  'cursor': '.agents/skills',
  'gemini-cli': '.agents/skills',
  'github-copilot': '.agents/skills',
  'pi': '.agents/skills',
  'hermes-agent': '.hermes/skills',
});

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function normalizedRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) return null;
  const normalized = path.posix.normalize(value);
  return normalized !== '.' && !normalized.startsWith('../') && normalized !== '..'
    && !path.posix.isAbsolute(normalized) ? normalized : null;
}

function collectBundledTree(root) {
  const files = [];
  let total = 0;
  function visit(directory, relative = '') {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('BUNDLED_SKILL_UNAVAILABLE', `Bundled skill path is not a regular directory: ${directory}`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const item = path.join(directory, entry.name);
      const itemRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const itemStat = fs.lstatSync(item);
      if (itemStat.isSymbolicLink()) fail('BUNDLED_SKILL_UNAVAILABLE', `Bundled skill contains a symlink: ${itemRelative}`);
      if (itemStat.isDirectory()) {
        visit(item, itemRelative);
        continue;
      }
      if (!itemStat.isFile() || itemStat.size > 1024 * 1024) fail('BUNDLED_SKILL_UNAVAILABLE', `Bundled skill contains an unsafe file: ${itemRelative}`);
      total += itemStat.size;
      if (total > 4 * 1024 * 1024) fail('BUNDLED_SKILL_UNAVAILABLE', 'Bundled skills exceed the installation size limit.');
      files.push({
        relative: itemRelative,
        content: fs.readFileSync(item),
        mode: itemStat.mode & 0o777,
      });
    }
  }
  visit(root);
  return files;
}

function readBundledSkills(skillsRoot = path.join(__dirname, '..', 'skills')) {
  return SKILL_NAMES.map(name => {
    let files;
    try {
      files = collectBundledTree(path.join(skillsRoot, name));
    } catch (error) {
      if (error.code === 'BUNDLED_SKILL_UNAVAILABLE') throw error;
      fail('BUNDLED_SKILL_UNAVAILABLE', `Bundled ${name} is unavailable: ${error.message}`);
    }
    const skillFile = files.find(file => file.relative === 'SKILL.md');
    if (!skillFile) fail('BUNDLED_SKILL_UNAVAILABLE', `Bundled ${name}/SKILL.md is unavailable.`);
    const header = skillFile.content.toString('utf8', 0, Math.min(skillFile.content.length, 512));
    if (!new RegExp(`^---\\r?\\nname:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:\\r?\\n|$)`).test(header)) {
      fail('BUNDLED_SKILL_INVALID', `Bundled ${name}/SKILL.md does not declare the expected name.`);
    }
    return { name, content: skillFile.content, files };
  });
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function runtimePlan({ dataDir, appRoot = path.join(__dirname, '..') }) {
  const resolvedDataDir = path.resolve(dataDir);
  const files = RUNTIME_FILES.map(relative => {
    const source = path.join(appRoot, ...relative.split('/'));
    let content;
    try {
      content = fs.readFileSync(source);
    } catch (error) {
      fail('CLIENT_RUNTIME_UNAVAILABLE', `Packaged Winmux client file is unavailable: ${relative}: ${error.message}`);
    }
    if (!content.length || content.length > 2 * 1024 * 1024) fail('CLIENT_RUNTIME_INVALID', `Packaged Winmux client file is invalid: ${relative}`);
    return { relative, content, mode: 0o644 };
  });
  const digest = crypto.createHash('sha256');
  for (const file of files) digest.update(file.relative).update('\0').update(file.content).update('\0');
  const version = digest.digest('hex').slice(0, 16);
  const runtimeRoot = path.join(resolvedDataDir, 'tools', 'winmux-client', version);
  return {
    dataDir: resolvedDataDir,
    runtimeRoot,
    cliPath: path.join(runtimeRoot, 'cli.cjs'),
    version,
    files,
  };
}

function compareTree(target, expectedFiles, code, label) {
  const rootStat = fs.lstatSync(target);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(code, `${label} is not a regular directory: ${target}`);
  const expected = new Map(expectedFiles.map(file => [file.relative, file]));
  const actual = new Map();
  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      const itemRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(item);
      if (stat.isSymbolicLink()) fail(code, `${label} contains a symlink: ${itemRelative}`);
      if (stat.isDirectory()) visit(item, itemRelative);
      else if (stat.isFile()) actual.set(itemRelative, fs.readFileSync(item));
      else fail(code, `${label} contains an unsupported file: ${itemRelative}`);
    }
  }
  visit(target);
  if (actual.size !== expected.size) fail(code, `${label} contains missing or extra files: ${target}`);
  for (const [relative, file] of expected) {
    const content = actual.get(relative);
    if (!content || !content.equals(file.content)) fail(code, `${label} differs at ${relative}: ${target}`);
  }
}

function writeTree(root, files) {
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  for (const file of files) {
    const relative = normalizedRelative(file.relative);
    if (!relative) fail('BUNDLED_SKILL_INVALID', `Unsafe bundled file path: ${file.relative}`);
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, file.content, { flag: 'wx', mode: file.mode || 0o644 });
  }
}

function ensureRuntime(plan) {
  fs.mkdirSync(plan.dataDir, { recursive: true, mode: 0o700 });
  const dataRoot = fs.realpathSync(plan.dataDir);
  for (const relative of ['tools', path.join('tools', 'winmux-client')]) {
    const current = path.join(dataRoot, relative);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_RUNTIME', `Winmux runtime directory is unsafe: ${current}`);
      if (!isWithin(dataRoot, fs.realpathSync(current))) fail('UNSAFE_RUNTIME', `Winmux runtime directory resolves outside the data directory: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      break;
    }
  }
  if (fs.existsSync(plan.runtimeRoot)) {
    compareTree(plan.runtimeRoot, plan.files, 'CLIENT_RUNTIME_CONFLICT', 'Existing Winmux client runtime');
    return plan;
  }

  const parent = path.dirname(plan.runtimeRoot);
  fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  const stage = path.join(parent, `.${plan.version}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    writeTree(stage, plan.files);
    try {
      fs.renameSync(stage, plan.runtimeRoot);
    } catch (error) {
      if (!fs.existsSync(plan.runtimeRoot)) throw error;
      compareTree(plan.runtimeRoot, plan.files, 'CLIENT_RUNTIME_CONFLICT', 'Concurrent Winmux client runtime');
      fs.rmSync(stage, { recursive: true, force: true });
    }
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return plan;
}

function materializeSkills(skills, plan) {
  const connection = Buffer.from(`${JSON.stringify({ dataDir: plan.dataDir, cliPath: plan.cliPath }, null, 2)}\n`);
  return skills.map(skill => ({
    name: skill.name,
    files: [
      ...skill.files.filter(file => file.relative !== SKILL_CONNECTION),
      { relative: SKILL_CONNECTION, content: connection, mode: 0o600 },
    ],
  }));
}

function assertSafeWindowsDestination(cwd, destinationRoot) {
  const root = fs.realpathSync(cwd);
  const destination = path.resolve(root, destinationRoot);
  if (!isWithin(root, destination)) fail('UNSAFE_DESTINATION', 'Skill destination is outside the selected project.');
  let current = root;
  for (const segment of destinationRoot.split('/')) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) fail('UNSAFE_DESTINATION', 'Skill destination contains a symlink inside the selected project.');
      const resolved = fs.realpathSync(current);
      if (!isWithin(root, resolved)) fail('UNSAFE_DESTINATION', 'Skill destination resolves outside the selected project.');
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return { root, destination };
}

function inspectWindowsTarget(target, skill) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return { name: skill.name, status: 'install', target, files: skill.files };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('SKILL_CONFLICT', `${skill.name} already exists at ${target} and is not a regular skill directory.`);
  }
  compareTree(target, skill.files, 'SKILL_CONFLICT', `${skill.name} existing skill`);
  return { name: skill.name, status: 'unchanged', target, files: skill.files };
}

function cleanupEmptyParents(start, root) {
  let current = start;
  while (current !== root && isWithin(root, current)) {
    try {
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function installWindowsSkills({ cwd, agent, skills, runtime }) {
  const plan = ensureRuntime(runtime);
  const materialized = materializeSkills(skills, plan);
  const destinationRoot = SKILL_DESTINATIONS[agent];
  const { root, destination } = assertSafeWindowsDestination(cwd, destinationRoot);
  const inspected = materialized.map(skill => inspectWindowsTarget(path.join(destination, skill.name), skill));
  const pending = inspected.filter(item => item.status === 'install');
  const installed = [];
  const staged = new Map();
  try {
    if (pending.length) fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
    for (const item of pending) {
      const temporary = path.join(destination, `.${item.name}.winmux-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
      staged.set(item.name, temporary);
      writeTree(temporary, item.files);
    }
    for (const item of pending) {
      const temporary = staged.get(item.name);
      fs.renameSync(temporary, item.target);
      installed.push(item.target);
    }
  } catch (error) {
    for (const temporary of staged.values()) {
      try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {}
    }
    for (const target of installed) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
    }
    cleanupEmptyParents(destination, root);
    throw error;
  }
  return {
    environment: 'windows',
    agent,
    destinationRoot: destination,
    runtimeRoot: plan.runtimeRoot,
    skills: inspected.map(item => ({ name: item.name, status: item.status, path: item.target })),
  };
}

const WSL_INSTALLER = String.raw`
import base64, json, os, secrets, shutil, sys

def fail(code, message):
    print(json.dumps({"error": {"code": code, "message": message}}))
    raise SystemExit(1)

def relative_file(value):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        fail("BUNDLED_SKILL_INVALID", "Unsafe bundled skill file path.")
    normalized = os.path.normpath(value).replace(os.sep, "/")
    if normalized in (".", "..") or normalized.startswith("../") or os.path.isabs(normalized):
        fail("BUNDLED_SKILL_INVALID", "Unsafe bundled skill file path.")
    return normalized

def expected_tree(skill):
    files = {}
    directories = set()
    for item in skill["files"]:
        relative = relative_file(item.get("relative"))
        if relative in files:
            fail("BUNDLED_SKILL_INVALID", "Duplicate bundled skill file.")
        files[relative] = base64.b64decode(item.get("content", ""), validate=True)
        parent = os.path.dirname(relative)
        while parent:
            directories.add(parent)
            parent = os.path.dirname(parent)
    if "SKILL.md" not in files:
        fail("BUNDLED_SKILL_INVALID", "Bundled skill is missing SKILL.md.")
    return files, directories

def inspect_tree(target, files, directories, name):
    if not os.path.lexists(target):
        return False
    if os.path.islink(target) or not os.path.isdir(target):
        fail("SKILL_CONFLICT", f"{name} already exists and is not a regular skill directory.")
    actual_files = {}
    actual_directories = set()
    for current, dirnames, filenames in os.walk(target, followlinks=False):
        for dirname in dirnames:
            item = os.path.join(current, dirname)
            relative = os.path.relpath(item, target).replace(os.sep, "/")
            if os.path.islink(item):
                fail("SKILL_CONFLICT", f"{name} contains a symlink: {relative}")
            actual_directories.add(relative)
        for filename in filenames:
            item = os.path.join(current, filename)
            relative = os.path.relpath(item, target).replace(os.sep, "/")
            if os.path.islink(item) or not os.path.isfile(item):
                fail("SKILL_CONFLICT", f"{name} contains an unsupported file: {relative}")
            with open(item, "rb") as existing:
                actual_files[relative] = existing.read()
    if actual_directories != directories or set(actual_files) != set(files):
        fail("SKILL_CONFLICT", f"{name} has missing or extra files. No files were changed.")
    for relative, content in files.items():
        if actual_files[relative] != content:
            fail("SKILL_CONFLICT", f"{name} differs at {relative}. No files were changed.")
    return True

try:
    payload = json.loads(base64.b64decode(sys.stdin.buffer.read(), validate=True).decode("utf-8"))
    cwd = payload["cwd"]
    relative = payload["destinationRoot"]
    skills = payload["skills"]
    if not isinstance(cwd, str) or not cwd.startswith("/") or not os.path.isdir(cwd):
        fail("INVALID_CWD", "The WSL project directory is unavailable.")
    if relative not in (".agents/skills", ".claude/skills", ".hermes/skills"):
        fail("UNSAFE_DESTINATION", "Unsupported WSL skill destination.")
    root = os.path.realpath(cwd)
    current = root
    for segment in relative.split("/"):
        current = os.path.join(current, segment)
        if os.path.lexists(current):
            if os.path.islink(current):
                fail("UNSAFE_DESTINATION", "Skill destination contains a symlink inside the selected project.")
            resolved = os.path.realpath(current)
            if os.path.commonpath([root, resolved]) != root:
                fail("UNSAFE_DESTINATION", "Skill destination resolves outside the selected project.")
    destination = os.path.abspath(os.path.join(root, relative))
    inspected = []
    for skill in skills:
        name = skill["name"]
        files, directories = expected_tree(skill)
        target = os.path.join(destination, name)
        unchanged = inspect_tree(target, files, directories, name)
        inspected.append({"name": name, "status": "unchanged" if unchanged else "install", "path": target, "files": files, "directories": directories})
    pending = [item for item in inspected if item["status"] == "install"]
    if pending:
        os.makedirs(destination, exist_ok=True)
    staged = []
    installed = []
    try:
        for item in pending:
            temporary = os.path.join(destination, f".{item['name']}.winmux-{os.getpid()}-{secrets.token_hex(6)}")
            os.mkdir(temporary, 0o755)
            staged.append((temporary, item))
            for directory in sorted(item["directories"]):
                os.makedirs(os.path.join(temporary, directory), mode=0o755, exist_ok=True)
            for relative_file_name, content in item["files"].items():
                output_path = os.path.join(temporary, relative_file_name)
                os.makedirs(os.path.dirname(output_path), mode=0o755, exist_ok=True)
                with open(output_path, "xb") as output:
                    output.write(content)
        for temporary, item in staged:
            os.rename(temporary, item["path"])
            installed.append(item["path"])
        staged = []
    except Exception:
        for temporary, _ in staged:
            shutil.rmtree(temporary, ignore_errors=True)
        for target in installed:
            shutil.rmtree(target, ignore_errors=True)
        raise
    print(json.dumps({
        "environment": "wsl",
        "destinationRoot": destination,
        "skills": [{key: item[key] for key in ("name", "status", "path")} for item in inspected],
    }))
except SystemExit:
    raise
except Exception as error:
    fail(getattr(error, "code", "INSTALL_FAILED"), str(error))
`.trim();

function runWslInstaller(command, args, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args, '--exec', 'python3', '-c', WSL_INSTALLER], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-2 * 1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2 * 1024 * 1024); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(`WSL installer exited with ${code}`), { code: 'INSTALL_FAILED', stdout, stderr }));
    });
    child.stdin.end(payload);
  });
}

async function installWslSkills({ profile, cwd, agent, skills, runtime }) {
  const plan = ensureRuntime(runtime);
  const payload = Buffer.from(JSON.stringify({
    cwd,
    destinationRoot: SKILL_DESTINATIONS[agent],
    skills: materializeSkills(skills, plan).map(skill => ({
      name: skill.name,
      files: skill.files.map(file => ({
        relative: file.relative,
        content: file.content.toString('base64'),
        mode: file.mode,
      })),
    })),
  })).toString('base64');
  let stdout;
  try {
    stdout = await runWslInstaller(profile.command || 'wsl.exe', profile.args || ['--distribution', profile.distro], payload);
  } catch (error) {
    let detail = '';
    try { detail = JSON.parse(error.stdout).error; } catch {}
    if (detail?.code) fail(detail.code, detail.message);
    if (error.code === 'ENOENT') fail('WSL_UNAVAILABLE', `WSL is unavailable for ${profile.distro || profile.id}.`);
    fail('WSL_INSTALL_FAILED', `WSL skill installation failed: ${(error.stderr || error.message).trim().slice(0, 1200)}`);
  }
  let result;
  try { result = JSON.parse(stdout.trim()); }
  catch { fail('WSL_INSTALL_FAILED', 'WSL returned an invalid installation result.'); }
  return { ...result, agent, runtimeRoot: plan.runtimeRoot };
}

async function installLocalSkills({ workspace, profile, agent, skills, runtimeOptions = {} }) {
  if (!Object.hasOwn(SKILL_DESTINATIONS, agent)) fail('INVALID_ARGUMENT', 'Unsupported skills agent.');
  const names = Array.isArray(skills) ? skills.map(skill => skill.name).sort() : [];
  if (names.length !== SKILL_NAMES.length
    || new Set(names).size !== SKILL_NAMES.length
    || ![...SKILL_NAMES].sort().every((name, index) => names[index] === name)) {
    fail('BUNDLED_SKILL_INVALID', 'Exactly the two Winmux skills are required.');
  }
  const dataDir = runtimeOptions.dataDir || process.env.WINMUX_DATA_DIR
    || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Winmux');
  const plan = runtimePlan({ dataDir, appRoot: runtimeOptions.appRoot });
  if (profile.environment === 'windows') {
    try {
      if (!fs.statSync(workspace.cwd).isDirectory()) throw new Error('not a directory');
    } catch {
      fail('INVALID_CWD', 'The selected Windows project directory is unavailable.');
    }
    return installWindowsSkills({ cwd: workspace.cwd, agent, skills, runtime: plan });
  }
  if (profile.environment === 'wsl') return installWslSkills({ profile, cwd: workspace.cwd, agent, skills, runtime: plan });
  fail('PROFILE_UNAVAILABLE', 'Workspace shell environment is unavailable.');
}

module.exports = {
  SKILL_NAMES,
  SKILL_DESTINATIONS,
  SKILL_CONNECTION,
  RUNTIME_FILES,
  WSL_INSTALLER,
  readBundledSkills,
  runtimePlan,
  ensureRuntime,
  installWindowsSkills,
  installWslSkills,
  installLocalSkills,
};
