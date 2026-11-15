# Project tools contract

User requirement: files, image previews, embedded browser and Git are part of the first deliverable. Backend owner: electron/workspace.cjs in the Electron main process. Renderer calls use the same preload request bridge. These services are read-only; existing terminal input can execute the commands the user enters.

## Boundary and responses

Only the exact top-level Winmux webContents and main frame may call IPC. Embedded HTTP(S) webviews have no preload, Node, terminal bridge or file bridge. Workspace identity is resolved from daemon state on every call. With `paneId`, file paths are relative to that pane's last shell-reported directory and use its profile; a pane from another workspace is rejected. Without `paneId`, the workspace startup directory/profile remain the compatibility default. Absolute paths, traversal, and symlinks escaping the selected root are rejected. Windows uses Node filesystem APIs; WSL uses python3 and Git inside the selected distribution via executable/argument arrays.

- files.list {workspaceId,paneId?,path?} -> {path,entries:[{name,path,type,size}],truncated}; directories first, up to 2000 rows, .git omitted. Size is not loaded during browsing (0); read returns actual size.
- files.read {workspaceId,paneId?,path} -> {path,kind:text|image|binary,size,text?,dataUrl?,truncated?}; images up to12MiB, text preview up to512KiB, no HTML execution.
- git.status {workspaceId,paneId?} -> {available,branch,entries:[{path,index,worktree,originalPath?}],error?}; actual porcelain status, limited to the selected root.
- git.diff {workspaceId,paneId?,path?,staged?} -> {text}; disables textconv and external diff helpers, literal pathspecs, no shell command concatenation. New untracked text is displayed as actual content with a label.
- writeClipboard(text)/readClipboard() -> native text clipboard, bound write size.

IPC rejects with a human error for malformed path, closed workspace, inaccessible files, file-too-large, Python missing, process timeout or permission failure. Git unavailable/not-a-repository uses available:false with its error for a useful empty state. No implicit retry for state mutations. File reads and Git operations are idempotent; process operations bounded to12–15s and bounded buffers. No persistence/schema migration needed for these read-only services.

## Browser

Persistent partition persist:winmux-browser, HTTP(S) only, isolated from application session. Node disabled, context isolation and sandbox enabled, no preload, no popups or automatic downloads, permissions denied by default. Navigations to file/javascript/custom protocols blocked. The browser opens the real requested site; no simulated webpage content. Developer tool use and broader permission flows are outside this initial browser surface.

## Verification

Actual service smoke test creates isolated file/image/Git fixtures and checks Windows and installed WSL, then removes only its own fixture. UI smoke should inspect file tree, image render, Git diff and a real local HTTP page with no access to window.winmux or require.
