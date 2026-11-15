import { useEffect, useState } from 'react';
import { getLanguage } from './i18n';
import { bridge, errorMessage, type Workspace } from './types';

const text = (en: string, ru: string) => getLanguage() === 'ru' ? ru : en;
type Status = {
  sessions: Array<{ agentId: string; sessionId: string; cwd: string; pid: number; state: string; lastSeen: number }>;
  panes: Array<{ paneId: string; agentId: string; sessionId: string | null }>;
};

export function HermesSessionSettings({ workspaces }: { workspaces: Workspace[] }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true, loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try { const next = await bridge().call<Status>('agent.sessions'); if (active) setStatus(next); }
      catch (cause) { if (active) setError(errorMessage(cause)); }
      finally { loading = false; }
    }
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  async function bind(paneId: string, sessionId: string) {
    if (!sessionId || pending) return;
    setPending(true); setError('');
    try {
      await bridge().call('agent.bind', { paneId, sessionId });
      setStatus(await bridge().call<Status>('agent.sessions'));
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  if (!status?.panes.length && !error) return null;
  return <section className="profile-settings" data-testid="hermes-sessions">
    <h3>{text('Hermes sessions', 'Сессии Hermes')}</h3>
    <p className="preference-intro">{text('When Hermes uses a shared server, select the session for each terminal.', 'Если Hermes использует общий сервер, выберите сессию для каждой панели.')}</p>
    {!status?.sessions.length && <p className="field-hint">{text('Connect the Hermes adapter. Sessions appear here when Hermes starts working.', 'Подключите адаптер Hermes. Сессии появятся здесь, когда Hermes начнёт работу.')}</p>}
    {status?.panes.map(pane => {
      const workspace = workspaces.find(item => item.panes.some(candidate => candidate.id === pane.paneId));
      const title = workspace?.panes.find(item => item.id === pane.paneId)?.title || 'Hermes';
      return <label key={pane.paneId}>{workspace?.name} · {title}
        <select aria-label={`${text('Hermes session', 'Сессия Hermes')} ${workspace?.name || title}`} data-testid={`hermes-bind-${pane.paneId}`} value={pane.sessionId || ''} disabled={pending || !status.sessions.length} onChange={event => void bind(pane.paneId, event.target.value)}>
          <option value="">{text('Select a session', 'Выберите сессию')}</option>
          {pane.sessionId && !status.sessions.some(session => session.sessionId === pane.sessionId) && <option value={pane.sessionId}>{pane.sessionId.slice(0, 12)}</option>}
          {status.sessions.map(session => <option key={`${session.pid}:${session.sessionId}`} value={session.sessionId}>{session.cwd.split(/[\\/]/).filter(Boolean).pop()} · {session.sessionId.slice(0, 12)}</option>)}
        </select>
      </label>;
    })}
    {error && <p role="alert" className="field-hint">{error}</p>}
  </section>;
}
