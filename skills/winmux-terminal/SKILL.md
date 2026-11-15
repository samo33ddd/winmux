---
name: winmux-terminal
description: Control persistent Windows terminal workspaces.
version: 0.1.0
author: samo33ddd, Hermes Agent
license: UNLICENSED
platforms: [windows]
metadata:
  hermes:
    tags: [winmux, terminal, windows, agents]
    related_skills: [winmux-browser]
---

# Winmux Terminal Skill

Control Winmux workspaces and persistent shell sessions through the repository CLI. This skill ships with Winmux; reading it does not install a local skill or provide an MCP server.

## When to Use

- Inspect or create Winmux terminal workspaces, split panes, send input, read screens, or deliver notifications.
- Reconnect to an existing terminal session after closing the desktop window.
- Do not use this workflow to automate embedded pages or infer agent thinking, approval, or completion state.

## Prerequisites

Use Windows and a Winmux source checkout with `npm ci` completed. Run commands through the agent's `terminal` tool with the repository root as `workdir`. Node.js 22.12+ and PowerShell are required; Node 24 and PowerShell 7 are recommended. An agent CLI must be installed separately in its intended Windows or WSL environment.

The UI or `npm run cli -- start` starts the daemon. Set `WINMUX_DATA_DIR` consistently when targeting an isolated instance; the default is `%LOCALAPPDATA%/Winmux/`. Do not expose `ipc-token`, `ui-control.json`, or private terminal output. These commands describe the source checkout, not a globally installed `winmux` executable.

## How to Run

Use the `terminal` tool; substitute the actual repository root for `REPO_ROOT`:

```text
terminal(command="npm run cli -- list", workdir="REPO_ROOT")
terminal(command="npm run cli -- environment", workdir="REPO_ROOT")
```

`npm run cli --` invokes the Electron-as-Node runner required for the project's runtime. Read `cli.cjs` and `electron/backend/README.md` with `read_file` if the checked-out implementation differs from this guide.

## Quick Reference

Invoke these commands through `terminal` from the repository root. Replace `PANE_ID` and example directories with observed values; use a profile ID returned by `environment`.

```powershell
npm run cli -- --help
npm run cli -- start
npm run cli -- list
npm run cli -- environment
npm run cli -- new --name AgentWork --cwd C:/path/to/project --profile powershell
npm run cli -- tab WORKSPACE_ID --pane PANE_ID
npm run cli -- tab WORKSPACE_ID --pane PANE_ID --agent codex
npm run cli -- split PANE_ID horizontal
npm run cli -- send PANE_ID "Write-Output 'WINMUX_READY'" --enter
npm run cli -- key PANE_ID Enter
npm run cli -- read PANE_ID
npm run cli -- read PANE_ID --snapshot
npm run cli -- resize PANE_ID 120 30
npm run cli -- notify PANE_ID --title "Task finished" --body "Review terminal results"
```

`horizontal` means side by side; `vertical` means stacked. `key` accepts Enter, Tab, Escape, Backspace, arrows, Home, End, Delete, PageUp, PageDown, and Ctrl+A through Ctrl+Z. `read --json` returns a JSON object; plain `read` prints screen text. `notify` may omit the pane ID when the terminal supplies `WINMUX_PANE_ID`.

## Procedure

1. Run `list` and `environment`. Confirm the intended workspace, startup directory, environment, and pane ID. Start the daemon only if needed for the task; use an isolated data directory for experiments.
2. Keep work for the same project in its existing workspace: `tab WORKSPACE_ID --pane PANE_ID` adds an independent terminal tab inheriting that pane's current directory. `--agent ID` launches an available catalog agent in the new tab. Use `new` for a different project and `split` for another pane in a tab. `new` returns a workspace; `tab` returns a tab with its initial root pane ID; `split` returns the new pane. Record the real IDs and verify them with `list`.
3. Read the target pane before sending input. Confirm whether the target is a shell prompt or an interactive program. Match the command syntax to that environment.
4. Send the authorized input once. `send` appends carriage return only with `--enter`; `key Enter` submits separately. For literal text beginning with `--`, put options before a `--` separator. Confirm the result with `read` before additional input.
5. Check the command's actual outcome through screen output and task-specific evidence. An accepted write, quiet terminal, or running process does not prove success. Report unresolved completion state explicitly.
6. Leave sessions running unless stopping them is part of the task. If authorized, `close PANE_ID` stops that pane; `shutdown` stops every process in the selected daemon. Verify only the intended sessions were closed.

## Pitfalls

- Closing the desktop or CLI leaves the daemon's terminals alive. A daemon restart or reboot restores metadata and fresh shells; it never replays commands or resumes agent conversations.
- Windows paths and Linux paths are different. For WSL, use a discovered `wsl:<distribution>` profile and a valid Linux directory. Windows-side WSL launch is not proof of Windows CLI interop from inside WSL.
- Environment discovery checks executable availability without launching agents. Do not advertise hooks, MCP, conversation resume, or tested agent compatibility based on discovery.
- Displayed directories are startup directories, not live shell directories.
- Screen reads are bounded terminal state, not full logs. Snapshot JSON contains VT state and ordering metadata.
- A lost response can follow a successful mutation. Neither CLI retries automatically. Inspect state and the pane before repeating input, splitting, creating, or closing.
- File and Git panels are read-only desktop tools, not daemon `rpc` methods. Browser control belongs to the separate desktop service.

## Verification

Read the affected pane and list state after an operation. Confirm the intended pane ID, observable output, and required result. For reconnect checks, compare the recorded process ID before and after UI closure without restarting the daemon. Report only what was observed; do not claim a runtime check merely because this skill was read.

See [the agent guide](../../docs/agents.md) for the full contract and quoting guidance.
