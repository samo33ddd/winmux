'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const environmentFile = path.resolve(__dirname, '..', 'electron', 'backend', 'environment.cjs');
const environmentSource = fs.readFileSync(environmentFile, 'utf8');
const nativeRequire = createRequire(environmentFile);

function wslOutput(value) {
  return Buffer.from(`${value}\r\n`, 'utf16le');
}

function loadEnvironment(respond) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'winmux-environment-test-'));
  const pwsh = path.join(fixtureRoot, 'PowerShell', '7', 'pwsh.exe');
  const wsl = path.join(fixtureRoot, 'System32', 'wsl.exe');
  fs.mkdirSync(path.dirname(pwsh), { recursive: true });
  fs.mkdirSync(path.dirname(wsl), { recursive: true });
  fs.writeFileSync(pwsh, '');
  fs.writeFileSync(wsl, '');

  const calls = [];
  const warnings = [];
  const invoke = async (file, args) => {
    const call = { file, args: [...args], options: undefined };
    calls.push(call);
    const response = await respond(call);
    if (response instanceof Error) throw response;
    const stdout = Buffer.isBuffer(response) ? response : wslOutput(response);
    return { stdout, stderr: Buffer.alloc(0) };
  };
  const execFile = (file, args, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    calls.push({ file, args: [...args], options });
    Promise.resolve()
      .then(() => respond({ file, args: [...args], options }))
      .then(
        response => callback(null, {
          stdout: Buffer.isBuffer(response) ? response : wslOutput(response),
          stderr: Buffer.alloc(0),
        }),
        callback,
      );
  };
  execFile[util.promisify.custom] = (file, args, options) => {
    return invoke(file, args, options);
  };

  const environment = {
    ...process.env,
    ProgramFiles: fixtureRoot,
    SystemRoot: fixtureRoot,
    WINMUX_NO_PROFILE: '1',
  };
  const fakeProcess = Object.create(process);
  Object.defineProperties(fakeProcess, {
    env: { value: environment },
    platform: { value: 'win32' },
  });
  const moduleObject = { exports: {} };
  const sandbox = {
    Buffer,
    URL,
    __dirname: path.dirname(environmentFile),
    __filename: environmentFile,
    console: { ...console, warn: message => warnings.push(String(message)) },
    exports: moduleObject.exports,
    module: moduleObject,
    process: fakeProcess,
    require(id) {
      if (id === 'node:child_process') return { execFile };
      return nativeRequire(id);
    },
  };
  const wrapper = `(function (exports, require, module, __filename, __dirname) {\n${environmentSource}\n})`;
  const load = vm.runInNewContext(wrapper, sandbox, { filename: environmentFile });
  load(moduleObject.exports, sandbox.require, moduleObject, environmentFile, path.dirname(environmentFile));

  return {
    calls,
    cleanup: () => fs.rmSync(fixtureRoot, { recursive: true, force: true }),
    environment: moduleObject.exports,
    warnings,
    wsl,
  };
}

function discoveryResponder({ installed, running, agents = {}, explicitCommand, explicitDistribution } = {}) {
  return call => {
    if (path.basename(call.file).toLowerCase() === 'where.exe') return process.execPath;
    if (!call.args.includes('--list') && !call.args.includes('--exec')) {
      throw new Error(`Unexpected command: ${call.file} ${call.args.join(' ')}`);
    }
    if (call.args.includes('--list') && !call.args.includes('--exec')) {
      if (call.args.includes('--running')) {
        if (running instanceof Error) throw running;
        return wslOutput(running.join('\r\n'));
      }
      return wslOutput(installed.join('\r\n'));
    }
    const distribution = call.args[call.args.indexOf('--distribution') + 1];
    if (call.args.some(argument => argument.includes('$1')) && distribution === explicitDistribution) {
      if (explicitCommand instanceof Error) throw explicitCommand;
      return wslOutput(explicitCommand || '');
    }
    if (distribution === explicitDistribution) return '';
    if (distribution !== 'Ubuntu') throw new Error(`Stopped distribution was queried: ${distribution}`);
    const output = ['claude', 'codex', 'hermes', 'omp', 'pi']
      .map(name => `${name}\t${agents[name] || ''}`)
      .join('\r\n');
    return wslOutput(output);
  };
}

test('discovery never probes inside a WSL distribution', async t => {
  const fixture = loadEnvironment(discoveryResponder({
    installed: ['Ubuntu', 'Debian'],
    running: ['Ubuntu'],
    agents: { claude: '/usr/bin/claude' },
  }));
  t.after(fixture.cleanup);

  const discovered = await fixture.environment.discover();
  const ubuntu = discovered.profiles.find(profile => profile.id === 'wsl:Ubuntu');
  const debian = discovered.profiles.find(profile => profile.id === 'wsl:Debian');
  assert.equal(ubuntu.running, true);
  assert.equal(debian.running, false);

  const wslCalls = fixture.calls.filter(call => call.file === fixture.wsl);
  assert.ok(wslCalls.some(call => call.args.join(' ') === '--list --quiet'));
  assert.ok(wslCalls.some(call => call.args.join(' ') === '--list --running --quiet'));
  const probes = wslCalls.filter(call => call.args.includes('--exec'));
  assert.equal(probes.length, 0, 'discovery never probes inside a distribution');

  for (const name of ['claude', 'codex', 'hermes', 'omp', 'pi']) {
    const running = discovered.agents.find(agent => agent.id === `wsl:Ubuntu:${name}`);
    assert.equal(running.available, null);
    assert.equal(running.command, null);
    const stopped = discovered.agents.find(agent => agent.id === `wsl:Debian:${name}`);
    assert.equal(stopped.available, null);
    assert.equal(stopped.command, null);
  }
});

test('a failed running-list query fails closed without probing any distribution', async t => {
  const fixture = loadEnvironment(discoveryResponder({
    installed: ['Debian'],
    running: new Error('running list unavailable'),
  }));
  t.after(fixture.cleanup);

  const discovered = await fixture.environment.discover();
  const debian = discovered.profiles.find(profile => profile.id === 'wsl:Debian');
  assert.equal(debian.running, false);
  assert.deepEqual(fixture.warnings, ['WSL running-state discovery unavailable: running list unavailable']);
  assert.equal(fixture.calls.filter(call => call.args.includes('--exec')).length, 0);
  for (const agent of discovered.agents.filter(agent => agent.profileId === debian.id)) {
    assert.equal(agent.available, null);
    assert.equal(agent.command, null);
  }
});

test('explicit WSL agent selection resolves only within its validated profile', async t => {
  const fixture = loadEnvironment(discoveryResponder({
    installed: ['Debian'],
    running: [],
    explicitCommand: '/usr/local/bin/claude',
    explicitDistribution: 'Debian',
  }));
  t.after(fixture.cleanup);

  const discovered = await fixture.environment.discover();
  const agent = discovered.agents.find(candidate => candidate.id === 'wsl:Debian:claude');
  agent.args = ['--safe-arg', 'value with spaces'];

  const launch = await fixture.environment.validateLaunch(
    discovered,
    'wsl:Debian',
    '/home/test',
    'wsl:Debian:claude',
    true,
  );
  assert.equal(launch.agentId, 'wsl:Debian:claude');
  assert.ok(launch.args.includes('/usr/local/bin/claude'));
  const commandIndex = launch.args.indexOf('/usr/local/bin/claude');
  assert.deepEqual(Array.from(launch.args.slice(commandIndex + 1, commandIndex + 3)), ['--safe-arg', 'value with spaces']);
  assert.ok(launch.args.includes('--settings'));

  const execIndex = launch.args.indexOf('--exec');
  const shellArgs = launch.args.slice(execIndex + 1);
  assert.equal(shellArgs[5], 'winmux-init');
  assert.equal(shellArgs[6], '/usr/local/bin/claude');
  assert.equal(shellArgs[3].includes('/usr/local/bin/claude'), false);
  assert.equal(shellArgs[3].includes('--safe-arg'), false);

  const probes = fixture.calls.filter(call => call.args.includes('--exec')
    && call.args.some(argument => argument.includes('$1')));
  assert.equal(probes.length, 1);
  assert.equal(probes[0].args[probes[0].args.indexOf('--distribution') + 1], 'Debian');
});

test('explicit unknown WSL agents reject unavailability and profile mismatches before launch', async t => {
  const fixture = loadEnvironment(discoveryResponder({
    installed: ['Debian'],
    running: [],
    explicitCommand: '',
    explicitDistribution: 'Debian',
  }));
  t.after(fixture.cleanup);

  const discovered = await fixture.environment.discover();
  discovered.profiles.push({
    ...discovered.profiles.find(profile => profile.id === 'wsl:Debian'),
    id: 'wsl:Ubuntu',
    label: 'Ubuntu',
    distro: 'Ubuntu',
  });
  await assert.rejects(
    fixture.environment.validateLaunch(discovered, 'wsl:Debian', '/home/test', 'wsl:Debian:codex'),
    { code: 'AGENT_UNAVAILABLE' },
  );
  const probeCount = () => fixture.calls.filter(call => call.args.some(argument => argument.includes('$1'))).length;
  const unavailableProbeCount = probeCount();
  assert.equal(unavailableProbeCount, 1);

  await assert.rejects(
    fixture.environment.validateLaunch(discovered, 'wsl:Ubuntu', '/home/test', 'wsl:Debian:codex'),
    { code: 'AGENT_PROFILE_MISMATCH' },
  );
  assert.equal(probeCount(), unavailableProbeCount);
});

test('an explicitly resolved WSL command still passes selected-agent path validation', async t => {
  const fixture = loadEnvironment(discoveryResponder({
    installed: ['Debian'],
    running: [],
    explicitCommand: 'relative/claude',
    explicitDistribution: 'Debian',
  }));
  t.after(fixture.cleanup);

  const discovered = await fixture.environment.discover();
  await assert.rejects(
    fixture.environment.validateLaunch(discovered, 'wsl:Debian', '/home/test', 'wsl:Debian:claude'),
    { code: 'AGENT_UNAVAILABLE' },
  );
  assert.equal(
    fixture.calls.filter(call => call.args.some(argument => argument.includes('$1'))).length,
    1,
  );
});
