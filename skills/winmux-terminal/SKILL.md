---
name: winmux-terminal
description: Control persistent Windows terminal workspaces.
version: 0.2.2
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

The desktop also moves existing terminals by dragging their tab or pane header onto
an edge of another pane in the same workspace. Hover a destination tab while
dragging to reveal it. The highlighted half shows the destination. This preserves
the process, pane ID and output; an empty source tab is removed without closing
the moved shell. Cross-workspace and self drops are rejected. For an explicitly
requested scripted move, use `rpc pane.move` with JSON
`{"paneId":"SOURCE","targetPaneId":"TARGET","side":"right"}`; inspect IDs first
and verify the returned `workspaceId`/`tabId` and live process afterward.

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
- `workspace.cwd` is the startup directory; `pane.cwd` follows confirmed shell directory reports. File and Git panels use the selected pane's current directory. A shell that does not report cwd retains its last confirmed directory.
- Screen reads are bounded terminal state, not full logs. Snapshot JSON contains VT state and ordering metadata.
- A lost response can follow a successful mutation. Neither CLI retries automatically. Inspect state and the pane before repeating input, splitting, creating, or closing.
- File and Git operations belong to the desktop, not daemon `rpc` methods. Files opens a preview left of the tree, wraps text, edits complete UTF-8 files up to 512 KB, highlights known source languages and renders Markdown. Save explicitly with the button or Ctrl+S; a changed-on-disk error requires reviewing the file and using Reload, which asks before discarding a draft. Truncated, binary and image files cannot be edited. Git is read-only. Browser control belongs to its separate desktop service.
- Use `open PATH --pane PANE_ID` only for a deliberate request to preview a local file. Outputting or hovering a path never means it should be opened. Preserve spaces, Unicode, extensions and line/column references; never invent a missing file or remap its root to hide an error. A later successful open must recover from an earlier missing-file error.
- In the terminal UI, Ctrl+Click opens plain HTTP(S) and OSC 8 web links in that workspace's embedded browser; an ordinary web-link click does not navigate. Local file clicks retain their in-app preview. The browser toolbar's external-browser action remains explicit.
- Terminal RPC input is limited to 64 KiB of UTF-8 per request. The desktop chunks and serializes large pastes, preserving Unicode and bracketed-paste order. Direct CLI/RPC callers must respect request limits themselves; a failed input is never replayed automatically. Ctrl+Space can deliver NUL to terminal applications without relaxing identifier/path validation.
- Confirmed turn completion, failure and shell-observed agent exit create pane/workspace notifications. Unknown activity is not completion. An exit code is shown only for a confirmed ended launch; it is not an activity counter. If status is unavailable, inspect Settings and the relevant native connection/hook support rather than inferring activity from a running shell.

## Verification

Read the affected pane and list state after an operation. Confirm the intended pane ID, observable output, and required result. For reconnect checks, compare the recorded process ID before and after UI closure without restarting the daemon. Report only what was observed; do not claim a runtime check merely because this skill was read.

The source-checkout agent guide in `docs/agents.md` contains additional quoting guidance.

For source-checkout development only, run `npm run cli -- COMMAND` from the Winmux repository root after `npm ci`. That workflow keeps using `cli.cjs`; it is not required for a skill installed by packaged Winmux.
