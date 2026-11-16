# Project tools contract

Backend owner: electron/workspace.cjs in the Electron main process. Renderer calls use the existing preload request bridge. Files supports explicit text saves; Git remains read-only. Embedded pages cannot access either service.

## Boundary and responses

Only the exact top-level Winmux webContents and main frame may call IPC. Embedded HTTP(S) webviews have no preload, Node, terminal bridge or file bridge. Workspace identity is resolved from daemon state on every call. With `paneId`, file paths are relative to that pane's last shell-reported directory and use its profile; a pane from another workspace is rejected. Without `paneId`, the workspace startup directory/profile remain the compatibility default. Absolute paths, traversal, and symlinks escaping the selected root are rejected. Windows uses Node filesystem APIs; WSL uses python3 and Git inside the selected distribution via executable/argument arrays.

- files.list {workspaceId,paneId?,path?} -> {path,entries:[{name,path,type,size}],truncated}; directories first, up to 2000 rows, .git omitted. Size is not loaded during browsing (0); read returns actual size.
- files.read {workspaceId,paneId?,path} -> {path,kind:text|image|binary,size,text?,dataUrl?,truncated?}; images up to12MiB, text preview up to512KiB, no HTML execution.
- files.write {workspaceId,paneId?,path,text,expectedText} -> file content; existing complete UTF-8 text only, both strings bounded to512KiB, images/binary/invalid UTF-8 rejected. The current full text must equal expectedText before writing, so stale saves fail. Uses the same Windows/WSL root containment as reads. No implicit retry.
- git.status {workspaceId,paneId?} -> {available,branch,entries:[{path,index,worktree,originalPath?}],error?}; actual porcelain status, limited to the selected root.
- git.diff {workspaceId,paneId?,path?,staged?} -> {text}; disables textconv and external diff helpers, literal pathspecs, no shell command concatenation. New untracked text is displayed as actual content with a label.
- writeClipboard(text)/readClipboard() -> native text clipboard, bound write size.

IPC rejects with a human error for malformed path, closed workspace, inaccessible files, file-too-large, Python missing, process timeout, save conflict or permission failure. Git unavailable/not-a-repository uses available:false with its error for a useful empty state. File reads and Git operations are idempotent; process operations use timeouts and bounded buffers. No persistence/schema migration is needed. Unsaved drafts stay in renderer memory across file/tab switches; a shared save lock prevents competing editor instances. Closing an owner explicitly discards its drafts after confirmation; closing the window warns about remaining unsaved changes.

## Browser

Persistent partition persist:winmux-browser, HTTP(S) only, isolated from application session. Node disabled, context isolation and sandbox enabled, no preload, no popups or automatic downloads, permissions denied by default. Navigations to file/javascript/custom protocols blocked. The browser opens the real requested site; no simulated webpage content. Developer tool use and broader permission flows are outside this initial browser surface.

## Verification

Actual service smoke test creates isolated file/image/Git fixtures and checks Windows and installed WSL, then removes only its own fixture. UI smoke should inspect file tree, image render, Git diff and a real local HTTP page with no access to window.winmux or require.
