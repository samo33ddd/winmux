import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Modal } from './Dialogs';
import { t } from './i18n';
import { bridge, errorMessage, type Environment } from './types';
import './tasks.css';

export type TaskMode = 'new' | 'attach';

export interface TaskCreateValues {
  projectDirectory: string;
  name: string;
  baseBranch: string;
  primaryBranch: string;
  profileId: string;
  agentId?: string;
  mode: TaskMode;
  worktreePath?: string;
}

export interface TaskRepoInspection {
  root: string;
  branches: string[];
  primary: string;
  worktrees: Array<{ path: string; branch: string; primary?: boolean; detached?: boolean }>;
}

export interface TaskDialogProps {
  environment: Environment;
  onClose(): void;
  onCreate(values: TaskCreateValues): Promise<void>;
  onInspect(request: { cwd: string; profileId: string }): Promise<TaskRepoInspection>;
}

const emptyInspection: TaskRepoInspection = { root: '', branches: [], primary: '', worktrees: [] };

export function TaskDialog({ environment, onClose, onCreate, onInspect }: TaskDialogProps) {
  const initial = environment.profiles.find(profile => profile.available !== false);
  const [profileId, setProfileId] = useState(initial?.id ?? '');
  const [agentId, setAgentId] = useState('');
  const [directory, setDirectory] = useState(initial?.cwd ?? (initial?.environment === 'wsl' ? '' : environment.defaultCwd));
  const [name, setName] = useState('');
  const [mode, setMode] = useState<TaskMode>('new');
  const [baseBranch, setBaseBranch] = useState('');
  const [primaryBranch, setPrimaryBranch] = useState('');
  const [worktreePath, setWorktreePath] = useState('');
  const [inspection, setInspection] = useState<TaskRepoInspection>(emptyInspection);
  const [inspected, setInspected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const profile = environment.profiles.find(item => item.id === profileId);
  const wsl = profile?.environment === 'wsl';

  useEffect(() => { setInspected(false); setInspection(emptyInspection); setBaseBranch(''); setPrimaryBranch(''); setWorktreePath(''); }, [directory, profileId]);

  function selectProfile(id: string) {
    const next = environment.profiles.find(item => item.id === id);
    setProfileId(id); setAgentId('');
    setDirectory(next?.cwd ?? (next?.environment === 'wsl' ? '' : environment.defaultCwd));
  }
  async function pick() {
    try { const chosen = await bridge().pickDirectory(); if (chosen) setDirectory(chosen); }
    catch (caught) { setError(errorMessage(caught)); }
  }
  async function inspect() {
    if (!profile || !directory.trim()) return;
    setBusy(true); setError('');
    try {
      const result = await onInspect({ cwd: directory.trim(), profileId });
      setInspection(result); setInspected(true);
      setBaseBranch(result.branches.includes(result.primary) ? result.primary : result.branches[0] ?? '');
      setPrimaryBranch(result.primary);
      setWorktreePath(result.worktrees.find(item => !item.primary && !item.detached && item.branch)?.path ?? '');
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  }

  const ready = Boolean(profile && profile.available !== false && agentId && primaryBranch && directory.trim() && name.trim() && (mode === 'new' ? baseBranch : worktreePath));
  return <Modal title={t('Новая задача')} onClose={onClose} busy={busy} className="task-dialog">
    <form data-testid="task-dialog-form" onSubmit={async event => {
      event.preventDefault(); if (!ready || !profile) return;
      setBusy(true); setError('');
      try {
        await onCreate({ projectDirectory: directory.trim(), name: name.trim(), baseBranch, primaryBranch, profileId, ...(agentId ? { agentId } : {}), mode, ...(mode === 'attach' ? { worktreePath } : {}) });
        onClose();
      } catch (caught) { setError(errorMessage(caught)); }
      finally { setBusy(false); }
    }}>
      <div className="form-fields">
        <label>{t('Каталог проекта')}<div className="input-with-button"><input data-testid="task-directory" value={directory} required spellCheck={false} disabled={busy} placeholder={wsl ? '/home/user/project' : 'C:\\Projects\\my-project'} onChange={event => setDirectory(event.target.value)} /><button type="button" className="button folder-button" aria-label={t('Выбрать папку')} title={wsl ? t('Для WSL укажите Linux-путь вручную') : t('Выбрать папку')} disabled={busy || wsl} onClick={() => void pick()}><FolderOpen /></button></div></label>
        <p className="field-hint">{wsl ? t('Для WSL укажите Linux-путь вручную. Промпт агенту не отправляется.') : t('Каталог проверяется только по вашему запросу. Промпт агенту не отправляется.')}</p>
        <label>{t('Имя задачи')}<input data-testid="task-name" value={name} maxLength={120} required disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <label>{t('Среда запуска')}<select data-testid="task-profile" value={profileId} disabled={busy || !environment.profiles.length} onChange={event => selectProfile(event.target.value)}>
          {!environment.profiles.length && <option value="">{t('Нет доступных сред')}</option>}
          {(['windows', 'wsl'] as const).map(name => <optgroup key={name} label={name === 'windows' ? 'Windows' : 'WSL'}>{environment.profiles.filter(item => item.environment === name).map(item => <option key={item.id} value={item.id} disabled={item.available === false}>{item.label}{item.available === false ? t(' — недоступен') : ''}</option>)}</optgroup>)}
        </select></label>
        <label>{t('Агент')}<select data-testid="task-agent" value={agentId} disabled={busy} onChange={event => setAgentId(event.target.value)}><option value="">{t('Только терминал')}</option>{environment.agents?.filter(agent => agent.profileId === profileId).map(agent => <option key={agent.id} value={agent.id} disabled={agent.available === false}>{agent.label}{agent.available === null ? t(' — проверка при запуске') : agent.available ? '' : t(' — не установлен')}</option>)}</select></label>
        {agentId.split(':').pop() === 'codex' && <p className="field-hint">{t('Для инструкции доставки включите и разрешите Winmux UserPromptSubmit в Codex /hooks.')}</p>}
        <div><span id="task-mode-label">{t('Способ')}</span><div className="task-mode" role="group" aria-labelledby="task-mode-label">{([['new', 'Новое рабочее дерево'], ['attach', 'Подключить существующее']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} disabled={busy} onClick={() => setMode(value)}>{t(label)}</button>)}</div></div>
        <label>{t('Локальная базовая ветка')}<select data-testid="task-base-branch" value={baseBranch} required={mode === 'new'} disabled={busy || mode === 'attach' || !inspection.branches.length} onChange={event => setBaseBranch(event.target.value)}>{!inspection.branches.length && <option value="">{t('Ветки ещё не проверены.')}</option>}{inspection.branches.map(branch => <option key={branch} value={branch}>{branch}{branch === inspection.primary ? ' · primary' : ''}</option>)}</select></label>
        {inspected && !inspection.primary && <label>{t('Основная ветка для PR')}<select value={primaryBranch} required onChange={event => setPrimaryBranch(event.target.value)}><option value="">{t('Выберите основную ветку')}</option>{inspection.branches.map(branch => <option key={branch} value={branch}>{branch}</option>)}</select></label>}
        {mode === 'attach' && <div><span id="task-worktrees-label">{t('Существующие рабочие деревья')}</span>{inspected && !inspection.worktrees.some(item => !item.primary && !item.detached && item.branch) ? <p className="task-empty">{t('Рабочих деревьев нет.')}</p> : <ul className="task-worktrees" aria-labelledby="task-worktrees-label">{inspection.worktrees.filter(item => !item.primary && !item.detached && item.branch).map(item => <li key={item.path}><label><input type="radio" name="task-worktree" value={item.path} checked={worktreePath === item.path} disabled={busy} onChange={() => setWorktreePath(item.path)} /> {item.branch}</label><code>{item.path}</code></li>)}</ul>}</div>}
        {error && <p className="inline-error" role="alert">{error}</p>}
      </div>
      <div className="modal-actions"><button type="button" className="button" disabled={busy || !profile || !directory.trim()} onClick={() => void inspect()}>{busy ? t('Проверка…') : t('Проверить репозиторий')}</button><button type="button" className="button" disabled={busy} onClick={onClose}>{t('Отмена')}</button><button className="button primary" type="submit" data-testid="task-create" disabled={busy || !ready}>{busy ? t('Создание…') : t('Создать задачу')}</button></div>
    </form>
  </Modal>;
}
