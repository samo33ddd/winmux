import type { LayoutNode, Pane, TerminalTab, Workspace } from './types';

export function paneIds(root: LayoutNode): string[] {
  return root.type === 'leaf' ? [root.paneId] : [...paneIds(root.first), ...paneIds(root.second)];
}

// Keep existing sessions usable when connected to a daemon predating terminal tabs.
export function terminalTabs(workspace: Workspace): TerminalTab[] {
  return workspace.tabs?.length ? workspace.tabs : [{ id: workspace.id, title: workspace.name, root: workspace.root }];
}

export function activeTab(workspace: Workspace): TerminalTab {
  const tabs = terminalTabs(workspace);
  return tabs.find(tab => tab.id === workspace.activeTabId) ?? tabs[0];
}

export function paneTab(workspace: Workspace, paneId: string): TerminalTab | undefined {
  return terminalTabs(workspace).find(tab => paneIds(tab.root).includes(paneId));
}

export function selectedPane(workspace: Workspace, selections: Record<string, string>): Pane | undefined {
  const tab = activeTab(workspace), ids = paneIds(tab.root);
  return workspace.panes.find(pane => pane.id === selections[tab.id] && ids.includes(pane.id))
    ?? workspace.panes.find(pane => pane.id === ids[0]);
}

function shellTitle(title: string, labels: string[]): boolean {
  return labels.some(label => {
    if (title === label) return true;
    const suffix = title.slice(label.length + 1);
    return title.startsWith(`${label} `) && /^[1-9]\d*$/.test(suffix);
  });
}

// Automatic shell names follow the live terminal title. A title supplied at creation stays put.
export function terminalTabLabel(workspace: Workspace, tab: TerminalTab, selections: Record<string, string> = {}, profiles: Array<{ id: string; label: string }> = []): string {
  const ids = paneIds(tab.root);
  const panes = ids.flatMap(id => {
    const pane = workspace.panes.find(item => item.id === id);
    return pane ? [pane] : [];
  });
  const pane = panes.find(item => item.id === selections[tab.id]) ?? panes[0];
  const live = pane?.title.trim();
  if (tab.titleMode === 'custom' || !live) return tab.title;
  if (tab.titleMode === 'auto') return live;
  const labels = ['Terminal', ...panes.flatMap(item => {
    const label = profiles.find(profile => profile.id === item.profileId)?.label;
    return label ? [label] : [];
  })];
  return shellTitle(tab.title, labels) ? live : tab.title;
}
