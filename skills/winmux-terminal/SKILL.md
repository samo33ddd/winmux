---
name: winmux-terminal
description: Control persistent Windows terminal workspaces, project tasks, and GitHub delivery.
version: 0.2.3
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

- Inspect or create Winmux terminal workspaces, projects and tasks, split panes, send input, read screens, or deliver notifications.
- Create isolated Git worktrees or attach existing linked worktrees, then inspect, refresh, submit, or merge a task PR through the delivery RPC.
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

## Projects, Tasks, and Worktrees

Project and task support requires `environment.capabilities.projectTasks`. `list`
returns `projects` and `tasks` alongside terminal state. A project is registered
when its first task is created and is grouped by the repository's Git common
directory, shell environment, and WSL distribution. Use the returned project and
task IDs; do not derive them from names or paths.

Inspect the repository before creating a task. The project directory must be an
existing absolute native path for the selected profile:

```powershell
node scripts/winmux-client.cjs rpc project.inspect '{"cwd":"C:/path/to/project","profileId":"powershell"}'
```

The result contains `root`, `commonDir`, local `branches`, a detected `primary` branch, and linked `worktrees`. Primary detection uses `origin/HEAD`, then `main` or `master`. If `primary` is empty, pass an existing local branch as `primaryBranch`. `baseBranch` must always be an existing local branch.

`task.create` currently requires an installed `agentId` that belongs to the selected profile. Inspect `environment.agents` first. Pass `agentHooks:true` to install the selected agent's status adapter before the task workspace starts; the desktop sends this preference by default. Codex and Claude use session-only hooks, while OMP, Pi and Hermes get a project-local adapter. Hermes still requires the explicit `hermes plugins enable winmux-status` step and a restart. Claude and OMP launches receive task-delivery system instructions. Codex uses a trusted Winmux `UserPromptSubmit` hook and is marked `deliverySupport: "hooks"`; other agents can still call the RPC explicitly and are marked `"unsupported"`. The command starts the task workspace and exports `WINMUX_TASK_ID` to its task-agent panes:

```powershell
node scripts/winmux-client.cjs rpc task.create '{"projectDirectory":"C:/path/to/project","name":"Issue 41","profileId":"powershell","agentId":"codex","baseBranch":"main","primaryBranch":"main","mode":"new"}'
```

Before entering a task request in Codex, open `/hooks`, select `UserPromptSubmit`,
and enable and trust the Winmux handler after reviewing its command. Winmux never
approves hook trust automatically. A disabled, untrusted, or modified handler does
not deliver task instructions. The hook adds bounded developer context to the
user's explicit turn; it neither sends a user prompt nor replaces existing
developer instructions, hooks, notify settings, model, provider, or permissions.
Per-launch context identifies the task even if a shared Codex daemon has stale
environment variables. Ordinary Codex sessions without a task emit no delivery
context. A new task launch can require a fresh hook trust decision.

For `mode: "new"`, Winmux creates a sibling worktree under
`<project-name>.winmux-worktrees/<task-id>` and a new
`winmux/<task-slug>-<short-id>` branch from `baseBranch`. For
`mode: "attach"`, pass `worktreePath` for an existing linked worktree with a
checked-out branch; the primary checkout, detached worktree, and a worktree
already attached to another task are rejected:

```powershell
node scripts/winmux-client.cjs rpc task.create '{"projectDirectory":"C:/path/to/project","name":"Existing branch","profileId":"powershell","agentId":"codex","baseBranch":"main","primaryBranch":"main","mode":"attach","worktreePath":"C:/path/to/linked-worktree"}'
```

Task creation is not transactional across Git, state, and terminal launch. If a
request loses its response, inspect `state`, the worktree, and the task's `phase`
and `error` before repeating it. `task.create` returns a workspace, not a task
record; read the new task from `list` or call `task.open` with its `taskId` when
needed. `task.open` reuses an open workspace or opens a ready task, restoring a
clean archived worktree from its retained branch.

If an interrupted attach remains in `phase: "creating"`, inspect the worktree
and archive the incomplete task before attaching it again. The old metadata
remains archived; its imported worktree and branch are retained. Ready task
records still reserve their worktree even when archived.

Close the task workspace before archiving it. Use the desktop close action when
file drafts may be unsaved: it checks drafts and pending saves. The raw
`workspace.close` RPC does not perform that desktop check and stops its panes.
After resolving drafts and confirming closure is intended:

```powershell
node scripts/winmux-client.cjs rpc task.open '{"taskId":"TASK_ID"}'
node scripts/winmux-client.cjs rpc workspace.close '{"workspaceId":"WORKSPACE_ID"}'
node scripts/winmux-client.cjs rpc task.archive '{"taskId":"TASK_ID"}'
```

Archive refuses while the task workspace or a delivery operation is active.
Winmux also preserves a worktree used by another workspace or pane. For a
Winmux-managed worktree, archive removes it only when tracked, untracked, and
ignored data are all clean; assume-unchanged and skip-worktree index flags also
block removal because they can hide changes. The branch is always retained. Imported, dirty,
locked, or ownership-conflicted worktrees remain on disk. Inspect the returned
`{archived, removed, reason}` and do not report disk cleanup when `removed` is
false.

## GitHub Delivery

The delivery RPC works only for an active, non-archived task whose
`phase` is `ready`. The task worktree must still be on its recorded branch, and
`origin` must be an HTTPS, SSH, or `git@github.com:` URL for a GitHub
`owner/repository` without embedded credentials. The environment must provide
an authenticated `gh` executable.

The delivery RPC does not stage, commit, or push. Commit the task changes and
push the task branch before submission. It reads the worktree's current branch
and HEAD commit, so a stale local commit, an unpushed branch, or a PR head from a
different commit blocks delivery.

From an ordinary client, pass `taskId`. From a task-agent pane, the CLI adds
`WINMUX_TASK_ID` when `taskId` is omitted:

```powershell
node scripts/winmux-client.cjs rpc task.delivery.context '{"taskId":"TASK_ID"}'
node scripts/winmux-client.cjs rpc task.delivery.review '{"taskId":"TASK_ID","sha":"REVIEWED_40_HEX_COMMIT","reviewer":"Independent native reviewer","summary":"Scope, findings and verification evidence.","outcome":"approved"}'
node scripts/winmux-client.cjs rpc task.delivery.refresh '{"taskId":"TASK_ID"}'
node scripts/winmux-client.cjs rpc task.delivery.submit '{"taskId":"TASK_ID","title":"fix: explain the change","body":"Problem, change, and verification."}'
node scripts/winmux-client.cjs rpc task.delivery.merge '{"taskId":"TASK_ID"}'

node scripts/winmux-client.cjs rpc task.delivery.refresh '{}'
node scripts/winmux-client.cjs rpc task.delivery.merge '{}'
```

`submit` requires `title`; `body` defaults to empty and is limited to 65,536
characters. If the exact open PR already exists, submission reconciles it
without changing its title or body. A successful `submit` confirms identity,
not review or CI readiness; call `refresh` to inspect those gates. `refresh` reads the existing PR. `merge`
uses a merge commit and only proceeds when the PR's source repository, base
branch, head branch, and current head commit match the task; an independent
review is recorded for that exact head, either through an eligible non-author
GitHub approval or the explicit local review operation below; all required
checks pass; and GitHub reports the PR mergeable and clean. The service never
uses `--admin`, auto-merge, squash, rebase, or branch deletion.

Run an independent review and resolve its findings before recording local
approval. `task.delivery.review` records an explicit attestation from an
authenticated local operator; it does not execute a reviewer, verify a process's
identity, or create a GitHub approval. Supply the reviewed 40-character commit
SHA, a nonempty reviewer label (up to 120 characters), a nonempty evidence summary
(up to 4096 characters), and `outcome: "approved"` or `"changes_requested"`.
The daemon checks the task's current HEAD and records the time itself. Review
evidence is retained across restarts and returned by `task.delivery.context`.
New commits require a fresh review; stale evidence cannot authorize their merge.
Do not attest your own implementation as independently approved.

A current local `changes_requested` result, an outstanding independent GitHub
changes request, or GitHub's `REVIEW_REQUIRED` decision still blocks delivery.
Local evidence cannot bypass a repository's formal-review policy. A sole-owner
repository may deliberately use local native review with zero required GitHub
approvals while retaining required CI; configure that only with owner direction.

Each operation returns fields such as `ok`, `action`, `code`, `blockers`,
`reconciled`, `repo`, `base`, `head`, `sha`, `number`, `url`, and `state`, and
the latest result is stored on the task. Act on `blockers` in returned order:

| Code | Meaning and recovery |
| --- | --- |
| `SOURCE_MISMATCH`, `BASE_MISMATCH`, `HEAD_MISMATCH` | The PR does not match the task's GitHub repository, primary branch, or task branch. Correct the PR/remote identity and refresh. |
| `STALE_HEAD` | The PR head commit differs from the task worktree HEAD. Determine which commit is intended; commit or push the task head or reconcile the remote deliberately, then refresh. |
| `AMBIGUOUS_PR` | Multiple exact PRs exist, or the search reached its 30-result limit. Resolve duplicates manually before refreshing. |
| `NOT_FOUND` | No matching PR was found. Push the branch and submit when the change is ready. |
| `NO_INDEPENDENT_APPROVAL` | The current head lacks valid local independent-review evidence or an eligible GitHub approval, or still requests changes. Perform independent review, resolve findings and record the current commit; honor any required formal GitHub review. |
| `CHECKS_PENDING` | Required CI is still running. Wait and refresh; do not poll by resubmitting or merging. |
| `CHECKS_FAILED` | A required check failed. Fix it, update the PR head, and obtain checks and approval for the new head. |
| `CHECKS_UNKNOWN` | Required-check state could not be established. Confirm `gh pr checks --required`, repository permissions, and network access, then refresh. |
| `MERGE_BLOCKED` | The PR is draft or closed, conflicts, is behind, or is not clean and mergeable. Resolve the reported GitHub state and refresh. |
| `UNCERTAIN_SUBMIT`, `UNCERTAIN_MERGE` | The mutation response was lost or ambiguous. Inspect GitHub and the PR before any retry; the operation reconciled when possible and is not retried automatically. |
| `UNAVAILABLE` | `gh` or GitHub could not be reached reliably. Check installation, authentication, network, and repository access, then refresh. |

RPC errors can additionally report `TASK_UNAVAILABLE`,
`TASK_BRANCH_MISMATCH`, `GITHUB_UNAVAILABLE`, or `TASK_IN_USE`. Reopen or
unarchive the task for the first, restore its recorded branch for the second,
correct `origin` for the third, and wait for the active operation to finish for
the fourth. A delivery result is evidence about a PR; it is not proof that the
agent's work is correct or complete.

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
2. Keep ordinary terminal work in its existing workspace: `tab WORKSPACE_ID --pane PANE_ID` adds an independent terminal tab inheriting that pane's current directory. `--agent ID` launches an available catalog agent in the new tab. Use `new` for an unrelated temporary workspace and `split` for another pane in a tab. Use `task.create` for an isolated project task. `new` and `task.create` return a workspace; `tab` returns a tab with its initial root pane ID; `split` returns the new pane. Record the real IDs and verify them with `list`.
3. Read the target pane before sending input. Confirm whether the target is a shell prompt or an interactive program. Match the command syntax to that environment.
4. Send the authorized input once. `send` appends carriage return only with `--enter`; `key Enter` submits separately. For literal text beginning with `--`, put options before a `--` separator. Confirm the result with `read` before additional input.
5. Check the command's actual outcome through screen output and task-specific evidence. An accepted write, quiet terminal, or running process does not prove success. Report unresolved completion state explicitly.
6. Leave sessions running unless stopping them is part of the task. If authorized, `close PANE_ID` stops that pane; `shutdown` stops every process in the selected daemon. Verify only the intended sessions were closed.

## Pitfalls

- Closing the desktop or CLI leaves the daemon's terminals alive. A daemon restart or reboot restores metadata and fresh shells; it never replays commands or resumes agent conversations.
- Workspace creation and closure can succeed in the live daemon while storage is unavailable. If `state.persistenceFailed` is `true`, keep the daemon running and resolve the disk error. The daemon retries the save and clears the warning when it succeeds. Check live state before repeating a workspace operation.
- Preserve a running portable application's extraction directory, including files under `%TEMP%`. Hooks that launch its Electron runtime can fail with `Invalid file descriptor to ICU data received` when `icudtl.dat` is missing, or a V8 startup snapshot error when snapshot files are missing. Inspect the exact hook executable and follow the matching-package recovery procedure in the source `docs/agents.md`; never delete the live extraction directory, mix runtime versions, inject a status to hide the failure, or restart the owner daemon without authorization. Confirm recovery through a real hook and pane state, not only a Node probe.
- Windows paths and Linux paths are different. For WSL, use a discovered `wsl:<distribution>` profile and a valid Linux directory. Windows-side WSL launch is not proof of Windows CLI interop from inside WSL.
- Installed WSL wrappers need Windows Node interop. If `node.exe` is unavailable in WSL, the wrapper reports that explicitly instead of trying the Windows named pipe from Linux.
- Environment discovery checks executable availability without launching agents. Do not advertise hooks, MCP, conversation resume, or tested agent compatibility based on discovery.
- `workspace.cwd` is the startup directory; `pane.cwd` follows confirmed shell directory reports. File and Git panels use the selected pane's current directory. A shell that does not report cwd retains its last confirmed directory.
- Screen reads are bounded terminal state, not full logs. Snapshot JSON contains VT state and ordering metadata.
- A lost response can follow a successful mutation. Neither CLI retries automatically. Inspect state and the pane before repeating input, splitting, creating, or closing.
- Task creation, archival, and delivery are mutations with persistence or GitHub side effects. After a timeout, reconnect and inspect `state`, `task.delivery.context`, the worktree, and GitHub before repeating the call. Project inspection and task RPCs use a 120-second timeout; delivery RPCs use 300 seconds.
- Older running daemons may lack `projectTasks` or the task methods. Preserve their terminals, finish or close the sessions deliberately, stop that daemon, and restart the updated desktop. Closing the window alone does not upgrade the daemon.
- File and Git operations belong to the desktop, not daemon `rpc` methods. Files opens a preview left of the tree, wraps text, edits complete UTF-8 files up to 512 KB, highlights known source languages and renders Markdown. Save explicitly with the button or Ctrl+S; a changed-on-disk error requires reviewing the file and using Reload, which asks before discarding a draft. Truncated, binary and image files cannot be edited. Git is read-only. Browser control belongs to its separate desktop service.
- Use `open PATH --pane PANE_ID` only for a deliberate request to preview a local file. Outputting or hovering a path never means it should be opened. Preserve spaces, Unicode, extensions and line/column references; never invent a missing file or remap its root to hide an error. A later successful open must recover from an earlier missing-file error.
- In the terminal UI, Ctrl+Click opens plain HTTP(S) and OSC 8 web links in that workspace's embedded browser; an ordinary web-link click does not navigate. Local file clicks retain their in-app preview. The browser toolbar's external-browser action remains explicit.
- Terminal RPC input is limited to 64 KiB of UTF-8 per request. The desktop chunks and serializes large pastes, preserving Unicode and bracketed-paste order. Direct CLI/RPC callers must respect request limits themselves; a failed input is never replayed automatically. Ctrl+Space can deliver NUL to terminal applications without relaxing identifier/path validation.
- Confirmed turn completion, failure and shell-observed agent exit create pane/workspace notifications. Unknown activity is not completion. An exit code is shown only for a confirmed ended launch; it is not an activity counter. If status is unavailable, inspect Settings and the relevant native connection/hook support rather than inferring activity from a running shell.
- For a confirmed running agent without a specific tool event, the header and workspace list show a generic task-processing caption. Specific action captions replace it when available; unknown, waiting and ended states show no current action. This presentation does not infer which tool is running or establish task delivery.

## Verification

Read the affected pane and list state after an operation. Confirm the intended pane ID, observable output, and required result. For task operations, verify the task's `phase`, worktree existence, branch, archive result, and delivery blockers. For reconnect checks, compare the recorded process ID before and after UI closure without restarting the daemon. Report only what was observed; do not claim a runtime check merely because this skill was read.

The source-checkout agent guide in `docs/agents.md` contains additional quoting guidance.

For source-checkout development only, run `npm run cli -- COMMAND` from the Winmux repository root after `npm ci`. That workflow keeps using `cli.cjs`; it is not required for a skill installed by packaged Winmux.
