# Terminal daemon integration

`require('../backend.cjs').startServer({dataDir?, pipeName?})` returns an object with `server`, `dataDir`, `pipeName`, and async `close()` / `shutdown()`. Running `electron/backend.cjs` directly starts the long-lived daemon. Electron main launches it detached with `ELECTRON_RUN_AS_NODE=1`; closing a client or a desktop window does not stop it.

`require('../client.cjs').connect(options)` resolves an authenticated client. `request(method, params = {})` returns the RPC result. The client emits `event` with the event object, `close` when the socket closes, and `error` for transport errors. An internal no-op error listener prevents an unobserved `error` event from crashing Electron. Pending calls reject on disconnect. `close()` destroys only the client socket. Neither requests nor mutations are automatically retried.

The client sends at most 32 requests concurrently and accepts up to 128 additional waiting requests, bounded to 4 MiB of queued frames. Requests keep their admission order. The default 20-second deadline includes waiting time; an active request timing out closes that connection and rejects all remaining work, so unsent terminal input cannot replay later. Queue overflow rejects with `LIMIT_REACHED`.

Environment discovery lists installed WSL profiles but probes agent commands only inside distributions already reported as running. Agents in stopped distributions return `available: null` and `command: null`; both launch selectors label these entries as checked on launch. Explicitly launching such an agent resolves it inside the selected distribution and applies the same profile and executable-path validation as other launches. Listing Windows profiles and WSL options alone does not boot a stopped distribution.

## Wire protocol for independent UI control

Use `require('./shared.cjs').locations(options)` rather than duplicating endpoint construction. It returns `{dataDir, pipeName, tokenFile, stateFile, lockFile}`.

- Data directory: explicit `dataDir`, then `WINMUX_DATA_DIR`, then `path.join(LOCALAPPDATA || os.homedir(), 'Winmux')`.
- Pipe: explicit `pipeName`, then `WINMUX_PIPE_NAME`, then `\\.\pipe\winmux-<hash>` on Windows. The hash is the first 24 hexadecimal characters of SHA-256 over `username + ':' + homedir + ':' + dataDir.toLowerCase()`. The Unix fallback is a socket in `os.tmpdir()` with the same suffix.
- Capability: `<dataDir>/ipc-token`, 64 lowercase hex characters. Read with `readToken(tokenFile)`. Never log, commit, or send this value to the renderer.
- Transport: UTF-8, newline-delimited JSON. Every request must contain the capability, including requests after the connection is authenticated.

Request:

```json
{"id":"unique-id","token":"<local capability>","method":"state","params":{}}
```

Responses:

```json
{"id":"unique-id","result":{"workspaces":[],"notifications":[],"settings":{"fontSize":14,"theme":"dark"}}}
{"id":"unique-id","error":{"code":"INVALID_ARGUMENT","message":"Readable explanation"}}
```

Events are independent frames, interleaved with responses:

```json
{"event":{"type":"output","paneId":"pane-id","data":"terminal data","seq":17}}
```

Only authenticated connections receive events. `connect()` performs a `state` request before resolving. A separate UI-control server can reuse `locations()` and `readToken()` while choosing its own endpoint (for example a `-ui` suffix). It must independently validate every request and bound frames, clients, in-flight calls and output. This daemon has no `ui.register`, `ui.respond`, or `browser.*` forwarding methods.

Request limit: 256 KiB; input: 64 KiB of UTF-8 per request (including valid terminal NUL); response: 8 MiB; writable client buffer: 12 MiB; connections: 32; concurrent requests per connection: 32. The desktop serializes large pastes in 8 KiB UTF-8 chunks without splitting Unicode pairs; direct CLI/RPC callers retain responsibility for request limits. Slow/oversized clients are disconnected; they must reconnect and take fresh pane snapshots. Terminal write backlog is bounded to 4 MiB, with PTY pause/resume before that limit. A terminal exceeding the hard backlog limit is stopped and generates a notification. Maximum panes: 64; notifications: at most the newest 200 and further bounded by serialized state size; scrollback: 1000 lines; geometry: 2–300 columns, 1–200 rows.

## Screen ordering and persistence

The daemon writes real PTY data to `@xterm/headless`. It increments `seq` and emits output only inside xterm's write callback. `pane.snapshot` queues a write fence, serializes the terminal in that callback and returns the corresponding sequence. Subscribe before snapshot, buffer output, load the snapshot, discard buffered chunks with `seq <= snapshot.seq`, and apply the remaining chunks in sequence. When `environment.capabilities.previousOutput` is available, opt in with `settings.update {restoreHistory:true}`. Graceful shutdown fences pending writes and stores a bounded plain-text tail of each pane's normal buffer. State and workspace responses expose only `hasPreviousOutput`; `pane.previousOutput {paneId}` returns the requested pane text. Optional previous output is discarded before notifications if the state exceeds its 4 MiB limit. A fresh shell never receives those bytes. `settings.update {clearPreviousOutput:true}` removes the saved tails while keeping the setting enabled. If `state.persistenceFailed` is true, wait for successful save before restarting the daemon.

`state.json` is an atomically replaced `{version:2,state}` document; version 1 remains readable. A PID/nonce lock prevents two daemons from owning the same data directory. Restart preserves layout and pane/workspace identifiers but starts fresh shells. Missing profiles/directories leave an exited pane and a readable notification; no command history or agent work is replayed. Window disconnect preserves the existing shells and PIDs.

Automatically derived workspace names are bounded to the same 120-character limit as restored names without splitting a Unicode pair. Oversized legacy names are normalized during recovery. Serialized state stays within 4 MiB by retaining the newest notifications that fit, accounting for JSON escaping. The loader permits recovery of valid legacy state up to 16 MiB and backs up the original before normalizing names or trimming notification history; it never drops workspaces to make history fit. Preserve the `.recovery-*.bak` file when investigating a recovery. Invalid or still-oversized workspace state remains an explicit failure.

PowerShell starts without user profiles and initializes UTF-8 console input/output. WSL accepts absolute Linux paths or `~`; the latter resolves to the actual distribution home directory. Its baseline shell is `/bin/bash --noprofile --norc -i`, falling back to `/bin/sh -i`, so startup scripts cannot block the initial prompt. `node-pty` uses its bundled ConPTY DLL on Windows.

`environment` includes `profiles`, `defaultCwd`, `platform`, `capabilities`, and an `agents` catalog for Claude/Codex/Hermes/omp/pi on Windows and each WSL distribution. Agents have `id`, `label`, `environment`, `profileId`, `available`, `command` (or null), optional `distro`, and optional `hookAdapter`. Discovery never starts agents and rejects Windows extensionless POSIX npm shims in favor of executable `.exe`, `.cmd`, `.bat`, or `.ps1` paths.

`workspace.create`, `tab.create`, and `pane.split` accept optional `agentId` and `agentHooks` boolean. The agent must be available and match the chosen profile/environment. Selection launches it once during shell initialization and leaves the shell open after exit. PowerShell honors a same-name function supplied by the user's profile, preserving configured launchers. Shell arguments use quoted literals or positional argument arrays; arbitrary command source is not accepted. Ordinary splits do not inherit agent selection; daemon restoration never relaunches agents.

Pane metadata includes `agentId`, `agentLabel`, `agentState` (`starting`, `running`, `waiting`, `idle`, `completed`, `failed`, `unknown`), optional `agentExitCode`, and `agentUpdatedAt`. Shell lifecycle confirms invocation/exit; it cannot infer model activity. Session-only Claude/Codex hooks report explicit lifecycle events. When `agentHooks` is true, a Windows launch of OMP, Pi or Hermes ensures its project adapter before the process starts; an installation conflict is logged and does not block the terminal. Task-created workspaces forward the same preference. `agent.status {paneId,launchId,state}` uses the existing authenticated client and rejects stale launch identities. Windows Codex reads exact pane/launch/data-directory/pipe context from per-launch `hooks/session` JSON and PowerShell wrapper files, because the shared app-server does not inherit terminal `WINMUX_*` variables. Other session helpers retain their environment route. The helper reads the token at execution time, ignores prompt/transcript content, and bounds delivery time. Normal disposal and failed launch remove the artifacts. Claude uses additive session settings; Codex uses native hook settings collected from its session layer, without overriding `notify` or bypassing hook review/trust. Windows session hooks require PowerShell 7.3+; the complete encoded and quoted launch is limited to 30,000 UTF-16 units before spawning.

## Automation runs

`environment.capabilities.automationRuns` advertises `task.run.start` and
`task.run.get`. No request copies a prompt into shell source: `task.run.start`
reuses `task.create`'s project inspection, worktree ownership and `validateLaunch`,
then appends the prompt as one argument for the selected adapter
(`...args -- prompt` for Codex/Claude/Pi, `launch ...args -- prompt` for OMP and
`chat --query=prompt` for Hermes). Ordinary launches keep their previous argv.

`task.run.start {runId, projectDirectory, name, profileId, agentId, baseBranch, primaryBranch?, prompt}`
requires a lowercase UUID `runId`, which becomes the task identifier, and a Windows
profile. `agentId` is one of `codex`, `claude`, `omp`, `pi` or `hermes`; `mode` is
always `new` and hooks are always required, because an automation run without an
evidence channel could never report a confirmed outcome. Unknown request fields,
a non-Windows profile (`UNSUPPORTED_ENVIRONMENT`), a prompt that is blank,
contains NUL or exceeds 16 KiB, or a Pi prompt beginning with `@`
(`INVALID_AUTOMATION_PROMPT`) are rejected before any project, task or worktree
change. Repeating the same request returns the recorded run and never launches
again; the same `runId` with a different request is `RUN_CONFLICT`.

The private record is `task.automation` (`version`, `requestHash`, `status`,
`code`, `revision`, timestamps, optional `workspaceId`/`paneId` and a pending
`exit`). It never contains the prompt or captured output and is removed from every
public projection, including `state` broadcasts and the CLI `list` command;
`task.run.get` is the only way to read it. `requestHash` is SHA-256 over the
normalized request, so a repeated start can prove it is the same request.

Status is `creating`, `starting`, `running`, `waiting`, `completed`, `failed` or
`interrupted`, and `revision` advances only when observable metadata changes.
Only validated lifecycle evidence advances it: Codex/Claude session
`UserPromptSubmit`/`Stop`/`StopFailure` and waiting events, and OMP/Pi/Hermes
extension `agent_start`/`agent_end` and approval requests. A terminal report
without a prior acceptance leaves the run unresolved. A proven replacement is
`AGENT_REPLACED`, session shutdown is `AGENT_SESSION_ENDED`, pane disposal is
`PANE_CLOSED`, and a daemon restart turns every unfinished run into
`DAEMON_RESTARTED` without replaying the prompt.

A shell-observed agent exit (PTY exit or the OSC 1337 agent record) publishes
nothing for up to 10,000 ms. It is stored privately as `exit` and starts a drain
because a valid `Stop` can be serialized behind the mutation tail. Confirmed
evidence inside the window cancels the drain; otherwise the run becomes
`failed`/`AGENT_EXITED` for a nonzero code or `interrupted`/
`AGENT_EXITED_UNCONFIRMED` for a zero or unknown code, with one revision bump. A
zero exit is not prompt completion.

`task.run.get {runId, includeScreen?}` is a read, so it stays concurrent with
lifecycle updates. With `includeScreen: true` it fences the active viewport and
returns `{run, screen, screenError}`. A removed runtime, a closed pane or a
restored shell that reuses the saved pane identifier reports
`screenError: "RUN_OUTPUT_UNAVAILABLE"` rather than returning another process's
text; a failed pane lookup propagates its own code. The screen is the current
terminal view, never a complete transcript, and it is not persisted.

`electron/automation-client.cjs` exports `startRun`, `getRun` and `waitForRun`.
Each owns one authenticated connection, verifies the capability and never retries.
`waitForRun` polls the small run record every 250 ms, honors a `timeoutMs` of
0–86,400,000 (0 inspects once), returns a terminal status immediately, returns
`waiting` only above `afterRevision`, and supports an `AbortSignal` that stops
only that caller. `client.cjs` keeps a 20-second deadline for `task.run.get` and
the 120-second class for `task.run.start`, which performs worktree and spawn work.

## Native Codex integration

The Windows backend attaches to the already-running Codex daemon using WebSocket JSON-RPC over `codex app-server proxy`. It first checks `app-server daemon version`; absence or incompatibility gives a disconnected state. Discovery never starts/stops that daemon, submits a model turn, or responds to approvals. Only a verified Codex descendant of a live pane shell can receive native identity.

- `codex.status {}` returns connection readiness and loaded root-thread/pane mapping metadata. It excludes conversation content.
- `codex.bind {paneId,threadId}` selects an available thread for that pane and its exact directory. Ambiguous candidates stay unbound until explicitly selected.
- `agent.hook {agentId,event,sessionId,cwd,paneId?}` accepts supported Codex lifecycle events only for a current matching session/mapping. The project helper sends session and cwd instead of inheriting a possibly stale pane ID from the shared Codex daemon. A request may carry `v: 1` for the hook protocol version; a missing field means version 1 and any other value fails with `UNSUPPORTED_VERSION`.

Mapped panes expose optional `agentThreadId`, `agentSessionId`, and `agentBinding`. These bindings are ephemeral. Idle does not imply a completed turn; completion requires its native turn or hook event. A known Codex process retains its identity with unknown activity when thread mapping or the native connection is unavailable.

The desktop's explicit `agent.hooks.install` action is handled in the main process, not forwarded as a daemon RPC. It merges the selected Windows project's `.codex/hooks.json` or `.claude/settings.local.json`, installs OMP/Pi extensions or the Hermes plugin, preserves foreign handlers, backs up a changed config, and places a stable helper under the Winmux data directory. The same project installer is used by launch-time automation for OMP/Pi/Hermes; Codex and Claude remain session-only. System Node.js and Codex `/hooks` trust are prerequisites. WSL project-hook installation is rejected explicitly.

## Workspace terminal tabs

Each workspace has `tabs: [{id,title,titleMode?,root}]`, `activeTabId`, and a flat `panes` list; each pane has `tabId`. An automatic title follows the selected pane's live title; `titleMode: 'custom'` preserves an explicitly supplied title. Legacy records without a mode retain the shell-label migration heuristic. `workspace.root` remains an alias of the active tab's tree for older clients. Saved pre-tab workspaces migrate to a single tab. Layout restoration validates all tabs and pane references.

- `tab.create {workspaceId,sourcePaneId?,profileId?,cwd?,agentId?,agentHooks?,title?,titleMode?}` returns the created tab and selects it. By default its shell inherits the source pane's environment and last reported cwd. A supplied title defaults to custom mode; generated shell/agent tabs use automatic mode.
- `tab.select {workspaceId,tabId}` changes selection without stopping or restarting shells.
- `tab.close {workspaceId,tabId}` stops only the tab's panes; closing the last tab removes the workspace.
- `pane.split`, `pane.close`, and `layout.ratio` find the owning tab, including an inactive one, and preserve every other tab's layout/processes.
- `pane.move {paneId,targetPaneId,side}` relocates an existing pane within the same workspace. `side` is `left`, `right`, `top`, or `bottom`; the target is split with the moved pane at that edge. It returns `{paneId,workspaceId,tabId}` and selects the target tab. Empty source tabs disappear without disposing the moved runtime. Pane IDs, PIDs and screen contents remain intact. Self-targets, cross-workspace targets and invalid sides are rejected before layout mutation.

PowerShell and WSL Bash emit OSC 7 file URLs at each prompt. `pane.cwd: string` is the latest reported absolute directory, including spaces and Unicode; changes arrive in the existing `{type:'state', state}` event. `workspace.cwd` remains the original workspace root. No new event or `currentCwd` field is required. OSC URLs are decoded and checked for protocol, path shape, length, and control characters. A shell that replaces the prompt hook or the `/bin/sh` fallback cannot report directory changes automatically. Agents which do not emit OSC 7 retain the shell's last reported cwd until they exit.

The main-process `workspaceRequest` helper accepts optional `paneId: string` on `files.list`, `files.read`, `files.write`, `git.status`, and `git.diff`, alongside `workspaceId`. The pane must belong to that workspace. With it, operations use the pane's current directory and profile (including mixed Windows/WSL splits); relative paths and symlinks remain contained inside that directory. Pane-scoped Git status/diff are restricted to the current subtree, with paths relative to that directory. Without `paneId`, existing workspace-root behavior is retained. Clients should reset their relative file selection when the active pane or `pane.cwd` changes. `files.write` is a desktop-only operation: it validates complete UTF-8 text up to 512 KiB and compares `expectedText` with the current disk content before saving.

## Verification

Current Windows backends also advertise optional `ompHooks` and `agentActivity` capabilities. `agentActivity` gates the Claude/Pi/Hermes installer choices and the shared-gateway Hermes session picker; older daemons are preserved and never receive these new calls. `agent.sessions` returns bounded, process-verified Hermes observer candidates and Hermes pane IDs. `agent.bind {paneId,sessionId}` explicitly associates one current observer with one primary Hermes client. It rejects stale processes and ambiguous associations. Bindings are not restored across daemon/process generations.

The shared process snapshot identifies the topmost Codex, Claude, OMP, Hermes, or Pi process without reading the filesystem in the poll path. It remains available while the optional native Codex connection is pending. Native Codex and authenticated `agent.hook` lifecycle reports supply state and an optional bounded `agentActivity` enum. Process presence alone leaves activity unknown; arguments, prompts, results, and history are excluded from pane metadata. Hook helpers await their own response ID even when state notifications interleave.

OMP supplies `emittedAt` as epoch milliseconds alongside its decimal monotonic `stamp`: the former validates the process creation boundary, and the latter orders events from that process. Its native Bun clock has a different origin from Node's host clock. Session launch nonces continue to guard shell completion; only active session-specific Claude/Codex hooks lock out other status sources. Project adapters also work for agents selected through the launcher. Hermes uses a stable reporting session identity across proven compression/reset events.

Current backends advertise `environment.capabilities: {terminalTabs:true,liveCwd:true,agentLaunch:true,agentStatus:true,sessionAgentHooks:true,projectAgentHooks:true,nativeCodex:true,protocolVersion:3}`. Protocol 3 keeps the protocol 2 capabilities and adds `nativeCodex`. That boolean, not the version number alone, gates `codex.status`, `codex.bind`, and native hook installation. `projectAgentHooks` gates automatic OMP/Pi/Hermes installation; a newer UI attached to an older daemon without it keeps Codex/Claude session hooks but sends `agentHooks:false` for project-adapter agents instead of triggering `AGENT_HOOKS_UNSUPPORTED`. A 0.2.1 UI attached to a live 0.2.0 daemon still receives protocol 2 without `nativeCodex`. It keeps the running panes, does not call those methods, does not show a raw unknown-method error, and does not restart that daemon. Settings tells the user that the local Codex connection is available only after they finish the current sessions and start Winmux again. Closing the window does not upgrade the daemon. Missing `terminalTabs` identifies an older legacy daemon: the UI retains its existing terminals, shows an upgrade notice, and disables unsupported new launches. The user explicitly stops all sessions when ready before reopening the updated app. Tests instead use a separate data directory and pipe. Never reuse a live daemon's data directory for a second daemon or imply that copying state transfers running processes.

Run `node scripts/run-electron-node.cjs tests/cwd-agent-smoke.cjs` for the real isolated cwd/agent test. Its fixture daemon substitutes only the discovered agent catalog with harmless executables, never subscription agents. It covers PowerShell and available WSL, Unicode/quoted paths, agent validation, one-shot create/split launch, shell return, live cwd events, pane-scoped file/Git access and containment, mixed profiles, client reconnection, and recovery without agent replay.

Run `npm run test:backend` using the parent's Electron-as-Node runner. The bounded test uses an isolated temporary data directory and named pipe, and shuts down only its own daemon. It exercises real PowerShell and installed WSL PTYs, authentication, bounds, CLI calls, resize, Unicode/alternate screen, snapshot ordering, disconnect/reconnect, notifications, layout persistence and invalid restoration. A hard deadline fails the test rather than leaving it hanging. Failed runs preserve their isolated evidence directory.
