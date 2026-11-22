import { t, subscribeLanguage, getLanguage, dateLocale } from './i18n';
import { defaults, getPreferences, subscribePreferences, savePreferences, paletteFor } from './appearance';
import { SettingsDialog } from './SettingsDialog';
import { BrandMark } from './BrandMark';
import { AgentStatus, activityLabel, agentActionLabel, agentName } from './AgentStatus';
import { assertFilesNotSaving, getOrphanedFileDrafts, pruneFileDrafts, setFileDraft, subscribeFileDrafts } from './fileDrafts';
import { activeTab, paneIds, paneTab, selectedPane, terminalTabLabel, terminalTabs } from './workspaceTabs';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent } from 'react';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';
import { Bell, Check, ChevronDown, CircleAlert, FolderOpen, GitBranch, Globe, Keyboard, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Search, Settings2, SplitSquareHorizontal, SplitSquareVertical, TerminalSquare, X } from 'lucide-react';
import { ConfirmClose, CreateWorkspace, Modal, RenameWorkspace, profileLabel } from './Dialogs';
import { WorkspaceView } from './WorkspaceView';
import { WorkspaceTools, type ToolTab } from './WorkspaceTools';
import type { PaneDropSide, TerminalHandle } from './TerminalPane';
import { subscribePreviewError } from './previewCoordinator';
import { AttentionInbox } from './AttentionInbox';
import { attentionSections } from './attentionGrouping';
import { TaskDialog } from './TaskDialog';
import { ProjectTasks } from './ProjectTasks';
import { bridge, errorMessage, writeClipboard, type Agent, type Direction, type Environment, type Pane, type Settings, type State, type TerminalTab, type Workspace } from './types';

type Dialog = { type: 'create' } | { type: 'create-task' } | { type: 'archive-task'; taskId: string; name: string; workspaceId?: string } | { type: 'rename'; workspace: Workspace } | { type: 'settings' } | { type: 'shortcuts' } | { type: 'close-pane'; pane: Pane } | { type: 'close-tab'; workspaceId: string; tab: TerminalTab } | { type: 'close-workspace'; workspace: Workspace } | null;
type BannerError = { message: string; previewToken?: number };
type PaneDrag = { workspaceId: string; paneId: string };
const agentHooksStorageKey = 'winmux.agent-status-hooks';
function readAgentHooksPreference() {
  try { return localStorage.getItem(agentHooksStorageKey) !== 'false'; }
  catch { return true; }
}
export default function App() {
  const language = useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  const shortcuts = [ [t('Новая вкладка терминала'), 'Ctrl+T'], [t('Следующая вкладка терминала'), 'Ctrl+Tab'], [t('Предыдущая вкладка терминала'), 'Ctrl+Shift+Tab'], [t("Новое пространство"), 'Ctrl+Shift+N'], [t("Разделить слева направо"), 'Ctrl+Shift+D'], [t("Разделить сверху вниз"), 'Ctrl+Shift+E'], [t("Закрыть панель"), 'Ctrl+Shift+W'], [t("Поиск в терминале"), 'Ctrl+Shift+F'], [t("Копировать выделенное"), 'Ctrl+Shift+C'], [t("Вставить"), 'Ctrl+Shift+V'], [t("Развернуть панель"), 'Ctrl+Shift+Enter'], [t("Перейти к соседней панели"), t("Alt+стрелки")], [t("Последнее непрочитанное уведомление"), 'Ctrl+Shift+U'], [t("Настройки"), 'Ctrl+,'] ];
  const [state, setState] = useState<State | null>(null);
  useEffect(() => { if (state) pruneFileDrafts(state.workspaces); }, [state]);
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [error, setBannerError] = useState<BannerError | null>(null); const [loading, setLoading] = useState(true); const [reload, setReload] = useState(0);
  const setError = useCallback((message: string) => setBannerError(message ? { message } : null), []);
  const [activeWorkspaceId, setActiveWorkspace] = useState<string>();
  const [activePanes, setActivePanes] = useState<Record<string, string>>({});
  const [zoomed, setZoomed] = useState<Record<string, string | undefined>>({});
  const [paneDrag, setPaneDrag] = useState<PaneDrag | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null); const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [toolTab, setToolTab] = useState<ToolTab | null>(null);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [browserRequests, setBrowserRequests] = useState<Record<string, { url: string; serial: number }>>({});
  const [sidebarOpen, setSidebarOpen] = useState(true); const [working, setWorking] = useState(false);
  const [previousOutput, setPreviousOutput] = useState<{paneId:string; text:string}>();
  const historyRequest = useRef(0);
  const [agentHooks, setAgentHooks] = useState(readAgentHooksPreference);
  const [sidebarWidth,setSidebarWidth] = usePanelWidth('winmux.sidebar-width',60,56,420);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [headerMenu, setHeaderMenu] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  const [toolsWidth,setToolsWidth] = usePanelWidth('winmux.tools-width',400,280,1600);
  const [windowWidth,setWindowWidth] = useState(window.innerWidth);
  useEffect(() => { const resize=()=>setWindowWidth(window.innerWidth); window.addEventListener('resize',resize); return ()=>window.removeEventListener('resize',resize); }, []);
  const orphanedDrafts = useSyncExternalStore(subscribeFileDrafts, getOrphanedFileDrafts);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryDiscard, setRecoveryDiscard] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState('');
  const orphan = orphanedDrafts[0];
  useEffect(() => { if (!orphan) { setRecoveryOpen(false); setRecoveryDiscard(null); } }, [orphan?.key]);
  const maxToolsWidth=Math.max(280,windowWidth-(sidebarOpen?sidebarWidth+6:0)-300);
  const effectiveToolsWidth=Math.min(toolsExpanded?maxToolsWidth:toolsWidth,maxToolsWidth);
  const sidebarExpanded = sidebarOpen && sidebarWidth >= 168;
  const handles = useRef(new Map<string, TerminalHandle>());
  const focusRequest = useRef<{ workspaceId: string; paneId: string } | null>(null);
  const initializedSelection = useRef(false);
  const dragTabSwitch = useRef<string | null>(null);
  const stateRef = useRef(state); stateRef.current = state;
  const workspace = state?.workspaces.find(item => item.id === activeWorkspaceId) ?? state?.workspaces[0];
  const activePane = workspace ? selectedPane(workspace, activePanes) : undefined;
  const tabsAvailable = environment?.capabilities?.terminalTabs === true;
  const paneMoveAvailable = environment?.capabilities?.paneMove === true;
  useEffect(() => {
    if (!paneDrag) return;
    const owner = state?.workspaces.find(item => item.id === paneDrag.workspaceId);
    if (!paneMoveAvailable || !owner?.panes.some(pane => pane.id === paneDrag.paneId)) {
      dragTabSwitch.current = null;
      setPaneDrag(null);
    }
  }, [state, paneDrag, paneMoveAvailable]);
  const hooksAvailable = (environment?.capabilities?.sessionAgentHooks === true || environment?.capabilities?.projectAgentHooks === true) && environment.agents?.some(agent => agent.available);
  function supportsAgentHooks(agent?: Agent) {
    if (!agent) return false;
    return agent.hookAdapter ? environment?.capabilities?.sessionAgentHooks === true : agent.environment === 'windows' && environment?.capabilities?.projectAgentHooks === true;
  }
  const nativeCodex = environment?.capabilities?.nativeCodex === true;
  const preferences = useSyncExternalStore(subscribePreferences, getPreferences, getPreferences);
  const settings: Settings = { ...defaults, ...state?.settings, ...preferences, fontSize:state?.settings.fontSize ?? 14, theme:preferences.theme ?? state?.settings.theme ?? 'dark' };
  const current = useRef({ workspace, activePane, dialog, notificationsOpen, switcherOpen }); current.current = { workspace, activePane, dialog, notificationsOpen, switcherOpen };
  useEffect(() => {
    historyRequest.current++;
    setPreviousOutput(undefined);
  }, [activePane?.id, activePane?.hasPreviousOutput]);
  const reportError = useCallback((message: string) => setError(message), []);
  const openBrowser = useCallback((workspaceId: string, url: string) => {
    setActiveWorkspace(workspaceId); setToolTab('browser'); setNotificationsOpen(false); setDialog(null);
    setBrowserRequests(previous => ({ ...previous, [workspaceId]: { url, serial: (previous[workspaceId]?.serial ?? 0) + 1 } }));
  }, []);
  useEffect(() => subscribePreviewError(event => setBannerError(current => (
    event.type === 'set'
      ? { message:event.message, previewToken:event.token }
      : current?.previewToken === event.token ? null : current
  ))), []);
  useEffect(() => {
    if (!switcherOpen) return;
    const close = (event: Event) => {
      if (!switcherRef.current?.contains(event.target as Node)) setSwitcherOpen(false);
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('focusin', close);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('focusin', close);
    };
  }, [switcherOpen]);
  const updateAgentHooks = useCallback((value: boolean) => {
    setAgentHooks(value);
    try { localStorage.setItem(agentHooksStorageKey, String(value)); } catch { /* The session preference remains usable without storage. */ }
  }, []);
  const register = useCallback((id: string, handle: TerminalHandle | null) => { if (handle) handles.current.set(id, handle); else handles.current.delete(id); }, []);
  const focusPane = useCallback((id: string) => {
    const owner = stateRef.current?.workspaces.find(item => item.panes.some(pane => pane.id === id));
    const tab = owner && paneTab(owner, id);
    if (owner && tab) {
      setActivePanes(previous => previous[tab.id] === id ? previous : { ...previous, [tab.id]: id });
      if (tab.id !== activeTab(owner).id) void selectTerminalTab(owner.id, tab.id, id);
    }
  }, []);
  const focusTerminal = (id?: string) => { if (id) requestAnimationFrame(() => handles.current.get(id)?.focus()); };
  function endPaneDrag() {
    dragTabSwitch.current = null;
    setPaneDrag(null);
  }
  function startPaneDrag(workspaceId: string, paneId: string, event: DragEvent<HTMLElement>) {
    const owner = stateRef.current?.workspaces.find(item => item.id === workspaceId);
    if (!paneMoveAvailable || !owner?.panes.some(pane => pane.id === paneId)) {
      event.preventDefault();
      return;
    }
    dragTabSwitch.current = null;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-winmux-pane', paneId);
    setPaneDrag({ workspaceId, paneId });
  }
  function startTabDrag(workspaceId: string, tabId: string, event: DragEvent<HTMLButtonElement>) {
    const owner = stateRef.current?.workspaces.find(item => item.id === workspaceId);
    const tab = owner && terminalTabs(owner).find(item => item.id === tabId);
    const pane = owner && tab && selectedPane({ ...owner, activeTabId:tab.id }, activePanes);
    if (!pane) {
      event.preventDefault();
      return;
    }
    startPaneDrag(workspaceId, pane.id, event);
  }
  async function switchDragTab(workspaceId: string, tabId: string) {
    if (!paneMoveAvailable || paneDrag?.workspaceId !== workspaceId) return;
    const owner = stateRef.current?.workspaces.find(item => item.id === workspaceId);
    const tab = owner && terminalTabs(owner).find(item => item.id === tabId);
    if (!owner || !tab || activeTab(owner).id === tabId) return;
    const key = `${workspaceId}:${tabId}`;
    if (dragTabSwitch.current === key) return;
    dragTabSwitch.current = key;
    try {
      await bridge().call('tab.select', { workspaceId, tabId });
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      if (dragTabSwitch.current === key) dragTabSwitch.current = null;
    }
  }
  async function movePane(workspaceId: string, paneId: string, targetPaneId: string, side: PaneDropSide) {
    endPaneDrag();
    const owner = stateRef.current?.workspaces.find(item => item.id === workspaceId);
    if (!paneMoveAvailable || !owner || paneId === targetPaneId
      || !owner.panes.some(pane => pane.id === paneId)
      || !owner.panes.some(pane => pane.id === targetPaneId)) return;
    try {
      await bridge().call('pane.move', { paneId, targetPaneId, side });
      const next = await refresh();
      const movedOwner = next.workspaces.find(item => item.id === workspaceId);
      const targetTab = movedOwner && paneTab(movedOwner, targetPaneId);
      if (movedOwner && targetTab && movedOwner.panes.some(pane => pane.id === paneId)) {
        await selectTerminalTab(workspaceId, targetTab.id, paneId);
      }
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  async function updateSettings(values: Partial<Settings>) {
    try {
      const {fontSize, activeWorkspaceId, restoreHistory, ...appearance} = values;
      if (Object.keys(appearance).length) savePreferences(appearance);
      if (fontSize !== undefined || activeWorkspaceId !== undefined || restoreHistory !== undefined) await bridge().call('settings.update', {
        ...(fontSize !== undefined ? {fontSize} : {}), ...(activeWorkspaceId !== undefined ? {activeWorkspaceId} : {}), ...(restoreHistory !== undefined ? {restoreHistory} : {})
      });
    } catch (error) { setError(errorMessage(error)); }
  }
  function selectWorkspace(id: string, paneId?: string) {
    setActiveWorkspace(id); setNotificationsOpen(false);
    const target = stateRef.current?.workspaces.find(item => item.id === id);
    const pane = paneId ?? (target && selectedPane(target, activePanes)?.id);
    if (target && pane) {
      const tab = paneTab(target, pane);
      if (tab) setActivePanes(previous => ({ ...previous, [tab.id]: pane }));
      if (paneId) setZoomed(previous => ({ ...previous, [id]: undefined }));
      if (tab && tab.id !== activeTab(target).id) void selectTerminalTab(id, tab.id, pane);
      else focusTerminal(pane);
    }
    void updateSettings({ activeWorkspaceId: id });
  }
  async function selectTerminalTab(workspaceId: string, tabId: string, paneId?: string, focus = true) {
    try {
      const owner = stateRef.current?.workspaces.find(item => item.id === workspaceId);
      const tab = owner && terminalTabs(owner).find(item => item.id === tabId);
      if (!owner || !tab) return;
      if (tab.id !== activeTab(owner).id) {
        await bridge().call('tab.select', { workspaceId, tabId });
        await refresh();
      }
      setZoomed(previous => ({ ...previous, [workspaceId]: undefined }));
      if (paneId) setActivePanes(previous => ({ ...previous, [tabId]: paneId }));
      const pane = paneId ?? selectedPane({ ...owner, activeTabId: tabId }, activePanes)?.id;
      if (focus) focusTerminal(pane);
    } catch (error) { setError(errorMessage(error)); }
  }
  useEffect(() => {
    let alive = true; let receivedState = false; let unsubscribe = () => {};
    setLoading(true); setError('');
    try {
      const api = bridge();
      unsubscribe = api.onEvent(event => {
        if (!alive) return;
        if (event.type === 'state') { receivedState = true; setState(event.state); }
        else if (event.type === 'connection-error') setError(event.message);
        else if (event.type === 'browser-open') {
          const id = event.workspaceId ?? current.current.workspace?.id ?? stateRef.current?.workspaces[0]?.id;
          if (id) openBrowser(id, event.url);
          else setError(t("Сначала создайте рабочее пространство для браузера."));
        }
        else if (event.type === 'focus-pane') {
          focusRequest.current = { workspaceId: event.workspaceId, paneId: event.paneId };
          selectWorkspace(event.workspaceId, event.paneId);
          setZoomed(previous => ({ ...previous, [event.workspaceId]: undefined })); setNotificationsOpen(false); setDialog(null);
        } else if (event.type === 'notification') {
          setState(previous => previous && !previous.notifications.some(item => item.id === event.notification.id) ? { ...previous, notifications: [...previous.notifications, event.notification] } : previous);
        }
      });
      void Promise.all([api.call<State>('state'), api.call<Environment>('environment')]).then(([initial, discovered]) => {
        if (!alive) return;
        if (!receivedState) setState(initial);
        setEnvironment(discovered);
        if (!initializedSelection.current) { initializedSelection.current = true; setActiveWorkspace(focusRequest.current?.workspaceId ?? initial.settings.activeWorkspaceId ?? initial.workspaces[0]?.id); }
      }).catch(error => { if (alive) setError(errorMessage(error)); }).finally(() => { if (alive) setLoading(false); });
    } catch (error) { setError(errorMessage(error)); setLoading(false); }
    return () => { alive = false; unsubscribe(); };
  }, [reload, openBrowser]);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    const palette = paletteFor(settings.theme), root = document.documentElement;
    root.style.colorScheme = palette.scheme;
    for (const key of ['bg','surface','raised','border','text','muted','accent','selection','hover'] as const) root.style.setProperty(`--${key}`,palette[key]);
    root.style.setProperty('--sidebar',palette.surface);
    root.style.setProperty('--attention',palette.scheme === 'light' ? '#825616' : '#e6bd7b');
    root.style.setProperty('--error',palette.scheme === 'light' ? '#ab3434' : '#f1a09b');
    root.style.setProperty('--backdrop',palette.scheme === 'light' ? '#15251d44' : '#080a0b99');
    root.style.setProperty('--shadow',palette.scheme === 'light' ? '#182b2025' : '#0005');
    void bridge().setWindowTheme?.({background:palette.bg,foreground:palette.text}).catch(error => setError(errorMessage(error)));
  }, [settings.theme, settings.customThemes]);
  useEffect(() => {
    if (!state) return;
    const request = focusRequest.current;
    if (request && state.workspaces.some(item => item.id === request.workspaceId && item.panes.some(pane => pane.id === request.paneId))) { focusRequest.current = null; selectWorkspace(request.workspaceId, request.paneId); }
    if (activeWorkspaceId && !state.workspaces.some(item => item.id === activeWorkspaceId)) setActiveWorkspace(state.workspaces[0]?.id);
  }, [state, activeWorkspaceId]);
  async function refresh() { const next = await bridge().call<State>('state'); setState(next); stateRef.current = next; return next; }
  async function openTask(taskId: string) {
    try { const result = await bridge().call<Workspace>('task.open', {taskId}); await refresh(); setProjectsOpen(false); setAttentionOpen(false); selectWorkspace(result.id, result.panes[0]?.id); }
    catch(error) { setError(errorMessage(error)); }
  }
  async function launchAgent(agentId: string) {
    const agent=environment?.agents?.find(item=>item.id===agentId && item.available !== false);
    if (agent) await createTerminalTab(agent.id);
  }
  async function createTerminalTab(agentId?: string) {
    const { workspace: owner, activePane: source } = current.current;
    if (!owner || working || !tabsAvailable) return;
    setWorking(true);
    try {
      const agent = environment?.agents?.find(item => item.id === agentId && item.available !== false);
      if (agentId && !agent) return;
      const profileId = agent?.profileId ?? source?.profileId ?? owner.profileId;
      const profile = environment?.profiles.find(item => item.id === profileId);
      // A Windows path cannot serve as a WSL cwd (or cross distributions).
      const cwd = source?.profileId === profileId ? source.cwd : profile?.cwd ?? (profile?.environment === 'wsl' ? '~' : environment?.defaultCwd);
      const created = await bridge().call<TerminalTab>('tab.create', {
        workspaceId: owner.id, sourcePaneId: source?.id, profileId, cwd,
        ...(agent ? { agentId: agent.id, title: agent.label, titleMode: 'auto' as const, agentHooks: Boolean(agentHooks && supportsAgentHooks(agent)) } : {}),
      });
      const next = await refresh();
      const updated = next.workspaces.find(item => item.id === owner.id);
      const tab = updated && terminalTabs(updated).find(item => item.id === created.id);
      const pane = tab && updated?.panes.find(item => paneIds(tab.root).includes(item.id));
      if (updated && tab) { setActiveWorkspace(updated.id); await selectTerminalTab(updated.id, tab.id, pane?.id); }
    } catch(error) { setError(errorMessage(error)); } finally { setWorking(false); }
  }
  function cycleTerminalTab(backwards = false) {
    const owner = current.current.workspace;
    if (!owner || !tabsAvailable) return;
    const tabs = terminalTabs(owner), index = tabs.findIndex(tab => tab.id === activeTab(owner).id);
    const next = tabs[(index + (backwards ? -1 : 1) + tabs.length) % tabs.length];
    if (next) void selectTerminalTab(owner.id, next.id);
  }
  async function split(id: string, direction: Direction) {
    if (working) return; setWorking(true);
    try {
      const pane = await bridge().call<Pane>('pane.split', { paneId: id, direction });
      await refresh(); const owner = stateRef.current?.workspaces.find(item => item.panes.some(item => item.id === pane.id));
      if (owner) { setZoomed(previous => ({ ...previous, [owner.id]: undefined })); await selectTerminalTab(owner.id, paneTab(owner, pane.id)?.id ?? activeTab(owner).id, pane.id); }
    } catch (error) { setError(errorMessage(error)); } finally { setWorking(false); }
  }
  function closePane(id: string) { const pane = stateRef.current?.workspaces.flatMap(item => item.panes).find(item => item.id === id); if (pane) setDialog({ type: 'close-pane', pane }); }
  function toggleZoom(id: string) {
    const owner = stateRef.current?.workspaces.find(item => item.panes.some(pane => pane.id === id)); if (!owner) return;
    setZoomed(previous => ({ ...previous, [owner.id]: previous[owner.id] === id ? undefined : id })); focusPane(id); focusTerminal(id);
  }
  async function saveRatio(workspaceId: string, splitId: string, ratio: number) {
    try { await bridge().call('layout.ratio', { workspaceId, splitId, ratio }); } catch (error) { setError(errorMessage(error)); }
  }
  function navigatePane(key: string) {
    const selected = current.current.activePane; const owner = current.current.workspace; if (!selected || !owner) return;
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-pane-id]')).filter(node => owner.panes.some(pane => pane.id === node.dataset.paneId) && node.getClientRects().length);
    const origin = nodes.find(node => node.dataset.paneId === selected.id)?.getBoundingClientRect(); if (!origin) return;
    const ox = origin.x + origin.width / 2, oy = origin.y + origin.height / 2;
    const candidates = nodes.filter(node => node.dataset.paneId !== selected.id).map(node => {
      const rect = node.getBoundingClientRect(); const dx = rect.x + rect.width / 2 - ox, dy = rect.y + rect.height / 2 - oy;
      const along = key === 'ArrowRight' ? dx : key === 'ArrowLeft' ? -dx : key === 'ArrowDown' ? dy : -dy;
      const across = key === 'ArrowRight' || key === 'ArrowLeft' ? Math.abs(dy) : Math.abs(dx);
      return { id: node.dataset.paneId!, along, score: along + across * 2 };
    }).filter(item => item.along > 1).sort((a, b) => a.score - b.score);
    if (candidates[0]) { focusPane(candidates[0].id); focusTerminal(candidates[0].id); }
  }
  const actions = useRef({ split, closePane, toggleZoom, navigatePane, createTerminalTab, cycleTerminalTab, selectWorkspace }); actions.current = { split, closePane, toggleZoom, navigatePane, createTerminalTab, cycleTerminalTab, selectWorkspace };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (current.current.dialog || event.defaultPrevented || Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).some(element => element.getClientRects().length > 0)) return;
      const key = event.key.toLowerCase(); const pane = current.current.activePane;
      if (event.ctrlKey && key === ',') { event.preventDefault(); setDialog({ type: 'settings' }); return; }
      if (event.ctrlKey && !event.altKey && key === 'tab') { event.preventDefault(); actions.current.cycleTerminalTab(event.shiftKey); return; }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && key === 't') { event.preventDefault(); void actions.current.createTerminalTab(); return; }
      if (event.key === 'Escape' && current.current.switcherOpen) { event.preventDefault(); setSwitcherOpen(false); return; }
      if (event.key === 'Escape' && current.current.notificationsOpen) { event.preventDefault(); setNotificationsOpen(false); if (pane) handles.current.get(pane.id)?.focus(); return; }
      if (event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); actions.current.navigatePane(event.key); return; }
      if (!event.ctrlKey || !event.shiftKey) return;
      if (key === 'n') { event.preventDefault(); setDialog({ type: 'create' }); return; }
      if (key === 'u') {
        event.preventDefault();
        const next = stateRef.current?.notifications.filter(notice => !notice.read && stateRef.current?.workspaces.some(owner => owner.id === notice.workspaceId && owner.panes.some(item => item.id === notice.paneId))).sort((a, b) => b.createdAt - a.createdAt)[0];
        if (next) {
          actions.current.selectWorkspace(next.workspaceId, next.paneId);
          void bridge().call('notifications.read', { id: next.id }).catch(error => setError(errorMessage(error)));
        }
        return;
      }
      if (!pane || !['d', 'e', 'w', 'f', 'enter', 'c', 'v'].includes(key)) return;
      const target = event.target as HTMLElement;
      if (['c', 'v'].includes(key) && target.closest('input, textarea:not(.xterm-helper-textarea), select, [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault();
      if (key === 'd' || key === 'e') void actions.current.split(pane.id, key === 'd' ? 'horizontal' : 'vertical');
      else if (key === 'w') actions.current.closePane(pane.id);
      else if (key === 'f') handles.current.get(pane.id)?.search();
      else if (key === 'enter') actions.current.toggleZoom(pane.id);
      else if (key === 'c') void handles.current.get(pane.id)?.copy().catch(error => setError(errorMessage(error)));
      else if (key === 'v') void handles.current.get(pane.id)?.paste().catch(error => setError(errorMessage(error)));
    };
    document.addEventListener('keydown', keydown, true); return () => document.removeEventListener('keydown', keydown, true);
  }, []);
  const profiles = environment?.profiles ?? [];
  const unread = state?.notifications.filter(item => !item.read).length ?? 0;
  const attentionCount = attentionSections(state).filter(section => section.group === 'waiting' || section.group === 'failed').reduce((count, section) => count + section.entries.length, 0);
  const tabLabel = (owner: Workspace, tab: TerminalTab) => terminalTabLabel(owner, terminalTabs(owner).find(item => item.id === tab.id) ?? tab, activePanes, profiles);
  return <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-hidden'}`} style={{'--sidebar-width':`${sidebarWidth}px`,'--tools-width':`${effectiveToolsWidth}px`} as CSSProperties}>
    <aside className={`sidebar ${sidebarExpanded ? 'expanded' : 'rail'}`} data-testid="workspace-rail" aria-label={t("Рабочие пространства")}>
      <div className="sidebar-heading"><div className="sidebar-brand"><div className="wordmark"><BrandMark />{sidebarExpanded && <span>winmux</span>}</div><button className="icon-button sidebar-expand" data-testid="sidebar-expand" aria-pressed={sidebarExpanded} aria-label={sidebarExpanded ? t('Скрыть названия пространств') : t('Показать названия пространств')} title={sidebarExpanded ? t('Скрыть названия пространств') : t('Показать названия пространств')} onClick={() => setSidebarWidth(sidebarExpanded ? 60 : 240)}>{sidebarExpanded ? <PanelLeftClose /> : <PanelLeftOpen />}</button></div>{sidebarExpanded && <button className="icon-button" title={t("Новое пространство (Ctrl+Shift+N)")} aria-label={t("Новое рабочее пространство")} data-testid="new-workspace" disabled={!environment || loading} onClick={() => setDialog({ type: 'create' })}><Plus /></button>}</div>
      <nav className="workspace-list">
        {state?.workspaces.map(item => {
          const unreadWorkspace = state.notifications.some(notice => notice.workspaceId === item.id && !notice.read);
          const agents = item.panes.filter(pane => agentName(pane));
          const selected = selectedPane(item, activePanes);
          const described = agents.length ? agents : selected ? [selected] : [];
          const agentLabel = described.map(pane => [agentName(pane), activityLabel(pane), agentActionLabel(pane)].filter(Boolean).join(' · ')).join('\n');
          const summary = [item.name, profileLabel(profiles, selected?.profileId ?? item.profileId), agentLabel, t('Терминалов: {0}', item.panes.length), settings.showWorkspacePaths ? (selected?.cwd ?? item.cwd) : ''].filter(Boolean).join('\n');
          const badge = (selected && agentName(selected) ? selected : agents[0]);
          return <div key={item.id} className={`workspace-row ${workspace?.id === item.id ? 'selected' : ''}`}>
            <button className="workspace-select" data-testid="workspace-item" data-workspace-id={item.id} aria-current={workspace?.id === item.id ? 'page' : undefined} aria-label={item.name} onClick={() => { selectWorkspace(item.id); setSwitcherOpen(false); }} title={summary}>
              <span className="workspace-glyph" aria-hidden="true">{item.name.trim().charAt(0).toUpperCase() || 'W'}</span>
              <span className="sr-only">{item.name} {agentLabel}</span>
              {sidebarExpanded && <span className="workspace-copy"><span className="workspace-name"><span>{item.name}</span>{unreadWorkspace && <span className="unread-dot" aria-label={t("Есть непрочитанные уведомления")} />}</span><span className="workspace-profile"><span>{profileLabel(profiles, selected?.profileId ?? item.profileId)}</span><span className="workspace-pane-count">{item.panes.length}</span></span>{settings.showWorkspacePaths && <span className="workspace-path">{selected?.cwd ?? item.cwd}</span>}{agents.map(pane => <span key={pane.id} className="workspace-agent"><AgentStatus pane={pane} /></span>)}</span>}
              {!sidebarExpanded && badge && <span className={`rail-agent-state activity-${badge.agentState ?? 'unknown'}`} title={[agentName(badge), activityLabel(badge), agentActionLabel(badge)].filter(Boolean).join(' · ')} />}
              {!sidebarExpanded && unreadWorkspace && <span className="unread-dot rail-unread" aria-label={t("Есть непрочитанные уведомления")} />}
            </button>
            {sidebarExpanded && <button className="icon-button workspace-close" aria-label={t("Закрыть пространство {0}", item.name)} title={t("Закрыть пространство и завершить процессы")} onClick={() => setDialog({ type: 'close-workspace', workspace: item })}><X /></button>}
          </div>;
        })}
        {state && !state.workspaces.length && <p className="sidebar-empty">{sidebarExpanded ? t("Ваши проекты появятся здесь.") : '·'}</p>}
      </nav>
      <div className="sidebar-bottom">
        {!sidebarExpanded && <button className="icon-button" title={t("Новое пространство (Ctrl+Shift+N)")} aria-label={t("Новое рабочее пространство")} data-testid="new-workspace" disabled={!environment || loading} onClick={() => setDialog({ type: 'create' })}><Plus /></button>}
        <button className={`sidebar-action ${attentionOpen ? 'active' : ''}`} data-testid="attention-toggle" aria-expanded={attentionOpen} aria-label={t('Внимание')} title={t('Внимание')} onClick={() => { setNotificationsOpen(false); setProjectsOpen(false); setAttentionOpen(value => !value); }}><CircleAlert />{sidebarExpanded && <span>{t('Внимание')}</span>}{attentionCount > 0 && <span className="unread-badge" aria-label={t('{0} требуют внимания', attentionCount)}>{attentionCount}</span>}</button>
        <button className={`sidebar-action ${projectsOpen ? 'active' : ''}`} data-testid="projects-toggle" aria-expanded={projectsOpen} aria-label={t('Проекты и задачи')} title={t('Проекты и задачи')} disabled={!environment?.capabilities?.projectTasks} onClick={() => { setProjectsOpen(value => !value); setAttentionOpen(false); setNotificationsOpen(false); }}><GitBranch />{sidebarExpanded && <span>{t('Проекты и задачи')}</span>}</button>
        <button className={`sidebar-action ${notificationsOpen ? 'active' : ''}`} data-testid="notifications-toggle" aria-expanded={notificationsOpen} aria-label={t("Уведомления")} title={t("Уведомления")} onClick={() => { setAttentionOpen(false); setProjectsOpen(false); setNotificationsOpen(value => !value); }}><Bell />{sidebarExpanded && <span>{t("Уведомления")}</span>}{unread > 0 && <span className="unread-badge" aria-label={t("{0} непрочитанных", unread)}>{unread}</span>}</button>
        <button className="sidebar-action" data-testid="settings-open" aria-label={t("Настройки")} title={t("Настройки")} onClick={() => setDialog({ type: 'settings' })}><Settings2 />{sidebarExpanded && <><span>{t("Настройки")}</span><span className="shortcut-hint">Ctrl+,</span></>}</button>
        <button className="sidebar-action" aria-label={t("Горячие клавиши")} title={t("Горячие клавиши")} onClick={() => setDialog({ type: 'shortcuts' })}><Keyboard />{sidebarExpanded && <span>{t("Горячие клавиши")}</span>}</button>
      </div>
    </aside>
    {sidebarOpen && <ResizeHandle value={sidebarWidth} min={56} max={420} label={t('Ширина списка пространств')} testId="sidebar-resize" onChange={setSidebarWidth} />}
    <main className="main-content">
      <header className="topbar">
        <button className="icon-button sidebar-toggle" aria-label={sidebarOpen ? t("Скрыть боковую панель") : t("Показать боковую панель")} title={sidebarOpen ? t("Скрыть боковую панель") : t("Показать боковую панель")} onClick={() => setSidebarOpen(value => !value)}>{sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}</button>
        <div className={`project-switcher ${switcherOpen ? 'open' : ''}`} ref={switcherRef}>
          <button className="project-switch" data-testid="workspace-switcher" aria-expanded={switcherOpen} aria-haspopup="menu" disabled={!state?.workspaces.length} onClick={() => setSwitcherOpen(value => !value)} title={workspace ? t('{0}\n{1}', workspace.name, activePane?.cwd ?? workspace.cwd) : undefined}>
            <span className="header-name">{workspace?.name ?? t("Рабочее пространство")}</span>
          </button>
          {workspace && <button className="icon-button rename-workspace" aria-label={t("Переименовать пространство")} data-testid="rename-workspace" title={t("Переименовать пространство")} onClick={() => setDialog({ type: 'rename', workspace })}><Pencil /></button>}
          {switcherOpen && state && <div className="switcher-menu" role="menu">
            {state.workspaces.map(item => <button key={item.id} role="menuitem" className={workspace?.id === item.id ? 'selected' : ''} onClick={() => { selectWorkspace(item.id); setSwitcherOpen(false); }}>{item.name}</button>)}
            <button role="menuitem" data-testid="switcher-new-workspace" disabled={!environment || loading} onClick={() => { setSwitcherOpen(false); setDialog({ type: 'create' }); }}>{t("Новое рабочее пространство")}</button>
          </div>}
        </div>
        <div className="workspace-tabs" role="tablist" aria-label={t('Вкладки терминала')} onKeyDown={event=>{
          if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || !(event.target as HTMLElement).matches('[role="tab"]'))return;
          const tabs=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const index=tabs.indexOf(event.target as HTMLButtonElement), next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
          event.preventDefault(); tabs[next]?.click(); tabs[next]?.focus();
        }}>
          {workspace && terminalTabs(workspace).map(tab => {
            const label = tabLabel(workspace, tab);
            return <div key={tab.id} className={`workspace-top-tab ${activeTab(workspace).id===tab.id?'selected':''}`}>
            <button id={`terminal-tab-${tab.id}`} role="tab" aria-selected={activeTab(workspace).id===tab.id} aria-controls={`terminal-panel-${workspace.id}`} tabIndex={activeTab(workspace).id===tab.id?0:-1} data-testid="terminal-tab" data-tab-id={tab.id} data-workspace-id={workspace.id} title={label} draggable={paneMoveAvailable}
              onDragStart={event => startTabDrag(workspace.id, tab.id, event)} onDragEnter={() => void switchDragTab(workspace.id, tab.id)} onDragEnd={endPaneDrag}
              onClick={event=>void selectTerminalTab(workspace.id,tab.id,undefined,event.detail > 0)}><TerminalSquare /><span>{label}</span>{state?.notifications.some(notice => !notice.read && paneIds(tab.root).includes(notice.paneId)) && <span className="unread-dot" aria-label={t('Есть непрочитанные уведомления')} />}</button>
            <button className="icon-button" data-testid="terminal-tab-close" data-tab-id={tab.id} disabled={!tabsAvailable} aria-label={t('Закрыть вкладку {0}',label)} title={t('Закрыть вкладку и её терминалы')} onClick={()=>setDialog({type:'close-tab',workspaceId:workspace.id,tab})}><X /></button>
          </div>;
          })}
        </div>
        <div className="header-launch">
        <button className="icon-button" data-testid="new-terminal-tab" title={t('Новая вкладка терминала (Ctrl+T)')} aria-label={t('Новая вкладка терминала')} disabled={!workspace || !tabsAvailable || working || loading} onClick={()=>void createTerminalTab()}><Plus /></button>
        <div className={`header-secondary ${headerMenu ? 'open' : ''}`}>
        <select className="agent-launch-select" data-testid="launch-agent" aria-label={t('Запустить агента в новой вкладке')} title={t('Запустить агента в новой вкладке')} value="" disabled={!workspace || !tabsAvailable || working || loading} onChange={event=>void launchAgent(event.target.value)}>
          <option value="">{working?t('Открытие…'):t('Запустить агента…')}</option>
          {profiles.map(profile=><optgroup key={profile.id} label={profile.environment==='wsl'?`WSL · ${profile.label}`:profile.label}>{environment?.agents?.filter(agent=>agent.profileId===profile.id).map(agent=><option key={agent.id} value={agent.id} disabled={agent.available === false}>{agent.label}{agent.available === null ? t(' — проверка при запуске') : agent.available ? '' : t(' — не установлен')}</option>)}</optgroup>)}
        </select>
        {activePane && <div className="terminal-tab-tools" role="group" aria-label={t('Действия терминала')}>
          {activePane.hasPreviousOutput && <button className="icon-button" aria-label={t('Вывод предыдущей сессии')} title={t('Вывод предыдущей сессии')} onClick={() => { const paneId = activePane.id, request = ++historyRequest.current; void bridge().call<{text:string}>('pane.previousOutput', {paneId}).then(result => { if (request === historyRequest.current && current.current.activePane?.id === paneId && current.current.activePane.hasPreviousOutput) setPreviousOutput({paneId,text:result.text}); }).catch(error => { if (request === historyRequest.current) setError(errorMessage(error)); }); }}>↶</button>}
          <button className="icon-button" aria-label={t("Найти в активном терминале")} title={t("Поиск (Ctrl+Shift+F)")} data-testid="terminal-search" onClick={() => handles.current.get(activePane.id)?.search()}><Search /></button>
          <button className="icon-button" aria-label={t("Разделить активную панель слева направо")} title={t("Разделить слева направо (Ctrl+Shift+D)")} data-testid="split-horizontal" disabled={working} onClick={() => void split(activePane.id, 'horizontal')}><SplitSquareHorizontal /></button>
          <button className="icon-button" aria-label={t("Разделить активную панель сверху вниз")} title={t("Разделить сверху вниз (Ctrl+Shift+E)")} data-testid="split-vertical" disabled={working} onClick={() => void split(activePane.id, 'vertical')}><SplitSquareVertical /></button>
        </div>}
        </div>
        <button className="icon-button header-overflow-toggle" aria-expanded={headerMenu} aria-label={t('Действия терминала')} title={t('Действия терминала')} onClick={() => setHeaderMenu(value => !value)}><ChevronDown /></button>
        </div>
        {activePane && <span className="header-agent"><AgentStatus pane={activePane} showName /></span>}
        <div className="topbar-tools" role="group" aria-label={t('Инструменты проекта')}>
          {workspace && <><button className={`icon-button ${toolTab === 'files' ? 'active-tool' : ''}`} aria-label={t("Файлы проекта")} aria-pressed={toolTab === 'files'} title={t("Файлы проекта")} data-testid="files-toggle" onClick={() => setToolTab(value => value === 'files' ? null : 'files')}><FolderOpen /></button><button className={`icon-button ${toolTab === 'git' ? 'active-tool' : ''}`} aria-label={t("Git проекта")} aria-pressed={toolTab === 'git'} title={t("Git: изменения проекта")} data-testid="git-toggle" onClick={() => setToolTab(value => value === 'git' ? null : 'git')}><GitBranch /></button><button className={`icon-button ${toolTab === 'browser' ? 'active-tool' : ''}`} aria-label={t("Встроенный браузер")} aria-pressed={toolTab === 'browser'} title={t("Встроенный браузер")} data-testid="browser-toggle" onClick={() => setToolTab(value => value === 'browser' ? null : 'browser')}><Globe /></button></>}
          {!sidebarOpen && <><button className="icon-button" aria-label={t('Проекты и задачи')} aria-expanded={projectsOpen} disabled={!environment?.capabilities?.projectTasks} onClick={() => { setNotificationsOpen(false); setAttentionOpen(false); setProjectsOpen(value => !value); }}><GitBranch /></button><button className={`icon-button ${attentionCount ? 'has-unread' : ''}`} aria-label={t('Внимание')} aria-expanded={attentionOpen} onClick={() => { setProjectsOpen(false); setNotificationsOpen(false); setAttentionOpen(value => !value); }}><CircleAlert /></button><button className={`icon-button ${unread ? 'has-unread' : ''}`} aria-label={t("Уведомления")} onClick={() => { setProjectsOpen(false); setAttentionOpen(false); setNotificationsOpen(value => !value); }}><Bell /></button></>}
        </div>
      </header>
      {previousOutput?.text && activePane?.id === previousOutput.paneId && activePane.hasPreviousOutput && <Modal title={t('Вывод предыдущей сессии')} onClose={() => { historyRequest.current++; setPreviousOutput(undefined); }}><pre tabIndex={0} className="previous-terminal-output" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'50vh',overflow:'auto'}}>{previousOutput.text}</pre></Modal>}
      {environment && !tabsAvailable && <div className="upgrade-notice" role="status" data-testid="daemon-upgrade-notice"><CircleAlert /><p><strong>{t('Для новых вкладок и запуска агентов требуется обновление сессии.')}</strong> {t('Текущие терминалы продолжают работать. Когда будете готовы, завершите все сессии и откройте Winmux снова. Закрытие окна или перезагрузка интерфейса не обновляет фоновый процесс.')}</p></div>}
      {state?.persistenceFailed && <div className="error-banner" role="alert"><CircleAlert /><span>{t("Не удалось сохранить состояние Winmux. Повторяем запись. Не перезапускайте демон.")}</span></div>}
      {error && <div className="error-banner" role="alert"><CircleAlert /><span>{error.message}</span><button className="text-button" onClick={() => setReload(value => value + 1)}>{t("Переподключить")}</button><button className="icon-button" aria-label={t("Скрыть ошибку")} onClick={() => setError('')}><X /></button></div>}
      <div className="workbench">
      <div className="workspace-stage" aria-busy={loading || working}>
        {state?.workspaces.map(item => <WorkspaceView key={item.id} workspace={item} settings={settings} visible={workspace?.id === item.id} activePane={selectedPane(item, activePanes)?.id} zoomed={zoomed[item.id]} unreadPaneIds={state.notifications.filter(notice => !notice.read && notice.workspaceId === item.id).map(notice => notice.paneId)} register={register} onFocus={focusPane} onSplit={(id, direction) => void split(id, direction)} onClose={closePane} onZoom={toggleZoom} onRatio={saveRatio} onOpenBrowser={url => openBrowser(item.id, url)} paneMoveAvailable={paneMoveAvailable} draggingPaneId={paneDrag?.workspaceId === item.id ? paneDrag.paneId : undefined} onPaneDragStart={(paneId,event) => startPaneDrag(item.id,paneId,event)} onPaneDragEnd={endPaneDrag} onMovePane={(paneId,targetPaneId,side) => void movePane(item.id,paneId,targetPaneId,side)} onError={reportError} />)}
        {attentionOpen && <AttentionInbox state={state} onClose={() => setAttentionOpen(false)} onOpenTask={taskId => void openTask(taskId)} onSelect={(workspaceId, paneId) => { setAttentionOpen(false); selectWorkspace(workspaceId, paneId); }} />}
        {projectsOpen && <section className="notification-panel" aria-label={t('Проекты и задачи')}><div className="notification-heading"><h2>{t('Проекты и задачи')}</h2><button className="icon-button" aria-label={t('Новая задача')} onClick={() => setDialog({type:'create-task'})}><Plus /></button><button className="icon-button" aria-label={t('Закрыть')} onClick={() => setProjectsOpen(false)}><X /></button></div><div className="notification-list"><ProjectTasks projects={(state?.projects ?? []).map(project => ({ ...project, tasks:(state?.tasks ?? []).filter(task => task.projectId === project.id).map(task => ({ ...task, path:task.cwd, workspace:state?.workspaces.find(workspace => workspace.id === task.workspaceId) })) }))} onOpen={task => void openTask(task.id)} onRefresh={task => void bridge().call('task.delivery.refresh', {taskId:task.id}).catch(error => setError(errorMessage(error)))} onArchive={task => setDialog({type:'archive-task',taskId:task.id,name:task.name,workspaceId:task.workspace?.id})} /></div></section>}
        {!state?.workspaces.length && <div className="empty-state" data-testid="empty-state"><div className="empty-symbol"><BrandMark /></div><h1>{loading ? t("Подключение к Winmux") : t("Место для вашей работы")}</h1><p>{loading ? t("Получаем сессии и доступные среды…") : t("Откройте проект, запустите терминал. Разделяйте панели и держите нужные задачи рядом.")}</p>{!loading && <><button className="button primary create-first" data-testid="create-first-workspace" disabled={!environment} onClick={() => setDialog({ type: 'create' })}><Plus />{t("Новое рабочее пространство")}</button><span className="empty-shortcut">Ctrl+Shift+N</span></>}</div>}
        {notificationsOpen && <section className="notification-panel" aria-label={t("Уведомления")} data-testid="notification-panel"><div className="notification-heading"><h2>{t("Уведомления")}</h2><button className="icon-button" title={t("Прочитать все")} aria-label={t("Прочитать все уведомления")} disabled={!unread} onClick={() => void bridge().call('notifications.read').catch(error => setError(errorMessage(error)))}><Check /></button><button className="icon-button" aria-label={t("Закрыть уведомления")} onClick={() => setNotificationsOpen(false)}><X /></button></div><div className="notification-list">{state?.notifications.length ? [...state.notifications].sort((a, b) => b.createdAt - a.createdAt).map(notice => {
          const owner = state.workspaces.find(item => item.id === notice.workspaceId); const exists = owner?.panes.some(pane => pane.id === notice.paneId);
          return <button key={notice.id} className={`notification-item ${notice.read ? '' : 'unread'}`} data-testid="notification-item" onClick={() => { if (exists) selectWorkspace(notice.workspaceId, notice.paneId); void bridge().call('notifications.read', { id: notice.id }).catch(error => setError(errorMessage(error))); }}><span className="notification-title">{!notice.read && <span className="unread-dot" />}<strong>{notice.title === 'Agent completed' ? t('Агент завершил работу') : notice.title === 'Agent failed' ? t('Агент завершился с ошибкой') : notice.title}</strong>{Number.isFinite(notice.createdAt) && <time dateTime={new Date(notice.createdAt).toISOString()}>{new Date(notice.createdAt).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' })}</time>}</span>{notice.body && <span className="notification-body">{notice.body}</span>}<span className="notification-source">{owner?.name ?? t("Закрытое пространство")}{!exists ? t(" · панель закрыта") : ''}</span></button>;
        }) : <div className="notification-empty"><Bell /><p>{t("Пока тихо")}</p><span>{t("Здесь появятся уведомления ваших терминалов.")}</span></div>}</div></section>}
      </div>
      {workspace && toolTab && <ResizeHandle value={effectiveToolsWidth} min={280} max={maxToolsWidth} reverse label={t('Ширина панели инструментов')} testId="tools-resize" onChange={width=>{setToolsExpanded(false);setToolsWidth(width);}} />}
      {state?.workspaces.map(item => <WorkspaceTools key={item.id} workspace={item} activePaneId={selectedPane(item, activePanes)?.id} requestedBrowser={browserRequests[item.id]} tab={toolTab} visible={workspace?.id === item.id} expanded={toolsExpanded} onTab={setToolTab} onExpand={() => setToolsExpanded(value => !value)} onClose={() => setToolTab(null)} />)}
      </div>
    </main>

    {dialog?.type === 'create' && environment && <CreateWorkspace environment={environment} defaultAgentHooks={agentHooks} onClose={() => setDialog(null)} onCreate={async values => { const created = await bridge().call<Workspace>('workspace.create', values); await refresh(); selectWorkspace(created.id, created.panes[0]?.id); }} />}
    {dialog?.type === 'create-task' && environment && <TaskDialog environment={environment} defaultAgentHooks={agentHooks} onClose={() => setDialog(null)} onInspect={values => bridge().call('project.inspect', {...values})} onCreate={async values => { const created = await bridge().call<Workspace>('task.create', {...values}); await refresh(); setProjectsOpen(false); selectWorkspace(created.id, created.panes[0]?.id); }} />}
    {dialog?.type === 'archive-task' && <ConfirmClose title={t('Архивировать задачу {0}?',dialog.name)} description={t('Терминалы задачи будут остановлены. Несохранённые изменения файлов будут потеряны. Чистое рабочее дерево, созданное Winmux, будет удалено; ветка сохранится.')} onClose={() => setDialog(null)} onConfirm={async () => { if (dialog.workspaceId) { const owner = stateRef.current?.workspaces.find(item => item.id === dialog.workspaceId); if (owner) { assertFilesNotSaving(owner.panes.map(pane => pane.id)); await bridge().call('workspace.close', {workspaceId:owner.id}); } } const result = await bridge().call<{reason?:string}>('task.archive', {taskId:dialog.taskId}); await refresh(); if (result.reason) setError(result.reason); }} />}
    {dialog?.type === 'rename' && <RenameWorkspace name={dialog.workspace.name} onClose={() => setDialog(null)} onSave={async name => { await bridge().call('workspace.rename', { workspaceId: dialog.workspace.id, name }); }} />}
    {dialog?.type === 'close-pane' && <ConfirmClose title={t("Закрыть терминал?")} description={t('Несохранённые изменения файлов будут потеряны.') + ' ' + t("Панель «{0}» будет закрыта. {1}", dialog.pane.title, dialog.pane.status === 'running' ? t("Запущенный процесс и его дочерние процессы будут завершены. Несохранённая работа может быть потеряна.") : t("Процесс уже завершён."))} onClose={() => setDialog(null)} onConfirm={async () => { assertFilesNotSaving([dialog.pane.id]); await bridge().call('pane.close', { paneId: dialog.pane.id }); }} />}
    {dialog?.type === 'close-tab' && <ConfirmClose title={t('Закрыть вкладку терминала?')} description={t('Несохранённые изменения файлов будут потеряны.') + ' ' + t('Все терминалы вкладки «{0}» будут закрыты, их процессы — завершены. Остальные вкладки сохранятся.', (owner => owner ? tabLabel(owner, dialog.tab) : dialog.tab.title)(state?.workspaces.find(item => item.id === dialog.workspaceId)))} onClose={() => setDialog(null)} onConfirm={async () => { assertFilesNotSaving(paneIds(dialog.tab.root)); await bridge().call('tab.close', { workspaceId: dialog.workspaceId, tabId: dialog.tab.id }); await refresh(); }} />}
    {dialog?.type === 'close-workspace' && <ConfirmClose title={t("Закрыть рабочее пространство?")} description={t('Несохранённые изменения файлов будут потеряны.') + ' ' + t("Все терминалы пространства «{0}» будут закрыты, их процессы — завершены. Чтобы сохранить сессии, просто закройте окно приложения.", dialog.workspace.name)} onClose={() => setDialog(null)} onConfirm={async () => { assertFilesNotSaving(dialog.workspace.panes.map(pane => pane.id)); await bridge().call('workspace.close', { workspaceId: dialog.workspace.id }); }} />}
    {dialog?.type === 'shortcuts' && <Modal title={t("Горячие клавиши")} onClose={() => setDialog(null)}><div className="shortcut-list">{shortcuts.map(([label, key]) => <div key={key}><span>{label}</span><kbd>{key}</kbd></div>)}</div><p className="dialog-footnote">{t("Ctrl+C остаётся прерыванием процесса в терминале. Двойное нажатие на разделитель выравнивает панели.")}</p></Modal>}
    {dialog?.type === 'settings' && <SettingsDialog settings={settings} profiles={profiles} workspaces={state?.workspaces ?? []} activeWorkspaceId={workspace?.id} agentHooks={agentHooks} agentHooksAvailable={Boolean(hooksAvailable)} nativeCodex={nativeCodex} ompHooksAvailable={environment?.capabilities?.ompHooks === true} agentActivityAvailable={environment?.capabilities?.agentActivity === true} previousOutputAvailable={environment?.capabilities?.previousOutput === true} onAgentHooksChange={updateAgentHooks} onSkillStarted={async(workspaceId,paneId)=>{await refresh();selectWorkspace(workspaceId,paneId);setDialog(null);}} onChange={updateSettings} onClose={() => setDialog(null)} />}
    {orphan && !recoveryOpen && <div className="orphan-recovery-banner" data-testid="orphan-banner" role="alert">
      <span>{t('Есть несохранённые изменения в закрытых файлах.')}</span>
      <button type="button" className="button" data-testid="orphan-open" onClick={() => setRecoveryOpen(true)}>{t('Восстановить несохранённые файлы ({0})', orphanedDrafts.length)}</button>
    </div>}
    {orphan && recoveryOpen && (() => {
      const path = (() => { try { return JSON.parse(orphan.key)[3] || orphan.key; } catch { return orphan.key; } })();
      return <Modal title={t('Восстановить несохранённый файл')} onClose={() => { setRecoveryOpen(false); setRecoveryDiscard(null); setRecoveryError(''); }} busy={orphan.draft.saving}>
        <div className="form-fields">
          <p className="dialog-description">{t('Вкладка или пространство файла закрылась до сохранения. Скопируйте текст или отбросьте его.')}</p>
          <p className="orphan-path"><code>{path}</code>{orphanedDrafts.length > 1 && <span> {t('(ещё {0})', orphanedDrafts.length - 1)}</span>}</p>
          <textarea className="orphan-text" data-testid="orphan-text" rows={14} value={orphan.draft.text} onChange={event => setFileDraft(orphan.key, { ...orphan.draft, text: event.target.value })} spellCheck={false} />
          {orphan.draft.error && <p className="inline-error" role="alert">{orphan.draft.error}</p>}
          {recoveryError && <p className="inline-error" role="alert">{recoveryError}</p>}
        </div>
        <div className="modal-actions">
          <button type="button" className="button" data-testid="orphan-copy" onClick={async () => { setRecoveryError(''); try { await writeClipboard(orphan.draft.text); } catch (error) { setRecoveryError(errorMessage(error)); } }}>{t('Копировать')}</button>
          {recoveryDiscard === orphan.key
            ? <><span>{t('Отбросить без сохранения?')}</span><button type="button" className="button danger" data-testid="orphan-discard-confirm" onClick={() => { setFileDraft(orphan.key); setRecoveryDiscard(null); setRecoveryError(''); }}>{t('Отбросить')}</button><button type="button" className="button" onClick={() => setRecoveryDiscard(null)}>{t('Отмена')}</button></>
            : <button type="button" className="button danger" data-testid="orphan-discard" disabled={orphan.draft.saving} onClick={() => setRecoveryDiscard(orphan.key)}>{t('Отбросить')}</button>}
        </div>
      </Modal>;
    })()}
  </div>;
}
