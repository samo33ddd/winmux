import { useId, useRef, useState, type FormEvent } from 'react';
import { getLanguage } from './i18n';
import { bridge, errorMessage, type Workspace } from './types';

const text = (en: string, ru: string) => getLanguage() === 'ru' ? ru : en;

interface InstallResult {
  status: 'installed' | 'updated' | 'unchanged';
  agent: 'codex';
  workspaceId: string;
  paneId?: string;
  configPath: string;
  helperPath: string;
  backupPath?: string;
  requiresTrustReview: boolean;
}

export interface AgentHooksSettingsProps {
  workspaces: Workspace[];
  activeWorkspaceId?: string;
}

export function AgentHooksSettings({ workspaces, activeWorkspaceId }: AgentHooksSettingsProps) {
  const id = useId();
  const [workspaceId, setWorkspaceId] = useState(activeWorkspaceId ?? workspaces[0]?.id ?? '');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const workspace = workspaces.find(item => item.id === workspaceId)
    ?? workspaces.find(item => item.id === activeWorkspaceId) ?? workspaces[0];
  const destination = workspace ? `${workspace.cwd.replace(/[\\/]+$/, '')}${workspace.cwd.includes('\\') ? '\\' : '/'}.codex${workspace.cwd.includes('\\') ? '\\' : '/'}hooks.json` : '';

  async function install(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !workspace) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    setResult(null);
    try {
      setResult(await bridge().call<InstallResult>('agent.hooks.install', {
        workspaceId: workspace.id,
        agent: 'codex',
      }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return <section aria-labelledby={`${id}-title`} data-testid="agent-hooks-settings">
    <h3 id={`${id}-title`}>{text('Codex hooks', 'Хуки Codex')}</h3>
    <p className="preference-intro">{text(
      'Install a project-local Codex hook for this Windows workspace. Existing hook entries are kept. Codex still requires you to review and trust the hook with /hooks before it runs.',
      'Установите локальный хук Codex для этого пространства Windows. Существующие записи хуков сохраняются. Codex всё равно требует проверить и доверить хук через /hooks, прежде чем он запустится.',
    )}</p>
    <form onSubmit={install} style={{ marginTop: 16 }}>
      <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: 14 }}>
        <label htmlFor={`${id}-workspace`}>{text('Project workspace', 'Рабочее пространство проекта')}
          <select id={`${id}-workspace`} data-testid="agent-hooks-workspace" value={workspace?.id ?? ''} onChange={event => { setWorkspaceId(event.target.value); setResult(null); setError(''); }} style={{ marginTop: 6 }}>
            {!workspaces.length && <option value="">{text('Create a workspace first', 'Сначала создайте рабочее пространство')}</option>}
            {workspaces.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label htmlFor={`${id}-agent`}>{text('Agent', 'Агент')}
          <select id={`${id}-agent`} data-testid="agent-hooks-agent" value="codex" onChange={() => undefined} style={{ marginTop: 6 }}>
            <option value="codex">Codex</option>
          </select>
        </label>
        <p className="field-hint" style={{ overflowWrap: 'anywhere' }} data-testid="agent-hooks-destination">
          {text('Project hook', 'Хук проекта')}: <code>{destination || '—'}</code>
        </p>
        <button type="submit" className="button primary" data-testid="agent-hooks-install" disabled={!workspace || pending}>
          {pending ? text('Installing Codex hook…', 'Установка хука Codex…') : text('Install Codex hook', 'Установить хук Codex')}
        </button>
      </fieldset>
    </form>
    {result && <div role="status" data-testid="agent-hooks-result" style={{ marginTop: 14 }}>
      <strong>{result.status === 'unchanged'
        ? text('Codex hook already installed', 'Хук Codex уже установлен')
        : text('Codex hook installed', 'Хук Codex установлен')}</strong>
      <p className="field-hint" style={{ overflowWrap: 'anywhere' }}>{result.configPath}</p>
      {result.requiresTrustReview && <p className="field-hint">{text('Open /hooks in Codex and trust this project hook before it can run.', 'Откройте /hooks в Codex и доверьте этот хук проекта, прежде чем он сможет работать.')}</p>}
    </div>}
    {error && <p role="alert" data-testid="agent-hooks-error" style={{ marginTop: 12, color: 'var(--error)', overflowWrap: 'anywhere' }}>{text('Could not install the Codex hook: ', 'Не удалось установить хук Codex: ')}{error}</p>}
  </section>;
}
