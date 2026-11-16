import type { Pane, State, TaskDelivery } from './types';

export const attentionGroupOrder = ['waiting', 'failed', 'completed', 'active', 'idle', 'unknown'] as const;
export type AttentionGroup = (typeof attentionGroupOrder)[number];
export type AttentionState = NonNullable<Pane['agentState']>;

export interface AttentionEntry {
  workspaceId: string;
  workspaceName: string;
  paneId: string;
  title: string;
  cwd: string;
  agentName: string;
  state: AttentionState;
  group: AttentionGroup;
  updatedAt?: number;
  stateSince?: number;
  elapsedMs: number | null;
  taskName?: string;
  delivery?: TaskDelivery;
}

export interface AttentionSection {
  group: AttentionGroup;
  entries: AttentionEntry[];
}

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function confirmedState(pane: Pane): AttentionState {
  switch (pane.agentState) {
    case 'starting':
    case 'running':
    case 'waiting':
    case 'idle':
    case 'completed':
    case 'failed':
    case 'unknown':
      return pane.agentState;
    default:
      return 'unknown';
  }
}

export function attentionElapsed(stateSince: number | undefined, now: number): number | null {
  if (stateSince === undefined || !Number.isFinite(now)) return null;
  const elapsed = now - stateSince;
  return elapsed >= 0 ? elapsed : null;
}

export function attentionSections(state: Pick<State, 'workspaces'> & Partial<Pick<State, 'tasks'>> | null | undefined, now?: number): AttentionSection[] {
  const rows: Array<{ entry: AttentionEntry; order: number }> = [];
  let order = 0;
  for (const workspace of state?.workspaces ?? []) {
    for (const pane of workspace.panes ?? []) {
      const task = state?.tasks?.find(item => item.workspaceId === workspace.id && !item.archived);
      const agentName = pane.agentLabel || pane.agentId;
      if (!agentName) continue;
      const agentState = confirmedState(pane);
      const updatedAt = finite(pane.agentUpdatedAt);
      const stateSince = finite(pane.agentStateSince);
      rows.push({
        order: order++,
        entry: {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          paneId: pane.id,
          title: pane.title,
          cwd: pane.cwd,
          agentName,
          ...(task ? { taskName:task.name, delivery:task.delivery } : {}),
          state: agentState,
          group: agentState === 'starting' || agentState === 'running' ? 'active' : agentState,
          ...(updatedAt === undefined ? {} : { updatedAt }),
          ...(stateSince === undefined ? {} : { stateSince }),
          elapsedMs: attentionElapsed(stateSince, now ?? Number.NaN),
        },
      });
    }
  }
  return attentionGroupOrder.flatMap(group => {
    const entries = rows
      .filter(row => row.entry.group === group)
      .sort((a, b) => {
        const left = group === 'waiting' || group === 'failed' ? a.entry.stateSince : a.entry.updatedAt;
        const right = group === 'waiting' || group === 'failed' ? b.entry.stateSince : b.entry.updatedAt;
        if (left !== undefined && right !== undefined) return (group === 'waiting' || group === 'failed' ? left - right : right - left) || a.order - b.order;
        if (left !== undefined) return -1;
        if (right !== undefined) return 1;
        return a.order - b.order;
      })
      .map(row => row.entry);
    return entries.length ? [{ group, entries }] : [];
  });
}
