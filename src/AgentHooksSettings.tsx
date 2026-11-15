import { useId, useRef, useState, type FormEvent } from 'react';
import { getLanguage } from './i18n';
import { bridge, errorMessage, type Workspace } from './types';

const text = (en: string, ru: string) => getLanguage() === 'ru' ? ru : en;

type AgentId = 'codex' | 'omp' | 'claude' | 'pi' | 'hermes';

interface InstallResult {
  status: 'installed' | 'updated' | 'unchanged';
  agent: AgentId;
  workspaceId: string;
  paneId?: string;
  configPath: string;
  extensionPath?: string;
  pluginPath?: string;
  helperPath: string;
  backupPath?: string;
  requiresTrustReview: boolean;
  requiresRestart?: boolean;
  requiresEnable?: boolean;
  enableCommand?: string;
}

export interface AgentHooksSettingsProps {
  workspaces: Workspace[];
  activeWorkspaceId?: string;
  ompHooksAvailable?: boolean;
  agentActivityAvailable?: boolean;
}

const AGENT_LABEL: Record<AgentId, string> = {
  codex: 'Codex',
  omp: 'OMP',
  claude: 'Claude',
  pi: 'Pi',
  hermes: 'Hermes',
};

function destinationFor(agentId: AgentId, cwd: string, hermesHome: string) {
  const separator = cwd.includes('\\') ? '\\' : '/';
  const root = cwd.replace(/[\\/]+$/, '');
  if (agentId === 'omp') return `${root}${separator}.omp${separator}extensions${separator}winmux-status.ts`;
  if (agentId === 'pi') return `${root}${separator}.pi${separator}extensions${separator}winmux-status.ts`;
  if (agentId === 'claude') return `${root}${separator}.claude${separator}settings.local.json`;
  if (agentId === 'hermes') {
    const profile = hermesHome.trim().replace(/[\\/]+$/, '');
    return profile
      ? `${profile}${profile.includes('\\') ? '\\' : '/' }plugins${profile.includes('\\') ? '\\' : '/'}winmux-status`
      : text('default Hermes profile / plugins / winmux-status', 'профиль Hermes по умолчанию / plugins / winmux-status');
  }
  return `${root}${separator}.codex${separator}hooks.json`;
}

export function AgentHooksSettings({
  workspaces,
  activeWorkspaceId,
  ompHooksAvailable = false,
  agentActivityAvailable = false,
}: AgentHooksSettingsProps) {
  const id = useId();
  const [workspaceId, setWorkspaceId] = useState(activeWorkspaceId ?? workspaces[0]?.id ?? '');
  const [selectedAgent, setSelectedAgent] = useState<AgentId>('codex');
  const [hermesHome, setHermesHome] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const agents: AgentId[] = [
    'codex',
    ...(ompHooksAvailable ? ['omp' as const] : []),
    ...(agentActivityAvailable ? ['claude' as const, 'pi' as const, 'hermes' as const] : []),
  ];
  const agentId = agents.includes(selectedAgent) ? selectedAgent : 'codex';
  const workspace = workspaces.find(item => item.id === workspaceId)
    ?? workspaces.find(item => item.id === activeWorkspaceId) ?? workspaces[0];
  const destination = workspace ? destinationFor(agentId, workspace.cwd, hermesHome) : '';
  const agentLabel = AGENT_LABEL[agentId];
  const installedLabel = result ? AGENT_LABEL[result.agent] : agentLabel;

  async function install(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !workspace) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    setResult(null);
    const profile = hermesHome.trim();
    try {
      setResult(await bridge().call<InstallResult>('agent.hooks.install', {
        workspaceId: workspace.id,
        agent: agentId,
        ...(agentId === 'hermes' && profile ? { hermesHome: profile } : {}),
      }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return <section aria-labelledby={`${id}-title`} data-testid="agent-hooks-settings">
    <h3 id={`${id}-title`}>{text('Agent hooks', 'Хуки агентов')}</h3>
    <p className="preference-intro">{text(
      'Install a project-local status hook for this Windows workspace. Existing unrelated hooks and extensions are kept.',
      'Установите локальный хук статуса для этого пространства Windows. Существующие посторонние хуки и расширения сохраняются.',
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
          <select id={`${id}-agent`} data-testid="agent-hooks-agent" value={agentId} onChange={event => {
            const next = event.target.value as AgentId;
            setSelectedAgent(agents.includes(next) ? next : 'codex');
            setResult(null);
            setError('');
          }} style={{ marginTop: 6 }}>
            <option value="codex">Codex</option>
            {ompHooksAvailable && <option value="omp">OMP</option>}
            {agentActivityAvailable && <>
              <option value="claude">Claude</option>
              <option value="pi">Pi</option>
              <option value="hermes">Hermes</option>
            </>}
          </select>
        </label>
        {agentId === 'hermes' && <label htmlFor={`${id}-hermes`}>{text('Hermes profile', 'Профиль Hermes')}
          <input id={`${id}-hermes`} data-testid="agent-hooks-hermes-home" value={hermesHome} onChange={event => { setHermesHome(event.target.value); setResult(null); setError(''); }} placeholder={text('Absolute directory, optional', 'Абсолютный каталог, необязательно')} spellCheck={false} style={{ marginTop: 6 }} />
        </label>}
        <p className="field-hint" style={{ overflowWrap: 'anywhere' }} data-testid="agent-hooks-destination">
          {text('Project hook', 'Хук проекта')}: <code>{destination || '—'}</code>
        </p>
        <button type="submit" className="button primary" data-testid="agent-hooks-install" disabled={!workspace || pending}>
          {pending
            ? text(`Installing ${agentLabel} hook…`, `Установка хука ${agentLabel}…`)
            : text(`Install ${agentLabel} hook`, `Установить хук ${agentLabel}`)}
        </button>
      </fieldset>
    </form>
    {result && <div role="status" data-testid="agent-hooks-result" style={{ marginTop: 14 }}>
      <strong>{result.status === 'unchanged'
        ? text(`${installedLabel} hook already installed`, `Хук ${installedLabel} уже установлен`)
        : text(`${installedLabel} hook installed`, `Хук ${installedLabel} установлен`)}</strong>
      <p className="field-hint" style={{ overflowWrap: 'anywhere' }}>{result.pluginPath ?? result.configPath}</p>
      {result.requiresTrustReview && result.agent === 'codex' && <p className="field-hint">{text('Open /hooks in Codex and trust this project hook before it can run.', 'Откройте /hooks в Codex и доверьте этот хук проекта, прежде чем он сможет работать.')}</p>}
      {result.requiresTrustReview && result.agent === 'claude' && <p className="field-hint">{text('Trust this project hook in Claude before it can run.', 'Доверьте этот хук проекта в Claude, прежде чем он сможет работать.')}</p>}
      {result.requiresEnable && <p className="field-hint" data-testid="agent-hooks-enable">{text('The Hermes plugin stays disabled. Enable it yourself:', 'Плагин Hermes остаётся выключенным. Включите его сами:')} <code>{result.enableCommand}</code></p>}
      {result.requiresRestart && result.agent === 'omp' && <p className="field-hint" data-testid="agent-hooks-restart">{text('Restart OMP completely before this extension can load. Winmux does not restart it automatically.', 'Полностью перезапустите OMP, чтобы расширение загрузилось. Winmux не перезапускает его автоматически.')}</p>}
      {result.requiresRestart && result.agent !== 'omp' && <p className="field-hint" data-testid="agent-hooks-restart">{text(`Restart ${installedLabel} before this hook can load. Winmux does not restart it.`, `Перезапустите ${installedLabel}, чтобы хук загрузился. Winmux не перезапускает его.`)}</p>}
    </div>}
    {error && <p role="alert" data-testid="agent-hooks-error" style={{ marginTop: 12, color: 'var(--error)', overflowWrap: 'anywhere' }}>{text(`Could not install the ${agentLabel} hook: `, `Не удалось установить хук ${agentLabel}: `)}{error}</p>}
  </section>;
}
