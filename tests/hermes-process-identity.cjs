'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('Hermes retains its originating process identity across queued events', () => {
  const python = (process.platform === 'win32' ? ['python.exe', 'python', 'py'] : ['python3', 'python'])
    .find(command => {
      const result = spawnSync(command, ['-c', 'import sys; print(sys.version_info[0])'], {
        encoding: 'utf8', windowsHide: true,
      });
      return result.status === 0 && result.stdout.trim() === '3';
    });
  assert.ok(python, 'Python 3 is required to exercise the Hermes plugin');
  const plugin = path.resolve(__dirname, '..', 'electron', 'hooks', 'winmux-hermes-plugin.py');
  const fixture = String.raw`
import ctypes
from ctypes import wintypes
import importlib.util
import json
import sys
import threading
import types
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("isolated_hermes_identity", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

class Function:
    def __init__(self, callback):
        self.callback = callback
    def __call__(self, *args):
        return self.callback(*args)

def times(handle, created, exited, kernel, user):
    assert handle == 42
    value = ctypes.cast(created, ctypes.POINTER(wintypes.FILETIME)).contents
    value.dwHighDateTime = 0x01234567
    value.dwLowDateTime = 0x89abcdef
    return 1

api = types.SimpleNamespace(GetCurrentProcess=Function(lambda: 42), GetProcessTimes=Function(times))
with mock.patch.object(module.os, 'name', 'nt'), mock.patch.object(ctypes, 'windll', types.SimpleNamespace(kernel32=api), create=True):
    converted = module._current_process_identity()
    api.GetProcessTimes = Function(lambda *args: 0)
    assert module._current_process_identity() is None
with mock.patch.object(module.os, 'name', 'posix'):
    assert module._current_process_identity() is None

identity = ['638712345678901234']
provider_calls = []
entered = threading.Event()
release = threading.Event()
sent = []
def provider():
    provider_calls.append(True)
    return identity[0]
def send(payload):
    entered.set()
    assert release.wait(5), 'delivery was not released'
    sent.append(dict(payload))

adapter = module.WinmuxHermesPlugin(
    send=send, get_process_identity=provider, get_pid=lambda: 4242,
    get_cwd=lambda: 'C:/work', delegated_context=lambda: False,
    environ={}, async_delivery=True,
)
adapter.on_session_open(session_id='first', platform='cli', reason='create')
adapter.pre_llm_call(session_id='first', platform='cli', parent_session_id='')
assert entered.wait(5), 'worker did not receive the first event'
identity[0] = '638799999999999999'
adapter.on_session_end(session_id='first', completed=True)
adapter.on_session_finalize(session_id='first', platform='cli')
adapter.on_session_reset(session_id='second', platform='cli', reason='new_session', old_session_id='first', new_session_id='second')
adapter.pre_llm_call(session_id='second', platform='cli', parent_session_id='')
release.set()
adapter._queue.join()
adapter.close()
assert len(provider_calls) == 1

fallbacks = []
def broken():
    raise OSError('unavailable')
for fallback in (lambda: None, broken):
    events = []
    instance = module.WinmuxHermesPlugin(
        send=events.append, get_process_identity=fallback, get_pid=lambda: 4242,
        get_cwd=lambda: 'C:/work', delegated_context=lambda: False,
        environ={}, async_delivery=False,
    )
    instance.on_session_open(session_id='fallback', platform='cli', reason='create')
    instance.pre_llm_call(session_id='fallback', platform='cli', parent_session_id='')
    instance.on_session_end(session_id='fallback', completed=True)
    fallbacks.append(events)

print(json.dumps({'converted': converted, 'events': sent, 'fallbacks': fallbacks}))
`;
  const result = spawnSync(python, ['-c', fixture, plugin], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  const output = JSON.parse(result.stdout);
  assert.equal(output.converted, (504911232000000000n + 0x0123456789abcdefn).toString());
  assert.deepEqual(output.events.map(event => event.event), [
    'session_start', 'agent_start', 'agent_end', 'session_shutdown', 'session_switch', 'agent_start',
  ]);
  assert.ok(output.events.every(event => event.pid === 4242 && event.processIdentity === '638712345678901234'));
  for (const events of output.fallbacks) {
    assert.deepEqual(events.map(event => event.event), ['session_start', 'agent_start', 'agent_end']);
    assert.ok(events.every(event => !Object.hasOwn(event, 'processIdentity')));
  }
});
