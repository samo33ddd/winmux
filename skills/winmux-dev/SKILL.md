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

### Terminal links and input

The topbar's empty `.workspace-tabs` area is an Electron drag region; actual tab
and toolbar buttons remain `no-drag`. Validate computed regions and, when native
Computer Use is available, measure the restored window position after a real
header drag. CDP pointer events alone do not prove native window movement. A
missing native pipe is a verification limitation, not a product pass.

Terminal pane relocation uses `pane.move {paneId,targetPaneId,side}` with four
edge positions inside one workspace. Move the existing leaf/runtime, collapse
the source layout, and remove only an empty source tab's metadata. Never call a
tab/pane disposal helper while moving. Verify IDs, PIDs, screen contents, drafts,
same-tab/cross-tab layout consistency, invalid targets and persisted restoration.
The renderer uses tab/pane headers as drag sources and a highlighted destination;
terminal body selection and native blank-header window dragging stay independent.

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

For Windows Codex session hooks, allocate pane/launch IDs before constructing the
PowerShell arguments. `validateLaunch` receives the selected daemon data directory
and pipe; per-launch `hooks/session/codex-<launchId>.json` and `.ps1` artifacts pass
that context to `agent-status.cjs --codex --context-file`. Shared app-server hooks
cannot rely on inherited terminal `WINMUX_*` variables. Never embed capability
tokens or prompt/tool arguments in those artifacts. Clean them on normal disposal
and failed launch. Preserve WSL's separate interop route and user hook trust.

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

For node-pty ABI mismatch, use the Electron runner through the package commands
or `scripts/run-electron-node.cjs`; run `npm run rebuild` when required and retry
the failed check. Never transplant native addons from another Node/Electron ABI.
Documentation-only edits need syntax, command, link, and claim review; unchanged
product behavior does not require another local full runtime suite. Required CI
must still pass for the actual head.

## Isolated runtime and owner-instance safety

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
