import type { Workspace } from './types';

export interface FileDraft { text: string; expectedText: string; saving?: boolean; error?: string; orphaned?: boolean }
const drafts = new Map<string, FileDraft>();
const listeners = new Set<() => void>();
export const getFileDraft = (key: string) => drafts.get(key);
export function subscribeFileDrafts(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
// Stable snapshot so useSyncExternalStore does not re-render on unrelated updates.
let orphanedSnapshot: { key: string; draft: FileDraft }[] = [];
function rebuildOrphaned() {
  orphanedSnapshot = [...drafts].filter(([, draft]) => draft.orphaned).map(([key, draft]) => ({ key, draft }));
}
function changed() { rebuildOrphaned(); for (const listener of listeners) listener(); }
export function setFileDraft(key: string, draft?: FileDraft) {
  if (draft) drafts.set(key, draft); else drafts.delete(key);
  changed();
}
export function getOrphanedFileDrafts(): { key: string; draft: FileDraft }[] { return orphanedSnapshot; }
export function hasUnsavedFiles() { return [...drafts.values()].some(draft => draft.saving || draft.text !== draft.expectedText); }
export function pruneFileDrafts(workspaces: Workspace[]) {
  let mutated = false;
  for (const [key, draft] of drafts) {
    const [workspaceId, paneId] = JSON.parse(key);
    const workspace = workspaces.find(item => item.id === workspaceId);
    const ownerMissing = !workspace || (paneId && !workspace.panes.some(pane => pane.id === paneId));
    if (!ownerMissing) continue;
    const dirty = draft.saving || draft.text !== draft.expectedText;
    if (!dirty) { drafts.delete(key); mutated = true; }
    else if (!draft.orphaned) { drafts.set(key, { ...draft, orphaned: true }); mutated = true; }
  }
  if (mutated) changed();
}
export function assertFilesNotSaving(paneIds: string[]) {
  if ([...drafts].some(([key, draft]) => draft.saving && paneIds.includes(JSON.parse(key)[1]))) throw new Error('Дождитесь сохранения файла / Wait for the file to finish saving');
}
export async function saveFileDraft(key: string, save: (draft: FileDraft) => Promise<unknown>) {
  const draft = drafts.get(key);
  if (!draft || draft.saving) return;
  const pending = { ...draft, saving: true, error: '' };
  setFileDraft(key, pending);
  try {
    await save(pending);
    if (drafts.get(key) === pending) setFileDraft(key, { text: pending.text, expectedText: pending.text, orphaned: pending.orphaned });
  } catch (error) {
    if (drafts.get(key) === pending) setFileDraft(key, { ...draft, error: error instanceof Error ? error.message : String(error) });
  }
}
