# Winmux first working implementation

Scope: Windows Electron desktop terminal multiplexer inspired by cmux. User explicitly requires attractive, convenient, minimal, clear UI. Real PTYs, Windows + WSL, workspace/pane tree, resize, persistence through window close, notifications and CLI. Existing product specification: docs/ideas/winmux.md.

## Shared ownership
- Backend worker: electron/backend.cjs, electron/client.cjs, cli.cjs, tests/backend-smoke.cjs only (may add backend helpers under electron/backend/). Do not edit package.json or UI/main/preload.
- UI worker: src/** and index.html only. No backend/package changes.
- Parent: package.json, configs, Electron main/preload, docs, integration and verification.

## RPC and preload contract
Renderer has window.winmux.call(method, params = {}) -> Promise<any>, window.winmux.onEvent(callback) -> unsubscribe. Electron preload exposes only these and window.winmux.openExternal(url), window.winmux.pickDirectory() -> Promise<string|null>. No Node in renderer. Backend module exports startServer({dataDir?,pipeName?}) and when run directly starts standalone daemon. client.cjs exports connect({dataDir?,pipeName?} = {}) -> Promise<client>; client.request(method,params), client.on('event', callback), client.close(). Default state under process.env.WINMUX_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Winmux'). Default authenticated current-user-specific Windows named pipe (Unix fallback allowed for tests). Electron starts daemon detached using process.execPath with ELECTRON_RUN_AS_NODE=1. All modules CJS. Backend/client importable under normal Node for tests if ABI allows.

State: {workspaces: Workspace[], notifications: Notification[], settings:{fontSize:number,theme:'dark'|'light',activeWorkspaceId?:string}}.
Workspace: {id,name,cwd,profileId,root:LayoutNode,panes:Pane[]}.
LayoutNode: {type:'leaf',paneId} | {type:'split',id,direction:'horizontal'|'vertical',ratio:number,first:LayoutNode,second:LayoutNode}. Horizontal = panes side by side; vertical = stacked.
Pane: {id,title,profileId,cwd,pid:number|null,status:'running'|'exited',exitCode?:number,cols:number,rows:number}.
Notification: {id,paneId,workspaceId,title,body,createdAt:number,read:boolean}.
Profile: {id,label,environment:'windows'|'wsl',command,args:string[],cwd?:string,distro?:string}. Baseline profile id 'powershell', WSL 'wsl:<distro>'. Agent launch profiles can be discovered optionally and clearly label unavailable commands; no fake activity or agent-thinking status.

Methods:
- state -> full State
- environment -> {profiles:Profile[], defaultCwd:string, platform:string}; discover real pwsh and WSL distros, allow missing WSL without fatal startup.
- workspace.create {name?,cwd?,profileId?} -> Workspace (starts one terminal)
- workspace.rename {workspaceId,name} -> Workspace
- workspace.close {workspaceId} -> {ok:true} (explicitly kills its processes)
- pane.split {paneId,direction,profileId?,cwd?} -> Pane
- pane.close {paneId} -> {ok:true}; remove leaf, collapse split, last pane removes workspace.
- pane.input {paneId,data} -> {ok:true}
- pane.resize {paneId,cols,rows} -> {ok:true}
- pane.snapshot {paneId} -> {data:string,seq:number,cols:number,rows:number}; serialized real headless xterm screen/scrollback. seq tracks processed chunks. Renderer buffers output until snapshot loaded, discards event.seq <= snapshot.seq, then writes remaining chunks in order. Backend must assign/broadcast seq in headless write callback, serialization happens after pending write fence, to avoid missing/duplicated output.
- pane.screen {paneId} -> {text:string,cols:number,rows:number} plain terminal screen for CLI/testing.
- layout.ratio {workspaceId,splitId,ratio} -> {ok:true}
- notify {paneId,title,body?} -> Notification
- notifications.read {id?} -> {ok:true}; missing id marks all read
- settings.update {fontSize?,theme?,activeWorkspaceId?} -> settings
- daemon.shutdown {} -> {ok:true}; explicit all-process shutdown

Events delivered as objects: {type:'state',state:State}, {type:'output',paneId,data,seq}, {type:'exit',paneId,exitCode}, {type:'notification',notification}. Full state emitted on metadata changes, not every output/resize.

## Safety and correctness
Named pipe capability token in local data dir; validate every request. Bound input/frame/output sizes and slow clients. Terminal output never HTML. OSC 9 or 777 notifications supported if practical. Save layout atomically, restore new shells after daemon restart (never replay arbitrary commands). Only start new shells if restored cwd/profile valid; surface meaningful errors. Closing UI leaves daemon alive; explicit quit-all kills it. Shell-launch args arrays only. External links http(s) only with Electron confirmation. OS process status distinct from unknown agent status.

## Initial UI direction
Operate mode, cmux-inspired native desktop density; Segoe UI for chrome, Cascadia Code for terminal. Sidebar 224px with workspaces, readable names, environment and startup directory; header 44px, pane headers 32px, quiet separators, restrained sea-green accent for selection and amber for unread attention. No mock sessions, fake output, gradients, marketing cards, or giant dead space. Native Windows window chrome. First launch shows welcome/create surface with discovered environment and directory input. Workspace creation/edit can use accessible compact dialog; terminal tools fit in toolbar; keyboard shortcuts Ctrl+Shift+D horizontal, Ctrl+Shift+E vertical, Ctrl+Shift+W close pane, Ctrl+Shift+F find, Ctrl+Shift+N new workspace, Alt+arrows focus, Ctrl+Shift+Enter zoom. Search via xterm addon; actual focus/copy/paste/links. Dark and light themes and font size control. Keep terminals mounted when switching workspace; dispose only on actual close; resize through ResizeObserver. In-app notification list with jump-to-pane. Error banner visible and dismissible, loading state honest.
