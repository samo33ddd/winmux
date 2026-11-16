import type { Workspace } from './types';

export interface FileDraft { text: string; expectedText: string; saving?: boolean; error?: string }
const drafts = new Map<string, FileDraft>();
const listeners = new Set<() => void>();
export const getFileDraft = (key: string) => drafts.get(key);
export function subscribeFileDrafts(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function changed() { for (const listener of listeners) listener(); }
export function setFileDraft(key: string, draft?: FileDraft) {
  if (draft) drafts.set(key, draft); else drafts.delete(key);
  changed();
}
export function hasUnsavedFiles() { return [...drafts.values()].some(draft => draft.saving || draft.text !== draft.expectedText); }
export function pruneFileDrafts(workspaces: Workspace[]) {
  for (const key of drafts.keys()) {
    const [workspaceId, paneId] = JSON.parse(key);
    const workspace = workspaces.find(item => item.id === workspaceId);
    if (!workspace || (paneId && !workspace.panes.some(pane => pane.id === paneId))) drafts.delete(key);
  }
  changed();
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
    if (drafts.get(key) === pending) setFileDraft(key, { text: pending.text, expectedText: pending.text });
  } catch (error) {
    if (drafts.get(key) === pending) setFileDraft(key, { ...draft, error: error instanceof Error ? error.message : String(error) });
  }
}
