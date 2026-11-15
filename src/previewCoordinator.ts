export interface PreviewIntent {
  owner: string;
  generation: number;
  visibilityEpoch: number;
}

export type PreviewErrorEvent =
  | { type: 'set'; token: number; message: string }
  | { type: 'clear'; token: number };

let nextGeneration = 0;
let nextErrorToken = 0;
let currentIntent: PreviewIntent | null = null;
let activeError: { token: number; owner: string } | null = null;
const errorListeners = new Set<(event: PreviewErrorEvent) => void>();

function notify(event: PreviewErrorEvent) {
  for (const listener of errorListeners) listener(event);
}

function clearPreviewError() {
  if (!activeError) return;
  const event: PreviewErrorEvent = { type:'clear', token:activeError.token };
  activeError = null;
  notify(event);
}

export function beginPreviewIntent(owner: string, visibilityEpoch: number): PreviewIntent {
  clearPreviewError();
  currentIntent = { owner, generation:++nextGeneration, visibilityEpoch };
  return currentIntent;
}

export function isPreviewIntentCurrent(intent: PreviewIntent, owner: string, visibilityEpoch: number) {
  return currentIntent?.generation === intent.generation
    && currentIntent.owner === owner
    && currentIntent.visibilityEpoch === visibilityEpoch;
}

export function reportPreviewError(intent: PreviewIntent, message: string) {
  if (currentIntent?.generation !== intent.generation) return false;
  const token = ++nextErrorToken;
  activeError = { token, owner:intent.owner };
  notify({ type:'set', token, message });
  return true;
}

export function previewPresented(intent?: PreviewIntent) {
  if (intent && currentIntent?.generation !== intent.generation) return false;
  currentIntent = null;
  clearPreviewError();
  return true;
}

export function invalidatePreviewOwner(owner: string) {
  if (currentIntent?.owner === owner) currentIntent = null;
  if (activeError?.owner === owner) clearPreviewError();
}

export function subscribePreviewError(listener: (event: PreviewErrorEvent) => void) {
  errorListeners.add(listener);
  return () => { errorListeners.delete(listener); };
}
