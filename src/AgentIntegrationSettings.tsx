import { useEffect, useState } from 'react';
import { t } from './i18n';
import { bridge } from './types';

type CodexStatus = {
  connection: 'connected' | 'disconnected';
  reason?: string;
  threads: Array<{ id: string; cwd: string; name: string; source?: unknown }>;
  panes: Array<{ paneId: string; action: string; threadId: string | null; candidates: string[] }>;
};

export function AgentIntegrationSettings() {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () => bridge().call<CodexStatus>('codex.status').then(next => { if (active) setStatus(next); }, reason => { if (active) setError(String(reason?.message || reason)); });
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const connected = status?.connection === 'connected';
  const ambiguous = status?.panes.filter(pane => pane.action === 'ambiguous') ?? [];
  async function bind(paneId: string, threadId: string) {
    setError('');
    try { await bridge().call('codex.bind', { paneId, threadId }); }
    catch (reason) { setError(String((reason as { message?: string }).message || reason)); }
  }
  return <div className="profile-settings" data-testid="codex-integration">
    <h3>{t('Codex')}</h3>
    <div className="profile-status"><span>{t('Локальный демон')}</span><span className={connected ? 'available' : 'muted'} data-testid="codex-connection">{connected ? t('Подключён') : t('Не подключён')}</span></div>
    {error && <p className="preference-intro">{error}</p>}
    {ambiguous.map(pane => <label key={pane.paneId}>{t('Выберите поток Codex')}
      <select aria-label={t('Выберите поток Codex')} data-testid={`codex-bind-${pane.paneId}`} defaultValue="" onChange={event => { if (event.target.value) void bind(pane.paneId, event.target.value); }}>
        <option value="">{t('Не выбран')}</option>
        {pane.candidates.map(id => <option key={id} value={id}>{status?.threads.find(thread => thread.id === id)?.name || id}</option>)}
      </select>
    </label>)}
  </div>;
}
