---
name: winmux-terminal
description: Control persistent Windows terminal workspaces.
version: 0.1.0
author: samo33ddd, Hermes Agent
license: UNLICENSED
platforms: [windows, linux]
metadata:
  hermes:
    tags: [winmux, terminal, windows, agents]
    related_skills: [winmux-browser]
---

# Winmux Terminal Skill

Control Winmux workspaces and persistent shell sessions. A skill installed from Winmux connects to the existing Winmux instance that installed it. A copy used from a source checkout still supports the repository command shown below.

## When to Use

- Inspect or create Winmux terminal workspaces, split panes, send input, read screens, or deliver notifications.
- Reconnect to an existing terminal session after closing the desktop window.
- Do not use this workflow to automate embedded pages or infer agent thinking, approval, or completion state.

## Prerequisites

For an installed skill, Node.js 22.12+ must be available in the agent's environment. Windows invokes the plain-file client runtime copied into the selected Winmux data directory. WSL invokes Windows `node.exe` through interop because a Linux Node process cannot connect to Winmux's Windows named pipe. Set `WINMUX_WINDOWS_NODE` to an absolute Windows Node executable if `node.exe` is not on the WSL interop PATH.

The UI starts the daemon. The installed wrapper only connects to that existing instance and refuses `start` with a message to open the Winmux desktop. It reads the per-instance capability token at runtime; installed skill files and command text contain no token. Do not expose `ipc-token`, `ui-control.json`, or private terminal output.

## How to Run

Use the `terminal` tool with this skill's directory as `workdir`:

```text
terminal(command="node scripts/winmux-client.cjs list", workdir="WINMUX_SKILL_DIR")
terminal(command="node scripts/winmux-client.cjs environment", workdir="WINMUX_SKILL_DIR")
```

`WINMUX_SKILL_DIR` is the absolute path to the installed `winmux-terminal` skill. The relative command also works when the agent starts it from that directory even when the project itself is elsewhere. The wrapper automatically selects the Winmux data directory recorded at installation; pass `--data-dir` only when deliberately targeting another instance that the user identified.

## Quick Reference

Invoke these commands through `terminal` from `WINMUX_SKILL_DIR`. Replace `PANE_ID` and example directories with observed values; use a profile ID returned by `environment`.

```powershell
node scripts/winmux-client.cjs --help
node scripts/winmux-client.cjs list
node scripts/winmux-client.cjs environment
node scripts/winmux-client.cjs new --name AgentWork --cwd C:/path/to/project --profile powershell
node scripts/winmux-client.cjs tab WORKSPACE_ID --pane PANE_ID
node scripts/winmux-client.cjs tab WORKSPACE_ID --pane PANE_ID --agent codex
node scripts/winmux-client.cjs split PANE_ID horizontal
node scripts/winmux-client.cjs send PANE_ID "Write-Output 'WINMUX_READY'" --enter
node scripts/winmux-client.cjs key PANE_ID Enter
node scripts/winmux-client.cjs read PANE_ID
node scripts/winmux-client.cjs read PANE_ID --snapshot
node scripts/winmux-client.cjs resize PANE_ID 120 30
node scripts/winmux-client.cjs notify PANE_ID --title "Task finished" --body "Review terminal results"
```

`horizontal` means side by side; `vertical` means stacked. `key` accepts Enter, Tab, Escape, Backspace, arrows, Home, End, Delete, PageUp, PageDown, and Ctrl+A through Ctrl+Z. `read --json` returns a JSON object; plain `read` prints screen text. `notify` may omit the pane ID when the terminal supplies `WINMUX_PANE_ID`.

## Procedure

1. Open Winmux and run `list` and `environment`. Confirm the intended workspace, startup directory, environment, and pane ID. Never use the installed wrapper's `start` command; it intentionally refuses because the portable runtime has no backend.
2. Keep work for the same project in its existing workspace: `tab WORKSPACE_ID --pane PANE_ID` adds an independent terminal tab inheriting that pane's current directory. `--agent ID` launches an available catalog agent in the new tab. Use `new` for a different project and `split` for another pane in a tab. `new` returns a workspace; `tab` returns a tab with its initial root pane ID; `split` returns the new pane. Record the real IDs and verify them with `list`.
3. Read the target pane before sending input. Confirm whether the target is a shell prompt or an interactive program. Match the command syntax to that environment.
4. Send the authorized input once. `send` appends carriage return only with `--enter`; `key Enter` submits separately. For literal text beginning with `--`, put options before a `--` separator. Confirm the result with `read` before additional input.
5. Check the command's actual outcome through screen output and task-specific evidence. An accepted write, quiet terminal, or running process does not prove success. Report unresolved completion state explicitly.
6. Leave sessions running unless stopping them is part of the task. If authorized, `close PANE_ID` stops that pane; `shutdown` stops every process in the selected daemon. Verify only the intended sessions were closed.

## Pitfalls

- Closing the desktop or CLI leaves the daemon's terminals alive. A daemon restart or reboot restores metadata and fresh shells; it never replays commands or resumes agent conversations.
- Windows paths and Linux paths are different. For WSL, use a discovered `wsl:<distribution>` profile and a valid Linux directory. Windows-side WSL launch is not proof of Windows CLI interop from inside WSL.
- Installed WSL wrappers need Windows Node interop. If `node.exe` is unavailable in WSL, the wrapper reports that explicitly instead of trying the Windows named pipe from Linux.
- Environment discovery checks executable availability without launching agents. Do not advertise hooks, MCP, conversation resume, or tested agent compatibility based on discovery.
- Displayed directories are startup directories, not live shell directories.
- Screen reads are bounded terminal state, not full logs. Snapshot JSON contains VT state and ordering metadata.
- A lost response can follow a successful mutation. Neither CLI retries automatically. Inspect state and the pane before repeating input, splitting, creating, or closing.
- File and Git panels are read-only desktop tools, not daemon `rpc` methods. Browser control belongs to the separate desktop service.

## Verification

Read the affected pane and list state after an operation. Confirm the intended pane ID, observable output, and required result. For reconnect checks, compare the recorded process ID before and after UI closure without restarting the daemon. Report only what was observed; do not claim a runtime check merely because this skill was read.

The source-checkout agent guide in `docs/agents.md` contains additional quoting guidance.

For source-checkout development only, run `npm run cli -- COMMAND` from the Winmux repository root after `npm ci`. That workflow keeps using `cli.cjs`; it is not required for a skill installed by packaged Winmux.
