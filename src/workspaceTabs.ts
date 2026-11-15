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
