---
name: winmux-dev
description: "Develop, debug, verify, document, and release Winmux source changes across React, Electron, daemon, agents, and contributor tooling. Use winmux-terminal or winmux-browser to operate an existing instance."
---

# Winmux development

Use this skill for every Winmux development, debugging, verification, documentation,
CI, or release task. Read the current project rules before acting. This skill adds
no permissions: the user's current instructions and existing authorization govern
merge, publication, live restart, and external writes. Preserve other worktrees
and uncommitted work. Existing authorization does not need to be requested again.

## Locate and scope the change

The usual checkout is `E:/projects/winmux`; otherwise locate a checkout whose
`package.json` has `name: "winmux"`. Check the actual root, `git status --short
--branch`, and `git worktree list` before edits and after continuation. Use the
assigned checkout and a focused branch; create isolated worktrees with Git when
needed. Read `AGENTS.md`, `CONTRIBUTING.md`, and `package.json`. Read
`electron/backend/README.md` and `docs/agents.md` for daemon/agent boundaries.

Every code, documentation, dependency, CI, fix, or release-preparation change starts
with a GitHub Issue defining the problem, intended behavior, and acceptance criteria.
Trace affected inputs, callers, stored state, fixtures, types, and recovery paths
before choosing the smallest complete change in the existing layers.

## Architecture and contracts

| Area | Source | Ownership |
| --- | --- | --- |
| Renderer | `src/**`, `index.html` | React UI, themes, i18n, presentation; no Node.js access |
| Main | `electron/main.cjs` | Window lifecycle, IPC handlers, file/Git and browser ownership |
| Preload | `electron/preload.cjs` | Narrow contextBridge; never expose tokens or arbitrary IPC |
| Daemon | `electron/backend.cjs`, `electron/backend/**`, `electron/client.cjs` | PTYs, sessions, persistence, authenticated RPC; survives UI closure |
| CLI/types | `cli.cjs`, `electron/backend/shared.cjs`, `src/types.ts` | Commands, endpoint/capability resolution, shared contracts |
| Browser | `electron/browser-control.cjs`, `scripts/browser.cjs`, `src/BrowserTabs.tsx` | Desktop-owned browser service, separate from daemon RPC |
| File editing | `src/FileEditor.tsx`, `src/fileDrafts.ts`, `src/HighlightedCode.tsx`, `electron/workspace.cjs` | Draft ownership, safe text writes, rendering/highlighting |
| Project tasks | `electron/backend.cjs`, `electron/backend/task-git.cjs`, `src/TaskDialog.tsx`, `src/ProjectTasks.tsx` | Project identity, worktree ownership/archive, task workspace lifecycle |
| PR delivery | `electron/backend/task-delivery.cjs`, `electron/backend/environment.cjs` | GitHub identity, review/check/merge gates, task-agent instructions |
| Verification | `tests/**`, `scripts/run-electron-node.cjs` | Contract, Electron runtime, installed clients, release publisher |

Follow `renderer -> preload -> main IPC -> service` or `CLI -> client -> daemon`.
Web content must not receive Node.js or privileged preload access. Preserve workspace
containment and Windows/WSL ownership; the browser is not a daemon RPC service.

### Files and drafts (0.2.2 baseline)

The Files editor sits left of the directory tree, with a resizable divider. Text
wraps; source and Markdown code fences use syntax highlighting. Markdown preview
uses safe rendering: raw HTML and remote images are disabled; links/images are
shown as text. Git remains read-only.

Saving is explicit through Save/Ctrl+S. `files.write` checks workspace ownership,
containment, complete valid UTF-8 up to 512 KiB, and expectedText against current
disk contents. Reject binary/image/invalid/truncated input; preserve CRLF. Exercise
both Windows and WSL when this contract changes. Never turn a conflict into a
silent overwrite or treat a preview fragment as the whole file.

Shared drafts and pending-save locks survive editor remounts. Fresh disk reads
replace stale clean caches. Owner closure warns before discarding dirty content
and is blocked during pending saves; the desktop close path also protects unsaved
work. Check remount/save races, stale clean data, and orphan drafts together when
changing lifetime or ownership. Keep error and conflict recovery visible.

Files and Git sibling keys must include their view identity as well as workspace,
pane and cwd. Reusing one context key for both siblings can leave orphaned Files
DOM after remounts. Keep the browser guest identity stable and retain shared file
drafts across those remounts. `tests/files-panel-context-electron.cjs`, included in
`test:desktop`, checks total and visible root counts across same-cwd pane switches
and directory changes, draft retention, expansion and browser form state.

### Terminal links and input

Previous terminal output is opt-in in Settings → Terminal and requires the
daemon's `capabilities.previousOutput`. Graceful daemon shutdown fences queued
xterm output and saves at most 80 plain-text lines and 2,048 UTF-16 units per
pane in `state.json`. Restore uses the original pane ID and opens the saved
output in a separate dialog. State and workspace responses expose only
`hasPreviousOutput`; `pane.previousOutput {paneId}` retrieves one pane on demand.
The dialog follows the selected pane and closes when another client clears its
saved output. Ignore late fetches after selection or history changes. Optional
history is dropped before notifications if the 4 MiB state budget is exceeded.
Fresh shells never receive those bytes. Clearing saved output keeps the capture
preference on; turning the preference off also clears all saved output. Watch
the persistence warning if writing fails and verify the retry before relying on
clear or disable.

Run `npm run test:backend` with Windows PowerShell and a real WSL distribution
for shutdown and restore, Unicode, the per-pane bound, Windows/WSL separation,
and cleanup. After `npm run build`, `node tests/desktop-smoke.cjs` uses a
disposable daemon and verifies enabling capture, opening the saved output after
the daemon restarts, and clearing it in Settings or through another client.

The command palette shortcut Ctrl+Shift+P follows physical `KeyP` across keyboard
layouts, including Russian, and must pass through xterm to the app handler. Palette
pane results include their workspace and pane position so identical titles remain
distinguishable; filtering, keyboard selection, Escape and focus restoration are
covered by the isolated Electron desktop smoke at the 900px minimum width.

The topbar's empty `.workspace-tabs` area is an Electron drag region; actual tab
and toolbar buttons remain `no-drag`. Validate computed regions and, when native
Computer Use is available, measure the restored window position after a real
header drag. CDP pointer events alone do not prove native window movement. A
missing native pipe is a verification limitation, not a product pass.
The standalone `cua-driver` can remain available when `@oai/sky` reports a missing
pipe. Use `cua-driver doctor`, enumerate the exact test window, capture fresh
window state, then attempt a native drag in blank header space. If background
delivery is refused or verified ineffective, use the driver's explicit foreground
route on that test window. Measure before/after OS bounds; `effect: unverifiable`
in the gesture response alone proves nothing. The 0.2.3 check observed movement
with one/two tabs and at 900px, plus native restoration by dragging a maximized
window. Never substitute `setBounds` for the gesture being tested.

Terminal pane relocation uses `pane.move {paneId,targetPaneId,side}` with four
edge positions inside one workspace. Move the existing leaf/runtime, collapse
the source layout, and remove only an empty source tab's metadata. Never call a
tab/pane disposal helper while moving. Verify IDs, PIDs, screen contents, drafts,
same-tab/cross-tab layout consistency, invalid targets and persisted restoration.
The renderer uses tab/pane headers as drag sources and a highlighted destination;
terminal body selection and native blank-header window dragging stay independent.
In the Electron cross-tab smoke, wait for the source pane's native drag marker
before moving to the destination. Repeat the pointer move over the destination
tab and split edge to deliver Chromium drag events on hosted Windows.

Terminal web links have two callers in `src/TerminalPane.tsx`: WebLinksAddon for
plain URLs and the OSC 8 `linkHandler`. Both require Ctrl+left-click and forward to
the owning workspace through `WorkspaceView` and App's existing browser-request
state. Do not invoke `openExternal` from these handlers. Ordinary web-link clicks
do not navigate; local file activation and the browser toolbar's explicit external
action retain their contracts. BrowserPage still validates HTTP(S) and credentials.
`test:file-preview` exercises both link types in isolated Electron against a local
HTTP fixture, checks modifier gating and detects external-browser requests.

Desktop input goes through `src/terminalInput.ts`: serialize bounded UTF-8 chunks
across all xterm `onData` events so a large paste and later typing cannot overtake
one another. Preserve surrogate pairs and bracketed-paste bytes, discard remaining
queued input after a failure, and never retry it. Owner removal/unmount cancels
pending delivery. The backend retains its 64 KiB byte limit and accepts terminal
NUL without changing strict identifiers or path validation. The focused queue
regression runs in `test:integrations`; `test:desktop` checks real Ctrl+Space and a
Unicode clipboard paste over 64 KiB through Electron and ConPTY.

Main installs `electron/stdio.cjs` before Electron startup. A closed launcher pipe
must not raise a native uncaught EPIPE dialog, but non-EPIPE stream errors remain
visible. `tests/stdio.cjs` covers real closed stdout/stderr and unexpected errors.
Use graceful test teardown; an abruptly terminated Playwright controller can
leave an isolated Electron process alive with broken output pipes. Match the
fixture data directory and exact process ancestry before cleaning up, never an
owner window or the shared Codex daemon.

### Agent lifecycle and notifications

When a Windows launch has `agentHooks: true`, `validateLaunch` ensures the
project-local adapter for OMP, Pi and Hermes before the process starts. The
installer is the same idempotent project installer used by
`agent.hooks.install`; it preserves foreign files and rejects symlinks and
conflicts. An automatic installation failure is logged and must not block the
terminal. Codex and Claude remain session-only and must not receive an automatic
project hook. Task-created workspaces forward the same preference. WSL launches
skip Windows project installation. Hermes installation still requires the
explicit `hermes plugins enable winmux-status` step; never enable it silently.
The renderer must gate this flag on `capabilities.projectAgentHooks` for
non-`hookAdapter` agents and on `capabilities.sessionAgentHooks` for
Codex/Claude. An older daemon lacks `projectAgentHooks` and rejects
`agentHooks:true` for OMP/Pi/Hermes with `AGENT_HOOKS_UNSUPPORTED`; sending
`false` keeps those launches working until the daemon is upgraded.

For Windows Codex session hooks, allocate pane/launch IDs before constructing the
PowerShell arguments. `validateLaunch` receives the selected daemon data directory
and pipe; per-launch `hooks/session/codex-<launchId>.json` and `.ps1` artifacts pass
that context to `agent-status.cjs --codex --context-file`. Shared app-server hooks
cannot rely on inherited terminal `WINMUX_*` variables. Never embed capability
tokens or prompt/tool arguments in those artifacts. Clean them on normal disposal
and failed launch. Preserve WSL's separate interop route and user hook trust.

Portable Windows builds run from an extracted temporary directory. If a new
Electron-as-Node hook process exits before JavaScript with `Invalid file
descriptor to ICU data received.` or a missing V8 snapshot error, treat the
extraction as potentially damaged and check for missing resources. The deletion
source is not established; do not claim
temporary cleanup caused it without separate evidence.

Recover with resources from the exact matching build:

1. Resolve the live hook executable (`process.execPath` in the daemon or the
   executable named by the generated wrapper) and compare its SHA-256 with
   `release/win-unpacked/Winmux.exe` from the same version. Stop if they differ.
2. Copy only missing `icudtl.dat`, `snapshot_blob.bin`, and
   `v8_context_snapshot.bin` from that matching unpacked package into the live
   executable directory. Do not overwrite an existing resource, delete the live
   temporary extraction, or restart the owner application.
3. Validate synchronously and wait for completion: run the live `Winmux.exe`
   with `ELECTRON_RUN_AS_NODE=1` and a harmless JavaScript expression; require
   status 0, the expected Electron version on stdout, empty stderr, and the
   generated helper path to exist. A `spawnSync` or `execFileSync` result is
   runtime evidence; merely starting a process without waiting for its result is not.
4. Treat successful Electron-as-Node startup only as recovery evidence. A
   synthetic hook-state fixture does not prove Codex trusted or executed the
   generated hooks. Actual hook coverage requires Codex to execute the generated
   command against the real daemon and must separately verify the resulting
   sidebar activity or notification state; otherwise report that limitation.

Measure the complete PowerShell command after UTF-16/base64 and Windows argv
quoting, rather than just the hook JSON size. The launcher rejects above 30,000
UTF-16 units before spawning; the Unicode/spaces regression measured 22,795.
Use a shorter data-directory path if this limit is reached, preserving the owner
instance. Same-session confirmed hooks survive ambiguous polls/disconnect;
terminal completion events and replacement sessions still clear stale activity.

Large valid notification histories approach the saved 4 MiB serialized budget.
Coalesce replaceable state broadcasts while a socket needs drain, retaining the
latest state; do not remove limits or drop ordered terminal output and RPC replies.
The real backend regression must restore escaped history, move/close panes and
observe subsequent shell exit without disconnecting the responsive client.

A shell PID, discovered CLI, quiet terminal, or unavailable transport does not prove
activity or completion. Keep unknown explicit. Clear stale exit codes when a new
agent identity starts; display codes only for confirmed completed/failed states.

Completion notifications follow confirmed lifecycle events from launch hooks,
agent.status, or native/shared identity tracking. Preserve deduplication across
repeated terminal states and allow a new turn to complete independently. Verify
success, failure, repeated events, and identity changes where affected. A manual
`notify` call tests display only, never actual agent-completion detection.

For an authorized real check, create a separate installed-agent tab, wait for its
actual ready prompt, submit one harmless no-tools request, and observe its reply,
confirmed state, and a matching new notification. Do not repeatedly submit after
an ambiguous timeout. Inspect the pending input before sending Enter separately;
Codex may leave a pasted prompt visible before submission. Exit the verification
agent when finished and check that it creates no duplicate completion notice.
Application notification state, visible panel, and Windows toast are separate
claims; report unavailable GUI capture without pretending an API result is a screenshot.

### Automation runs

`task.run.start`/`task.run.get` own one initial root turn of one newly created
managed task. `electron/backend/task-automation.cjs` holds the request contract,
the private `task.automation` record and the lifecycle reducer; no second task
table, queue or provider call exists. The caller-supplied lowercase UUID `runId`
is the task ID, and `requestHash` (SHA-256 over the normalized request) makes a
repeat idempotent while a different request with the same ID is `RUN_CONFLICT`.
The record never stores the prompt or captured output, and `publicTask()` strips
it from `state`, broadcasts and `list`; `task.run.get` is the only reader.

`createTask`/`createWorkspace` in `electron/backend.cjs` take a private
`automation` context that ordinary `task.create`/`workspace.create` never supply.
It forces `agentHooks: true` and `mode: 'new'`, probes the hook shell for every
adapter, propagates project-hook installation failures, and adapts only the final
argument vector: `...args -- prompt` for Codex/Claude/Pi, `launch ...args --
prompt` for OMP and `chat --query=prompt` for Hermes. The prompt is one argument
and never shell source; the existing 30,000-unit encoded-command budget still
applies, so an oversized vector is a retained failed run, not a rejection.
WSL profiles fail with `UNSUPPORTED_ENVIRONMENT` and a Pi prompt starting with `@`
fails with `INVALID_AUTOMATION_PROMPT`, both before any task exists.

Status advances only from validated lifecycle evidence. `agent-status.cjs`
forwards the recognized hook event name and a bounded `session_id`, and
`agent.status` re-checks event-to-state consistency before reducing. Project
extensions reach the reducer through `agent-integration.cjs`'s `onLifecycle` and
`onIdentityLost` callbacks; `holdIdentity` keeps a run-bound record alive during
the drain. Never accept a turn or finish a run from pane state, OSC, quiet output,
timestamps or tool events.

A shell-observed exit (PTY exit or OSC 1337) is private for `DRAIN_MS` (10,000 ms)
because a valid `Stop` can sit behind the mutation tail while `agentEnded` is
already set. `agent.status` accepts that evidence for the bound launch during the
drain only; ordinary panes keep the strict gate. Expiry publishes
`AGENT_EXITED`/`AGENT_EXITED_UNCONFIRMED` with one revision bump. Pane disposal is
`PANE_CLOSED` immediately, a proven replacement is `AGENT_REPLACED`, and startup
normalization turns every unfinished run into `DAEMON_RESTARTED` with the existing
recovery backup.

Hermes keeps at most three metadata-only first-turn pieces (first start, latest
nonterminal evidence, first immutable end) per verified observer, and
`bind(paneId, sessionId, constraint)` requires a unique observer for the exact
task directory whose session-start and first-start receipts are at or after the
run start. Replay those pieces after binding; binding an idle snapshot must not
invent acceptance. `persistenceFailed`, hook trust and plugin enablement stay
user-visible prerequisites, never something the automation path enables.

Verify with `node --test tests/task-automation.cjs` (reducer, drain, persistence,
restart normalization) and `node scripts/run-electron-node.cjs
tests/automation-smoke.cjs` (five adapters over real worktrees/PTYs, drain cases,
waiting/abort, replacement, disposal, Hermes binding, CLI exit codes). The smoke
test injects the process table so a real fixture `node.exe` process is classified
as each adapter, and it rebuilds the full agent argv around its own script path
and id because OMP's `launch` token precedes them. Fixture success is not
installed-agent compatibility.

Observed limitation, not fixed by this contract: `agent-hooks-install.cjs`'s
`assertContained` compares a resolved root with the caller's unresolved path, so a
junctioned project or data directory fails with `UNSAFE_PATH`. Keep automation
fixtures on a non-junctioned directory and report the failure code rather than
silently degrading to no evidence.

### Project tasks and delivery

Project commands are stored by profile and Git common directory, so linked
worktrees share templates while execution targets the selected workspace's own
starting directory. The dialog pins the selected pane until it closes; a closed
pane must not retarget a replacement. Parameter values are shell-quoted.
Placeholders are separate arguments outside quotes and shell substitutions.
Preview includes the directory change and is the exact input sent on explicit
run. Windows parameterized commands require PowerShell 7.3 or later and use
Standard native argument passing in their invocation scope. Windows PowerShell
5.1 can run templates without parameters. WSL uses POSIX shell built-ins.
Run `node tests/desktop-smoke.cjs`
for isolated Electron verification with PowerShell and Ubuntu WSL, alongside
`npm run test:skills`.
The pane must be a regular running shell; its prompt and empty input still require
the user's attention. A reported pane cwd is not proof of the shell's actual cwd.

Projects are inferred during `task.create` and grouped by the Git common
directory, shell environment, and WSL distribution. Task state is persisted with
workspaces in state version 3. Loading version 1 or 2 produces a byte-identical
`state.json.pre-tasks-*` backup, initializes empty project/task arrays, and
leaves the source file unchanged on that load. Reject state with a task whose
project is missing, duplicate identifiers, invalid ownership, or more than 1,024
projects / 4,096 tasks.

The task RPC surface is:

- `project.inspect {cwd,profileId}` resolves an available Windows/WSL profile,
  inspects the repository and linked worktrees, lists local branches, and detects
  `origin/HEAD`, then `main` or `master`, as the primary branch.
- `task.create` requires `projectDirectory`, `name`, `profileId`, `agentId`,
  `baseBranch`, and `mode`; `primaryBranch` is required when detection fails.
  `new` creates a sibling managed worktree and `winmux/<slug>-<short-id>` branch;
  `attach` requires a non-primary, non-detached linked worktree with a branch and
  rejects a worktree already attached to a task. The selected agent must match
  the profile. The call creates the task workspace and exports
  `WINMUX_TASK_ID` to matching agent panes.
- `task.open` returns an existing workspace, opens a ready task, or restores a
  removed managed worktree on its retained branch. It must reject incomplete
  tasks and missing branches without fabricating replacement history.
  Archive an interrupted incomplete attach to release that failed reservation
  before attaching again. Ready archived tasks retain their reservation.
- `task.archive` requires the task workspace and delivery operation to be
  inactive. It removes a managed worktree only when ownership is unambiguous and
  the worktree is clean, including tracked, untracked, and ignored data. Index
  flags that hide changes (assume-unchanged or skip-worktree) also block removal. The
  branch is preserved. Imported, dirty, locked, in-use, or ownership-conflicted
  worktrees stay on disk and return a visible `reason`.

Worktree ownership uses the task ID, normalized absolute path, expected branch,
Git administration directory, and a marker in `winmux-task-owner`; directory
existence or branch equality alone is insufficient for removal.
Windows identity comparison resolves existing paths so short names and junction
aliases match the same Git worktree without bypassing its ownership marker.
Use argument
arrays for Windows `git` and `wsl.exe --exec git`, with prompt access disabled
and bounded output/timeouts. Never delete or overwrite a worktree through a raw
shell fallback after an ownership or cleanliness rejection.

`task.delivery.context` returns the task's branch, cwd, primary branch, and last
delivery result and review evidence. `refresh`, `submit`, and `merge` parse `origin` without embedded
credentials, verify the worktree is on its recorded branch, read the current
HEAD, and operate through authenticated `gh`. They do not stage, commit, or push.
Only one delivery operation may run per task. A successful `submit` confirms PR
identity only; it does not establish merge readiness. Refresh before presenting
readiness or attempting merge.

Delivery is fail-closed. The PR must match the task's GitHub source repository,
base branch, head branch, and exact HEAD commit. Merge additionally requires an
independent approval on that head, no requested changes, all required checks,
and a clean mergeable PR. The merge command is a merge commit with
`--match-head-commit`; never add admin, auto-merge, squash, rebase, or branch
deletion bypasses. Re-read the PR after any uncertain submit or merge response
and reconcile instead of retrying a mutation blindly.

`task.delivery.review` records an explicit local attestation after an independent
review actually completed. It requires task ID, exact current 40-hex HEAD, a
nonempty reviewer label (120 characters maximum), an evidence summary (4096
maximum), and outcome `approved` or `changes_requested`. The daemon timestamps,
validates and persists the record. It does not run a reviewer, prove a process
identity, or manufacture a GitHub approval; trusted local orchestration owns the
independence claim. A new commit invalidates previous approval. Local approval
or an eligible non-author GitHub approval may satisfy the product gate, but
local changes requests, outstanding formal changes requests and GitHub's
`REVIEW_REQUIRED` decision remain blockers. Never record approval before the
independent pass or remove required CI. Owner-selected local review may use a
zero GitHub approval count; that is a deliberate policy choice, not an admin
bypass. Exercise validation, restart retention, stale heads, requested changes,
required checks and both pre-merge rechecks in backend and delivery regressions.

`src/AgentStatus.tsx` owns both header and workspace-list presentation. Identity,
state and action remain separate; a generic task-processing caption is allowed
only for a named agent with confirmed `running` state when no tool activity is
available. Preserve unknown/waiting/ended action hiding, exit-code rules and
complete tooltips. The Electron activity fixture checks aligned icon/text
columns, the 900px width, English/Russian, six themes, generic-to-specific action
changes and sanitized captures. This UI fallback does not invent a tool event.

Task-created Claude and OMP launches receive appended system instructions that
refer to `$winmux-terminal` and the delivery RPCs. Codex receives the same bounded
text as `hookSpecificOutput.additionalContext` from its root `UserPromptSubmit`
hook, after authenticated lifecycle reporting. An optional validated task ID in
the per-launch context file takes precedence over inherited environment, including
WSL task launches through the Windows helper. Never serialize prompt or transcript
content into the daemon status request.

Codex task state uses `deliverySupport: "hooks"`: the user must enable and trust
the Winmux `UserPromptSubmit` handler in `/hooks` before entering the task request.
Do not bypass trust, approve foreign handlers, write owner config, override
`developer_instructions`, or manufacture a user turn. Unsupported or disabled
hooks are a visible delivery limitation. Non-task sessions emit no task context;
nested sessions and other events must not inject it. Other agents may still call
the RPC but are marked `deliverySupport: "unsupported"`. Agent completion is not
PR readiness, review, CI, or merge evidence.

Daemon restoration starts fresh shells without agent replay, but preserves
`WINMUX_TASK_ID` for panes in an active task workspace. Verify both Windows and
WSL after changing restore or terminal environment construction.

Exercise these checks when this contract changes:

```powershell
node --test tests/task-git.cjs tests/task-delivery.cjs tests/task-state.cjs tests/task-instructions.cjs
npm run test:cwd-agent
```

For an installed Windows Codex, set `WINMUX_CODEX_EXECUTABLE` to its absolute
native `.exe` and run `npm run test:codex-task-context`. The optional runtime test
creates a disposable Codex home, trusts only its own synthetic handlers, and
captures a request at a local HTTP fixture without model inference. It checks
that existing developer instructions and a foreign hook survive, the task text
arrives as developer context, stale shared-daemon environment is ignored, and no
turn starts before explicit fixture input. Without the executable it reports a
skip; default hosted CI does not prove installed Codex behavior.

The task Git test covers managed and imported worktrees, dirty/untracked/ignored
preservation, and real WSL when available. The delivery test mocks `gh` and
checks stale heads, reviews, checks, no-admin merge, and uncertain reconciliation.
The cwd-agent smoke covers real task creation, close/archive/reopen, retained
branches, and delivery against a disposable daemon. Add renderer/runtime evidence
when task dialogs, project lists, or status presentation change.

## Choose and run verification

Start with the narrowest meaningful existing check; broaden for affected shared
contracts and the requirements in `CONTRIBUTING.md`.

| Changed contract | Relevant check |
| --- | --- |
| TypeScript, renderer, build configuration | `npm run build` |
| PTY, RPC, CLI, persistence, recovery | `npm run test:backend` |
| File drafts, writes, Git, containment | `npm run test:workspace` |
| Live cwd, isolated launch, agent lifecycle | `npm run test:cwd-agent` |
| Agents, native Codex transport, hooks, terminal themes | `npm run test:integrations` |
| Bundled skill installation | `npm run test:skills` |
| Cookies / PowerShell profile | `npm run test:cookies` / `npm run test:profile` |
| File links/previews | `npm run test:file-preview` |
| Actual Electron UI/screenshots | `npm run test:desktop` |
| Release publisher | `node --test tests/release-workflow-regression.cjs` |
| Task Git, state, delivery unit contracts | `node --test tests/task-git.cjs tests/task-delivery.cjs tests/task-state.cjs tests/task-instructions.cjs` |
| Automation run record, reducer, drain, restart | `node --test tests/task-automation.cjs` |
| Automation launch, wait, CLI, Hermes binding | `node scripts/run-electron-node.cjs tests/automation-smoke.cjs` |

For node-pty ABI mismatch, use the Electron runner through the package commands
or `scripts/run-electron-node.cjs`; run `npm run rebuild` when required and retry
the failed check. Never transplant native addons from another Node/Electron ABI.
Documentation-only edits need syntax, command, link, and claim review; unchanged
product behavior does not require another local full runtime suite. Required CI
must still pass for the actual head.

## Isolated runtime and owner-instance safety

Workspace creation and closure publish the applied live state even when its
atomic save fails. The daemon reports `state.persistenceFailed: true`, retries
while running, and broadcasts recovery. Keep the daemon running when the warning
appears. `npm run test:backend` blocks the isolated temporary state file during
create and close and checks persisted recovery after removing the obstruction.

Choose a disposable `WINMUX_DATA_DIR` for experiments and pass it consistently to
UI, terminal CLI, and browser CLI. Do not accidentally target the default owner
daemon or stop the shared native Codex daemon for discovery. Stop task-created
sessions only, unless the user explicitly authorized a live restart.

UI closure preserves terminal processes. Daemon restart restores layout with fresh
shells; it must not replay commands or claim conversations have resumed. Before an
authorized owner restart, back up state/layout, identify the exact GUI and daemon,
close gracefully, stop that daemon explicitly, and start the verified executable.
Verify executable version, fresh PIDs, and preserved workspace/pane IDs. Preserve
capability files; never print their contents or attach them to public evidence.

Verify visible UI in actual Electron with safe fixtures, keyboard access, relevant
English/Russian strings and six themes, and the supported 900-pixel minimum width.
Sanitize paths, terminal text, credentials, cookies, and account data before public
screenshots. Use available computer-use tooling for native window interaction;
report a missing native pipe/locked desktop rather than inventing UI evidence.
For terminal pointer checks, settle the rendered box before reading `pane.screen`
and use that response's rows/cols together. Mixing an earlier grid snapshot with
a later resized box can miss a visible link on a hosted Windows desktop.

## Delivery and release gates

Use English for project-authored prose, code comments, tests, commit messages,
Issues/PRs/comments, changelogs, and release notes. Preserve product localization
and the user's chat language. Ponytail affects implementation size, not the detail
needed to explain a change.

Issues and PRs must stand alone: concrete problem/reproduction, expected behavior,
full scope, acceptance criteria, actual commands/environments/results, skipped
checks and limitations, material risks, and related work. Keep relevant type labels
aligned. Use `Closes` only when the acceptance criteria are fully satisfied.
Never push directly to main. Merge requires independent review, resolution of
blocking findings, and green required CI for the current PR head.

Integration/release candidates require the complete current CONTRIBUTING sequence:

```powershell
npm run build
npm run test:backend
npm run test:workspace
npm run test:cwd-agent
npm run test:profile
npm run test:skills
npm run test:integrations
npm run test:cookies
npm run test:file-preview
npm run test:desktop
node --test tests/release-workflow-regression.cjs
```

Hosted Windows CI lacks a WSL distribution. Its output must not be presented as
actual WSL verification; run the WSL cases locally for a release and name the distro.
Verify installed terminal/browser wrappers in isolated runtime when their contract
changes. A skill file existing on disk does not prove installed-client behavior.

Release source/version changes require an Issue/PR. With maintainer authorization,
tag the reviewed exact commit only after green main CI, then use the normal release
pipeline. Do not move existing tags or replace published assets. Verify the public
non-draft release, expected installer/portable/checksum assets, download both EXEs,
and check SHA-256 against SHA256SUMS.txt before claiming delivery. Build, packaged
runtime, published assets, owner restart, and OS notification display prove different
things. A documentation follow-up after tagging is not part of those tagged binaries.

## Detailed maintenance after updates

The canonical contributor skill lives at `skills/winmux-dev`; its local installed
copy is `C:/Users/krach/.agents/skills/winmux-dev`. It is not one of the two product-
installed operation skills. Review this skill after every relevant Winmux update,
and both bundled `winmux-terminal`/`winmux-browser` skills after product updates.

Update affected instructions in English with precise contracts and callers,
prerequisites and commands, actual observable readiness/results, limits, and
failure recovery. Preserve useful existing detail. Add lessons from demonstrated
behavior, not speculative universal rules or a transcript of the current chat.
Record which skills changed, the checks and environments, and unverified claims in
the Issue/PR. If nothing needs changing, document the review and reason.

Validate frontmatter and UI metadata, links/paths, and command names against the
current checkout; use the skill-creator quick validator when available. Obtain
independent review before merging. Back up the local installed skill before
synchronizing it from reviewed source and verify byte equality afterward. Keep
`agents/openai.yaml` English, its default prompt referencing `$winmux-dev`, and
preserve unrelated invocation/dependency settings. Installation and real catalog
discovery are distinct; if the running host does not refresh its skill catalog,
report that limitation and read the skill by path for the current task.
