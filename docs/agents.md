# Using Winmux with agents

Winmux exposes two local command surfaces: a persistent terminal daemon and a browser service owned by the open desktop window. These are local CLIs, not an MCP server. Supported Claude Code and modern Codex launches can add session-only status hooks. Windows Codex also supports native daemon status and project-local hook installation. Automatic conversation resume remains unsupported.

The repository ships [winmux-terminal](../skills/winmux-terminal/SKILL.md) and [winmux-browser](../skills/winmux-browser/SKILL.md). In **Settings → Skills**, choose the workspace and agent, then install these two bundled skills into that project's agent skill directory. This action does not fetch a general skills catalog or install third-party skills. Conflicting folders are preserved and reported before either skill is changed; an identical installation is left intact.

## Installed and portable builds

Installed skills include a Node.js client wrapper and connection metadata for the Winmux instance that installed them. The client files live in a versioned plain directory under the Winmux data directory, outside the packaged application archive. A Winmux source checkout and a global `winmux` command are unnecessary.

From the installed **winmux-terminal** directory, with Node.js on PATH:

```powershell
node scripts/winmux-client.cjs list
node scripts/winmux-client.cjs environment
```

From the installed **winmux-browser** directory, the wrapper uses the separate browser service:

```powershell
node scripts/winmux-client.cjs list
```

Use terminal commands below with the terminal wrapper and browser commands with the browser wrapper, preserving each command's arguments. Both wrappers are clients: open the matching Winmux desktop to start its terminal daemon, rather than using `start` from an installed skill. Browser control and local file previews require that desktop to remain open. The connection metadata contains paths, not an IPC token.

WSL installation uses the selected WSL project and runs the client through Windows Node.js interop. Windows `node.exe` must be available through WSL interop; `WINMUX_WINDOWS_NODE` can select its executable. The automated checks exercise this bridge in Ubuntu 24.04.

## Source checkout prerequisites

Use a Windows source checkout with dependencies installed (`npm ci`). Build and open the desktop with `npm run build` and `npm start` when browser control is needed. Terminal-only work can start a daemon with `npm run cli -- start`. Use the repo root as the working directory for every command below.

Set `WINMUX_DATA_DIR` consistently for the desktop, terminal CLI, and browser CLI when using an isolated instance. The default is `%LOCALAPPDATA%/Winmux/`. The terminal CLI also accepts `--data-dir DIR` and `--pipe NAME`, with `WINMUX_PIPE_NAME` as the pipe environment override. The browser CLI uses `WINMUX_DATA_DIR`; it does not accept those terminal flags.

The commands below use a source checkout. Do not assume an installed or portable executable has added a global `winmux` command to PATH.

## Terminal workflow

```powershell
npm run cli -- --help
npm run cli -- start
npm run cli -- environment
npm run cli -- list
npm run cli -- new --name AgentWork --cwd C:/path/to/project --profile powershell
```

Replace `C:/path/to/project` with an existing absolute Windows directory. Use a profile ID actually returned by `environment`. For WSL, use `wsl:<distribution>` with an existing Linux path; discovery alone does not verify the agent or the Windows CLI's availability inside WSL.

`list` returns workspaces with their pane IDs. `new` returns the created workspace; `split` returns the new pane. Use those returned IDs rather than guessing. In the following examples, replace `PANE_ID` with the intended terminal's ID:

```powershell
npm run cli -- split PANE_ID horizontal
npm run cli -- send PANE_ID "Write-Output 'WINMUX_READY'" --enter
npm run cli -- read PANE_ID
npm run cli -- read PANE_ID --snapshot
npm run cli -- key PANE_ID Ctrl+C
npm run cli -- notify PANE_ID --title "Task finished" --body "Inspect the terminal for results"
npm run cli -- open ./screenshot.png --pane PANE_ID
```

`open PATH` previews a local text or image inside the open Winmux desktop. A relative path uses the selected pane's live cwd. Pass `--pane PANE_ID`, rely on `WINMUX_PANE_ID` from a Winmux shell, or use `--workspace WORKSPACE_ID` when no pane is needed. Absolute Windows paths and local `file://` URLs are accepted. This uses the authenticated desktop UI pipe, not the daemon RPC surface; it is unavailable when only the terminal daemon is running.

Terminal links use the same preview: local path patterns, quoted paths with spaces, `file:line` references, and local `file://` links open in-app. Ctrl+Click opens plain HTTP(S) links and OSC 8 web hyperlinks in the embedded browser of that terminal's workspace; an ordinary web-link click does not navigate. The browser toolbar still offers an explicit external-browser action. The command does not install a global `winmux` executable or change Windows file associations. Text is capped at 512 KB and supported images at 12 MB; binary files show metadata only. Remote `file://` hosts and UNC paths are rejected. WSL paths run `python3` with argv-safe arguments in the pane's distribution.

The sidebar represents projects; horizontal terminal tabs stay within their workspace. Use `npm run cli -- tab WORKSPACE_ID --pane PANE_ID` to create a tab inheriting the selected pane's current directory. Add `--agent codex` (or an available catalog ID) to launch an installed agent there. `list` exposes `tabs`, `activeTabId`, and each pane's `tabId`; tab creation returns the tab with its initial leaf pane ID. The generic RPC methods `tab.select` and `tab.close` take `{workspaceId,tabId}`. Closing a tab stops only its panes.

The desktop's **Agent status hooks** option adds hooks only to that supported launch. RPC launches can set `agentHooks:true` on `workspace.create`, `tab.create`, or `pane.split`; catalog `hookAdapter` identifies supported agents. Windows session hooks require PowerShell 7.3+. Existing global/project hooks and Codex `notify` are preserved. Inspect `agentState` for confirmed hook/lifecycle events; `unknown` is intentional when activity cannot be established. A daemon restart starts fresh shells and clears current agent identity, without replaying agent commands. See [the daemon contract](../electron/backend/README.md) for the authenticated helper and compatibility details.

Windows Codex session hooks carry their exact pane and launch identities in per-launch files under the selected Winmux data directory (`hooks/session`). The shared app-server can run the hooks without inheriting the terminal's environment. The helper reads the capability token only at execution time; it does not embed it in the command or config. Normal pane disposal removes the launch files. If Codex requests hook review, inspect and trust the generated commands through its normal hooks screen; enabling the Winmux option does not bypass that review. Existing sessions need a new hook-enabled launch or a reviewed project hook; process discovery alone cannot reconstruct missing lifecycle events.

## Native Codex status and project hooks

On Windows, Winmux attaches to an already-running Codex app-server daemon through its WebSocket proxy. It never starts or stops that shared daemon, submits a turn, or answers an approval request while discovering status. The native transport was verified with Codex 0.167.0.

Winmux verifies that Codex is a descendant of a terminal's actual shell process. One such pane and one loaded root thread in the same directory can bind automatically, including threads whose source is `vscode`. Multiple candidates require an explicit thread selection under **Settings → Behavior**. Thread bindings are not restored after a Winmux daemon restart. A known Codex process remains labelled Codex when its activity cannot be established.

Native active flags distinguish running from approval/input waits. `idle` means ready for work; a turn is marked completed only after its completion event. Without a confirmed hook event, a lost connection gives unknown activity. A confirmed hook state for the same pane/session survives polling ambiguity or disconnect; a terminal completion event and a replacement session still update that state.

The **Install Codex hook** action in **Settings → Behavior** writes `.codex/hooks.json` in the selected Windows project. It merges existing handlers, backs up a changed existing config, and leaves identical installs unchanged. It copies its helper to the Winmux data directory and requires a stable system Node.js executable. Open `/hooks` in Codex and review/trust the project hook before it runs; installation does not grant trust. Other hooks, user configuration, and `notify` are preserved. Project-local hook installation is currently Windows-only; existing Claude session hooks remain available through the launch selector.

After upgrading from 0.2.0, the existing Winmux terminal daemon keeps its running sessions and older capabilities. Closing the window does not replace that daemon. Native controls show an upgrade notice until you have finished your terminal work, explicitly stopped those sessions and their Winmux daemon, and started the new version. Test instances use separate data directories and pipes.

`horizontal` places panes side by side; `vertical` stacks them. `send` sends literal terminal input and appends carriage return only with `--enter`. Input can run commands in the actual target shell or interact with an agent TUI. Inspect the pane before sending. `key` supports Enter, Tab, Escape, Backspace, arrows, Home, End, Delete, PageUp, PageDown, and Ctrl+A through Ctrl+Z. Use `--` before literal text beginning with `--`, placing options such as `--enter` before that separator.

`read` returns screen text, not a complete persistent log. `--json` returns its JSON object. `--snapshot` returns serialized VT state and its sequence number for terminal restoration. A successful input request proves input was accepted, not that a command finished. Read the result and inspect the relevant exit status or completion evidence before claiming success. Do not infer completion from silence.

`notify` can omit the pane argument when `WINMUX_PANE_ID` is present in a shell launched by Winmux. `close PANE_ID` terminates that pane's process. `shutdown` stops the daemon and all its terminal processes; it is not a routine end-of-task cleanup command for shared instances.

For lower-level calls, `rpc METHOD JSON` uses the methods documented in [the daemon contract](../electron/backend/README.md). The daemon does not forward `browser.*`, `files.*`, or `git.*` requests. The desktop Files panel supports editing eligible text files; Git remains read-only.

## Project-local OMP status extension

When the connected Winmux backend advertises `ompHooks`, **Settings → Behavior → Agent hooks** also offers OMP. For a Windows workspace, **Install OMP hook** writes `.omp/extensions/winmux-status.ts` and places its helper in the Winmux data directory. It preserves unrelated extensions and refuses to replace an unrelated file at that path. Repeat installation leaves an identical extension unchanged.

Completely restart OMP after installing the extension; Winmux does not restart it. The extension contract was checked against OMP 18.20.2. Install it in the directory where OMP starts, because ancestor-directory discovery is not guaranteed. It requires a stable system Node.js executable, and does not change models, providers, permissions, or global configuration.

The extension reports only the interactive root agent's lifecycle, asks, approvals, and bounded tool identifiers. It does not forward prompts, tool arguments, commands, or results. The shared backend must verify the process and session before accepting these records. Installing the extension alone does not add backend process detection or activate it in an already-running OMP session.

## Agent status and current action

Windows panes identify the primary Codex, Claude, OMP, Hermes, or Pi process. Nested workers do not replace the terminal's primary agent. A process proves identity only: activity stays unknown until a native Codex notification or a configured adapter reports its lifecycle.

The sidebar and pane header show the agent, state, and a short action with an icon: working on the task, reading files, editing files, running a command, searching, using a browser, or delegating. Actions use bounded tool identifiers; prompts, tool arguments, commands, and results never become status captions. A completed, failed, waiting, idle, or disconnected session hides its old action.

In **Settings → Behavior → Agent hooks**, select the Windows workspace and agent. Codex keeps its `/hooks` trust step. Claude merges `.claude/settings.local.json` without removing other hooks. OMP and Pi install discoverable project extensions; restart the selected CLI after installation. Pi's lifecycle was checked against package source 0.73.1; a live Pi installation was unavailable on the contributor host.

Hermes uses an explicitly selected user/profile plugin. Installation leaves `config.yaml` unchanged; enable `winmux-status` with the displayed command in that Hermes profile and restart Hermes. Only proven root CLI sessions are reported. When a shared Hermes gateway cannot be associated with a terminal by process ancestry, **Hermes sessions** requires an explicit session selection. Cwd alone never selects a gateway conversation. Desktop and chat-platform Hermes sessions are outside this terminal adapter's scope.

Older running Winmux daemons keep their existing sessions. New capabilities take effect after those sessions finish and the updated daemon starts; closing the window alone does not update the daemon. Agent adapters are opt-in, require a stable system Node.js executable, and do not change model, provider, or permission settings. WSL agent activity has not been verified by this Windows implementation.

## Browser workflow

Keep the desktop open and create a workspace first. `open` accepts an HTTP(S) URL without embedded credentials and an optional workspace ID. Pass `workspaceId` explicitly for deterministic targeting; omission selects the active workspace or falls back to the first workspace.

These JSON examples use **Git Bash on Windows**, or PowerShell 7.3+ with its standard native argument passing. Older Windows PowerShell can strip embedded JSON quotes; use the JavaScript API below if argument quoting fails. `WORKSPACE_ID`, `123`, and the `e0`/`e1` references are illustrative placeholders: replace them with values returned by your current session.

```sh
node scripts/browser.cjs open '{"url":"http://localhost:3000","workspaceId":"WORKSPACE_ID"}'
node scripts/browser.cjs list '{}'
node scripts/browser.cjs snapshot '{"id":123}'
node scripts/browser.cjs fill '{"id":123,"ref":"e1","value":"Hello"}'
node scripts/browser.cjs click '{"id":123,"ref":"e0"}'
node scripts/browser.cjs evaluate '{"id":123,"expression":"document.title"}'
node scripts/browser.cjs screenshot '{"id":123}'
```

Run a development server separately before opening its URL. `open` returns `{id, workspaceId, url, title}`; `list` returns `{id, url, title}` entries. Browser IDs are numeric Electron web contents IDs, not workspace IDs or terminal pane IDs. Use the returned ID in every subsequent call and verify the returned URL matches the intended page.

`snapshot` returns `{url, title, text, elements}`. Each element includes `ref`, `tag`, `name`, `type`, and `disabled`. It reads up to 40,000 characters of body text and up to 300 visible matching elements in the main document. It does not traverse iframe documents or shadow roots. References such as `e0` are assigned during a snapshot and can become stale after navigation or dynamic changes. Take a fresh snapshot before choosing an action and again after the page changes.

`click` and `fill` also accept a CSS `selector` instead of `ref`, for example `{"id":123,"selector":"#save"}` for click. The selector must match exactly one visible, enabled element. Fill requires an editable input, textarea, select, or contenteditable element and dispatches input/change events. A returned `{ok:true}` does not prove a save, navigation, or submission finished; inspect the resulting page state.

`evaluate` executes the supplied JavaScript expression in the embedded page. Prefer read-only expressions for observation; mutations can have the same effects as clicking in a signed-in browser. `screenshot` returns `{path}` pointing to a PNG under the selected data directory's `captures/` folder. It captures the embedded page, not the entire desktop application. Use an image-viewing tool to inspect that file before describing what it shows.

### JavaScript API

The browser CLI exports `request(method, params, options)`. Use a `.cjs` script in the repository root to pass structured objects without shell JSON quoting:

```javascript
const { request } = require('./scripts/browser.cjs');

(async () => {
  const pages = await request('list', {});
  if (pages.length !== 1) throw new Error('Select the intended browser ID explicitly');
  const page = pages[0];
  console.log(await request('snapshot', { id: page.id }));
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
```

Run the saved script with `node your-script.cjs`. An optional `{dataDir: 'C:/path/to/isolated-data'}` third argument selects the desktop instance. The module reads `ui-control.json` internally; callers should not print or copy its capability token.

## Failures and verification

Neither CLI automatically retries actions. A timeout or lost response can leave an action applied. After an uncertain terminal write, inspect `list` and `read`; after an uncertain browser action, inspect `list` and a fresh `snapshot` before deciding whether to retry. Repeating input or clicks blindly can run a command twice or submit a form twice.

If browser control says to open the desktop, open the matching instance and verify `WINMUX_DATA_DIR`. Starting only the terminal daemon is insufficient. If a browser target disappears, obtain a new ID with `open` or `list`. If terminal discovery reports an unavailable executable, install or configure that tool in the intended environment; do not claim that discovery launched it.

Keep completion reports tied to observations: the exact workspace/pane or browser ID, the action performed, the resulting screen or page state, and any remaining uncertainty. Store evidence only when needed and sanitize it before sharing. Never expose capability files, private terminal output, cookies, credentials, or signed-in page content in public logs.
