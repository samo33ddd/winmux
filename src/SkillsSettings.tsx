import { useId, useRef, useState, type FormEvent } from 'react';
import { getLanguage } from './i18n';
import { bridge, errorMessage, type Workspace } from './types';

const agents = [
  ['codex', 'Codex', '.agents/skills'],
  ['claude-code', 'Claude Code', '.claude/skills'],
  ['opencode', 'OpenCode', '.agents/skills'],
  ['cursor', 'Cursor', '.agents/skills'],
  ['gemini-cli', 'Gemini CLI', '.agents/skills'],
  ['github-copilot', 'GitHub Copilot', '.agents/skills'],
  ['pi', 'Pi', '.agents/skills'],
  ['hermes-agent', 'Hermes Agent', '.hermes/skills'],
] as const;

const skills = [
  {
    name: 'winmux-terminal',
    en: 'Control persistent Winmux workspaces, panes, input, notifications, and shell state.',
    ru: 'Управление постоянными пространствами Winmux, панелями, вводом, уведомлениями и состоянием оболочки.',
  },
  {
    name: 'winmux-browser',
    en: 'Inspect and automate pages in the Winmux embedded browser.',
    ru: 'Просмотр и автоматизация страниц во встроенном браузере Winmux.',
  },
] as const;

const text = (en: string, ru: string) => getLanguage() === 'ru' ? ru : en;

interface InstallResult {
  workspaceId: string;
  environment: 'windows' | 'wsl';
  agent: string;
  destinationRoot: string;
  installedSkills: string[];
  unchangedSkills: string[];
  skills: Array<{ name: string; status: 'install' | 'unchanged'; path: string }>;
}

export interface SkillsSettingsProps {
  workspaces: Workspace[];
  activeWorkspaceId?: string;
  onStarted?(workspaceId: string, paneId: string): void;
}

function destinationFor(workspace: Workspace, relative: string, skill: string) {
  const separator = workspace.cwd.includes('\\') ? '\\' : '/';
  const base = workspace.cwd.replace(/[\\/]+$/, '');
  const relativePath = relative.split('/').join(separator);
  const skillPart = skill ? `${separator}${skill}${separator}SKILL.md` : '';
  return `${base}${separator}${relativePath}${skillPart}`;
}

export function SkillsSettings({ workspaces, activeWorkspaceId }: SkillsSettingsProps) {
  const id = useId();
  const [workspaceId, setWorkspaceId] = useState(activeWorkspaceId ?? workspaces[0]?.id ?? '');
  const [agent, setAgent] = useState('codex');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const workspace = workspaces.find(item => item.id === workspaceId)
    ?? workspaces.find(item => item.id === activeWorkspaceId) ?? workspaces[0];
  const agentEntry = agents.find(([value]) => value === agent) ?? agents[0];
  const destinationRoot = workspace ? destinationFor(workspace, agentEntry[2], '') : '';

  async function install(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !workspace) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    setResult(null);
    try {
      const installed = await bridge().call<InstallResult>('skills.install', {
        workspaceId: workspace.id,
        agent,
      });
      setResult(installed);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return <section aria-labelledby={`${id}-title`} data-testid="skills-settings">
    <h3 id={`${id}-title`}>{text('Winmux skills', 'Навыки Winmux')}</h3>
    <p className="preference-intro">{text(
      'Install the two skills shipped with this version of Winmux into the selected project and agent. Unrelated project skills stay unchanged. An existing Winmux skill is never overwritten; identical files are left as an unchanged no-op.',
      'Установите два навыка из этой версии Winmux в выбранный проект и для выбранного агента. Другие навыки проекта остаются без изменений. Существующий навык Winmux никогда не перезаписывается; идентичные файлы сохраняются без изменений.',
    )}</p>
    <form onSubmit={install} style={{ marginTop: 16 }}>
      <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: 14 }}>
        <label htmlFor={`${id}-workspace`}>{text('Project workspace', 'Рабочее пространство проекта')}
          <select id={`${id}-workspace`} data-testid="skills-workspace" value={workspace?.id ?? ''} onChange={event => { setWorkspaceId(event.target.value); setResult(null); setError(''); }} style={{ marginTop: 6 }}>
            {!workspaces.length && <option value="">{text('Create a workspace first', 'Сначала создайте рабочее пространство')}</option>}
            {workspaces.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
        </label>
        {workspace && <p className="field-hint" style={{ overflowWrap: 'anywhere' }}>
          {text('Project', 'Проект')}: <code>{workspace.cwd}</code><br />
          {text('Environment', 'Среда')}: {workspace.profileId.startsWith('wsl:') ? workspace.profileId : 'Windows · PowerShell'}
        </p>}
        <label htmlFor={`${id}-agent`}>{text('Target agent', 'Целевой агент')}
          <select id={`${id}-agent`} data-testid="skills-agent" value={agent} onChange={event => { setAgent(event.target.value); setResult(null); setError(''); }} style={{ marginTop: 6 }}>
            {agents.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </label>
        <p className="field-hint" style={{ overflowWrap: 'anywhere' }} data-testid="skills-destination">
          {text('Destination', 'Назначение')}: <code>{destinationRoot || '—'}</code>
        </p>
        <div role="list" aria-label={text('Skills to install', 'Навыки для установки')} style={{ display: 'grid', gap: 10 }}>
          {skills.map(skill => <div role="listitem" key={skill.name} data-testid={`skills-skill-${skill.name}`} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 6 }}>
            <strong><code>{skill.name}</code></strong>
            <p className="field-hint" style={{ marginTop: 5 }}>{text(skill.en, skill.ru)}</p>
            <p className="field-hint" style={{ marginTop: 5, overflowWrap: 'anywhere' }}>
              {workspace ? <code>{destinationFor(workspace, agentEntry[2], skill.name)}</code> : '—'}
            </p>
          </div>)}
        </div>
        <button type="submit" className="button primary" data-testid="skills-launch" disabled={!workspace || pending}>
          {pending ? text('Installing two skills…', 'Установка двух навыков…') : text('Install 2 Winmux skills', 'Установить 2 навыка Winmux')}
        </button>
      </fieldset>
    </form>
    {result && <div role="status" data-testid="skills-result" style={{ marginTop: 14 }}>
      <strong>{text('Installation complete', 'Установка завершена')}</strong>
      <p className="field-hint" style={{ overflowWrap: 'anywhere' }}>{result.destinationRoot}</p>
      <ul>
        {result.skills.map(item => <li key={item.name}><code>{item.name}</code>: {item.status === 'install'
          ? text('installed', 'установлен')
          : text('already identical; unchanged', 'уже совпадает; без изменений')}</li>)}
      </ul>
    </div>}
    {error && <p role="alert" data-testid="skills-error" style={{ marginTop: 12, color: 'var(--error)', overflowWrap: 'anywhere' }}>{text('Could not install the Winmux skills: ', 'Не удалось установить навыки Winmux: ')}{error}</p>}
  </section>;
}
