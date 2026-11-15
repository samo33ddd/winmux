import { useId, useRef, useState, type FormEvent } from 'react';
import { getLanguage } from './i18n';
import { bridge, errorMessage, type Workspace } from './types';

// Offered agents and flags verified against vercel-labs/skills official docs.
// Keep this subset and validation aligned with electron/skills-install.cjs.
const agents = [
  ['codex', 'Codex'], ['claude-code', 'Claude Code'], ['opencode', 'OpenCode'],
  ['cursor', 'Cursor'], ['gemini-cli', 'Gemini CLI'], ['github-copilot', 'GitHub Copilot'],
  ['pi', 'Pi'], ['hermes-agent', 'Hermes Agent'],
] as const;
const presets = [
  { source: 'vercel-labs/agent-skills', label: 'Vercel · agent-skills' },
  { source: 'anthropics/skills', label: 'Anthropic · skills' },
];
const sourcePattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const skillPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const text = (en: string, ru: string) => getLanguage() === 'ru' ? ru : en;

export interface SkillsSettingsProps {
  workspaces: Workspace[];
  activeWorkspaceId?: string;
  onStarted(workspaceId: string, paneId: string): void;
}

export function SkillsSettings({ workspaces, activeWorkspaceId, onStarted }: SkillsSettingsProps) {
  const id = useId();
  const [workspaceId, setWorkspaceId] = useState(activeWorkspaceId ?? workspaces[0]?.id ?? '');
  const [source, setSource] = useState('vercel-labs/agent-skills');
  const [skill, setSkill] = useState('');
  const [agent, setAgent] = useState<string>('codex');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [launched, setLaunched] = useState(false);
  const [error, setError] = useState('');
  const workspace = workspaces.find(item => item.id === workspaceId)
    ?? workspaces.find(item => item.id === activeWorkspaceId) ?? workspaces[0];
  const validSource = !/\s/.test(source) && sourcePattern.test(source);
  const validSkill = !skill || (!/\s/.test(skill) && skillPattern.test(skill));
  const valid = validSource && validSkill && agents.some(([value]) => value === agent);
  const command = valid ? `npx skills add ${source} --agent ${agent}${skill ? ` --skill ${skill}` : ''} --yes` : '';

  async function launch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !workspace?.panes.length || !valid) return;
    inFlight.current = true;
    setPending(true); setError(''); setLaunched(false);
    let result: { paneId: string; workspaceId: string };
    try {
      result = await bridge().call<{ paneId: string; workspaceId: string }>('skills.install', {
        workspaceId: workspace.id, source, agent, ...(skill ? { skill } : {}),
      });
      setLaunched(true);
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
    onStarted(result.workspaceId, result.paneId);
  }

  return <section aria-labelledby={`${id}-title`} data-testid="skills-settings">
    <h3 id={`${id}-title`}>{text('Project skills', 'Навыки проекта')}</h3>
    <p className="preference-intro">{text(
      'Install agent skills into the selected project using the official skills CLI. Node.js 22.20+ and npx must be available in its Windows or WSL environment.',
      'Устанавливайте навыки агентов в выбранный проект через официальный skills CLI. В его среде Windows или WSL должны быть доступны Node.js 22.20+ и npx.',
    )}</p>
    <form onSubmit={launch} style={{ marginTop: 16 }}>
      <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: 14 }}>
        <label htmlFor={`${id}-workspace`}>{text('Target workspace', 'Рабочее пространство')}
          <select id={`${id}-workspace`} data-testid="skills-workspace" value={workspace?.id ?? ''} onChange={event => setWorkspaceId(event.target.value)} style={{ marginTop: 6 }}>
            {!workspaces.length && <option value="">{text('Create a workspace first', 'Сначала создайте рабочее пространство')}</option>}
            {workspaces.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select>
        </label>
        {workspace && <p className="field-hint" style={{ overflowWrap: 'anywhere' }}>
          {text('Startup directory', 'Стартовый каталог')}: <code>{workspace.cwd}</code><br />
          {text('Environment', 'Среда')}: {workspace.profileId.startsWith('wsl:') ? workspace.profileId : 'Windows · PowerShell'}
        </p>}
        <div role="group" aria-label={text('Official repository presets', 'Официальные репозитории')} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {presets.map(preset => <button type="button" className="button" key={preset.source} aria-pressed={source === preset.source}
            onClick={() => { setSource(preset.source); setSkill(''); setLaunched(false); setError(''); }}>{preset.label}</button>)}
        </div>
        <label htmlFor={`${id}-source`}>{text('GitHub repository (owner/repo)', 'Репозиторий GitHub (owner/repo)')}
          <input id={`${id}-source`} data-testid="skills-source" value={source} required maxLength={140} spellCheck={false} autoCapitalize="none" autoCorrect="off"
            aria-invalid={!validSource} aria-describedby={`${id}-source-hint`} onChange={event => setSource(event.target.value)} placeholder="vercel-labs/agent-skills" style={{ marginTop: 6 }} />
        </label>
        <p id={`${id}-source-hint`} className="field-hint">{text('Use owner/repo only, without URLs, spaces or extra flags.', 'Укажите только owner/repo — без URL, пробелов и дополнительных флагов.')}</p>
        <label htmlFor={`${id}-agent`}>{text('Agent', 'Агент')}
          <select id={`${id}-agent`} data-testid="skills-agent" value={agent} onChange={event => setAgent(event.target.value)} style={{ marginTop: 6 }}>
            {agents.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </label>
        <label htmlFor={`${id}-skill`}>{text('Skill name (optional)', 'Название навыка (необязательно)')}
          <input id={`${id}-skill`} data-testid="skills-name" value={skill} maxLength={128} spellCheck={false} autoCapitalize="none" autoCorrect="off"
            aria-invalid={!validSkill} aria-describedby={`${id}-skill-hint`} onChange={event => setSkill(event.target.value)} placeholder="web-design-guidelines" style={{ marginTop: 6 }} />
        </label>
        <p id={`${id}-skill-hint`} className="field-hint">{text(
          'Leave blank to install all skills from this repository. Names must start with a letter or digit; use only ASCII letters, digits, dots, underscores and hyphens.',
          'Оставьте пустым для установки всех навыков репозитория. Название начинается с буквы или цифры и содержит только латиницу, цифры, точки, подчёркивания и дефисы.',
        )}</p>
        <div>
          <strong>{text('Command preview', 'Команда запуска')}</strong>
          <pre data-testid="skills-command" style={{ marginTop: 8, padding: 12, borderRadius: 6, background: 'var(--bg)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><code>{command || text('Enter a valid repository and skill name.', 'Укажите корректный репозиторий и название навыка.')}</code></pre>
          <p className="preference-intro">{text(
            'Project-local only. Opens a new terminal pane in the startup directory above. npx may ask to download the CLI; inspect the terminal for prompts and the installation result.',
            'Установка только в проект. Откроется новая панель терминала в указанном стартовом каталоге. npx может запросить загрузку CLI; проверьте запросы и результат установки в терминале.',
          )}</p>
        </div>
        <button type="submit" className="button primary" data-testid="skills-launch" disabled={!workspace?.panes.length || !valid || pending}>
          {pending ? text('Launching…', 'Запуск…') : text('Launch installation command', 'Запустить команду установки')}
        </button>
      </fieldset>
    </form>
    {launched && <p role="status" className="preference-intro">{text('Command launched. Inspect the new terminal for the installation result.', 'Команда запущена. Проверьте результат установки в новой панели терминала.')}</p>}
    {error && <p role="alert" style={{ marginTop: 12, color: 'var(--error)', overflowWrap: 'anywhere' }}>{text('Could not launch the command: ', 'Не удалось запустить команду: ')}{error}</p>}
  </section>;
}
