# Winmux — product direction

Status: the initial Windows preview is implemented in this repository and is being prepared for v0.1.0. This document records the product direction and acceptance goals; it is not a report of passed tests. Consult [verification notes](../verification.md) for observed runtime results.

## The problem

Developers working with AI CLI agents need several projects, shells, and previews within reach throughout the day. Winmux brings them into a Windows terminal workspace inspired by cmux: clear pane layouts, useful notifications, and local programmatic control. Windows and WSL are the intended environments. Initial agent discovery targets are Claude Code, Codex CLI, Hermes, omp, and pi; discovery does not establish that an agent works end to end.

## Technical direction

Build an independent application around existing terminal components rather than a new ANSI/VT emulator. The current foundation is Electron and TypeScript, xterm.js, and node-pty with ConPTY for Windows processes. WSL launches through `wsl.exe` with an explicit distribution. Electron's memory and startup costs need measurement with real agent TUIs.

The original [cmux](https://github.com/manaflow-ai/cmux) and [cmux-windows](https://github.com/mkurman/cmux-windows) are reference projects, not dependencies or compatibility guarantees. Winmux is independently implemented and is not affiliated with cmux.

## User model

A workspace represents a project or task. It has a name, launch environment, startup directory, and terminal tabs. Each tab has its own pane tree; each pane owns a shell session. The sidebar switches workspaces and the horizontal tab bar switches terminals within one workspace. Notifications focus their workspace, terminal tab, and pane. Project tools provide files, Git information, and a browser alongside the terminals.

Store the launch environment explicitly as Windows or WSL with a distribution identifier. Keep executable, arguments, and startup directory separate. Windows and Linux paths are different namespaces. The Windows folder picker cannot select a Linux directory; the user enters that path for the chosen WSL profile.

## Initial preview scope

- Create, rename, and switch workspaces; persist their layouts and metadata.
- Split panes horizontally and vertically, resize dividers, move focus by keyboard, and zoom one pane.
- Run interactive shells with resizing, interruption, Unicode, alternate-screen TUIs, and scrollback.
- Search output, copy selected text automatically, paste from the clipboard, follow links, and configure font size and theme.
- Show notifications with unread state and a direct path to the relevant pane.
- Provide CLI operations for state, environment discovery, workspace creation, pane splitting, text/key input, screen reading, resizing, notifications, and explicit termination.
- Keep terminal processes in a separate daemon so the UI can detach and reconnect.
- Open real HTTP(S) pages in an embedded browser with local snapshot, click, fill, evaluate, and screenshot operations while the desktop is open.
- Show project files, text and image previews, Git branch/status, and staged or working-tree diffs. These tools are read-only.

File browsing, images, browser previews, Git inspection, and selection copying are part of the initial scope. The interface stays compact and supports English and Russian labels.

## Architecture and boundaries

The renderer uses a narrow, isolated preload bridge. A detached background process owns the PTYs. The terminal CLI connects over a local authenticated named pipe using a capability token. Browser automation has its own desktop-owned service and endpoint; it is not a `browser.*` extension to the terminal daemon. Closing the desktop removes browser automation while terminal sessions remain in the daemon.

The daemon maintains a terminal model using `@xterm/headless`. Snapshots carry a sequence number, and reconnecting clients subscribe before taking a snapshot, then apply only newer output in order. A bounded ANSI tail alone is insufficient to restore an interactive TUI. Buffers and slow clients need explicit limits; terminal output history is not persisted to disk by the daemon. See [the daemon contract](../../electron/backend/README.md).

Process state and agent state are separate. A process can be known to be running or exited. Without an explicit agent event, thinking, completion, and approval state are unknown. Silence is not completion. Executable discovery is availability information, not an agent launch profile, hook integration, or resume guarantee.

Closing the UI, losing the daemon, and rebooting Windows have different outcomes. Existing processes survive only while the daemon and operating system remain alive. After a daemon restart or reboot, saved layout and metadata restore with fresh shells. Never rerun an arbitrary previous command. Conversation resume would need a supported agent command and a saved conversation identifier; it is future work.

File and Git tools use the active terminal's profile and last directory reported through shell integration. New terminal tabs inherit that directory. Windows Git must not be used for WSL repositories. WSL project tools require `python3` and Git in the distribution. A foreground program can temporarily hide shell-directory updates; the UI must not claim knowledge of its internal directory.

Embedded pages have no Node.js access or privileged app preload. Only HTTP(S) navigation is supported; popups, downloads, and permission requests are blocked. Pages share a persistent browser session. The current automation snapshot covers a bounded set of visible main-document elements, not a complete browser accessibility tree. Windows CLI access from inside WSL requires a verified interop path and must not be advertised as proven from Windows-side WSL launching alone.

## After the core

- Layout templates such as agent + shell, two agents + tests, and agent + browser preview.
- Explicit, opt-in worktree creation for independent tasks.
- Agent adapters for notifications and conversation resume, based on verified upstream interfaces.
- Broader shell integration beyond the included PowerShell and WSL Bash tracking.
- A thin MCP client over a stable local API.
- Broader browser automation coverage and UI localization.

## Out of scope

Cloud synchronization, a mobile client, built-in AI chat or model billing, automatic task dispatch, complete tmux compatibility, and a complete copy of cmux are outside the initial preview.

## Acceptance goals

1. Launch the intended CLI tools on Windows and at least one installed WSL distribution; record each tool's actual availability and exercised behavior separately.
2. Exercise sustained output and a real interactive TUI, including resize, interruption, Unicode, copying, and multiline paste.
3. Detach and reopen the UI while a shell runs; verify the same process and a correctly restored screen without missing or duplicated output.
4. Deliver a notification to the correct pane and verify unread state. Test Windows and any claimed WSL interop route independently.
5. Create a workspace and split pane through the terminal CLI, submit input, and inspect resulting screen state.
6. Verify fresh-shell restoration after daemon restart, and clear handling of missing directories and unavailable WSL distributions.
7. Inspect real project files, images, Git status, and diffs without modifying the project through those panels.
8. Open a real page in the embedded browser, inspect it, act on returned element references, and verify the resulting state and screenshot while the desktop remains open.

The first engineering milestone is working terminal input/output and lifecycle behavior. Attractive screenshots are useful evidence of the interface, but cannot substitute for those runtime checks.
