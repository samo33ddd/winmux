import type { Preferences, ThemeId } from './appearance';
export type Direction = 'horizontal' | 'vertical';
export type LayoutNode = { type: 'leaf'; paneId: string } | {
  type: 'split'; id: string; direction: Direction; ratio: number; first: LayoutNode; second: LayoutNode;
};
export interface Pane {
  id: string; title: string; profileId: string; cwd: string; pid: number | null;
  status: 'running' | 'exited'; exitCode?: number; cols: number; rows: number;
  tabId?: string; agentId?: string; agentLabel?: string;
  agentState?: 'starting' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'unknown'; agentExitCode?: number;
  agentActivity?: 'thinking' | 'reading' | 'editing' | 'command' | 'searching' | 'browser' | 'delegating';
  agentPid?: number;
  agentSessionId?: string; agentUpdatedAt?: number; agentStateSince?: number;
  agentThreadId?: string; agentBinding?: 'auto' | 'explicit';
}
export interface TerminalTab { id: string; title: string; titleMode?: 'auto' | 'custom'; root: LayoutNode }
export interface Workspace { id: string; name: string; cwd: string; profileId: string; root: LayoutNode; panes: Pane[]; tabs?: TerminalTab[]; activeTabId?: string }
export interface Notice { id: string; paneId: string; workspaceId: string; title: string; body: string; createdAt: number; read: boolean }
export interface Settings extends Preferences { fontSize: number; theme: ThemeId; activeWorkspaceId?: string }
export interface Project { id: string; name: string; root: string; profileId: string; primaryBranch: string }
export interface TaskDelivery { state: string | null; code: string | null; number: number | null; url: string | null; headOid: string | null }
export interface Task { id: string; name: string; projectId: string; cwd: string; branch: string; base: string; managed: boolean; archived: boolean; workspaceId?: string; agentId?: string; phase?: string; error?: string; archiveReason?: string; deliverySupport?: string; delivery?: TaskDelivery }
export interface State { workspaces: Workspace[]; projects?: Project[]; tasks?: Task[]; notifications: Notice[]; settings: Settings }
export interface Profile {
  id: string; label: string; environment: 'windows' | 'wsl'; command: string; args: string[];
  cwd?: string; distro?: string; available?: boolean; unavailableReason?: string;
}
export interface Agent { id: string; label: string; profileId: string; environment: 'windows' | 'wsl'; available: boolean | null; command: string | null; distro?: string; hookAdapter?: string }
export interface Environment { profiles: Profile[]; agents?: Agent[]; defaultCwd: string; platform: string; capabilities?: { terminalTabs?: boolean; liveCwd?: boolean; agentLaunch?: boolean; agentStatus?: boolean; sessionAgentHooks?: boolean; nativeCodex?: boolean; ompHooks?: boolean; agentActivity?: boolean; projectTasks?: boolean; protocolVersion?: number } }
export interface Snapshot { data: string; seq: number; cols: number; rows: number }
export type BackendEvent = { type: 'state'; state: State }
  | { type: 'output'; paneId: string; data: string; seq: number }
  | { type: 'exit'; paneId: string; exitCode: number }
  | { type: 'notification'; notification: Notice }
  | { type: 'focus-pane'; paneId: string; workspaceId: string }
  | { type: 'connection-error'; message: string }
  | { type: 'browser-open'; url: string; workspaceId?: string }
  | FilePreviewEvent;
export interface FilePreviewEvent {
  type: 'file-preview'; name: string; path: string; kind: 'text' | 'image' | 'binary'; size: number;
  text?: string; dataUrl?: string; mime?: string; truncated?: boolean; workspaceId?: string; paneId?: string;
}
export interface Bridge {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  onEvent(callback: (event: BackendEvent) => void): () => void;
  openExternal(url: string): Promise<unknown>;
  pickDirectory(): Promise<string | null>;
  setWindowTheme?(colors: {background:string; foreground:string}): Promise<void>;
  writeClipboard?(text: string): Promise<void>;
  readClipboard?(): Promise<string>;
}
export function writeClipboard(text: string): Promise<void> {
  return window.winmux?.writeClipboard ? window.winmux.writeClipboard(text) : navigator.clipboard.writeText(text);
}
export function readClipboard(): Promise<string> {
  return window.winmux?.readClipboard ? window.winmux.readClipboard() : navigator.clipboard.readText();
}
declare global { interface Window { winmux?: Bridge } }
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export function bridge(): Bridge {
  if (!window.winmux) throw new Error('Нет подключения к Winmux. Откройте приложение через ярлык рабочего стола.');
  return window.winmux;
}
