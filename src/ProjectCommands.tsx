import { useEffect, useState } from 'react';
import { Modal } from './Dialogs';
import { t } from './i18n';
import { bridge, errorMessage, type Pane, type Workspace } from './types';

interface Command { name: string; template: string }

type Props = { workspace: Workspace; pane: Pane; projectRoot?: string; onClose(): void };

export function ProjectCommands(props: Props) {
  const {workspace, projectRoot, onClose} = props;
  const [root, setRoot] = useState(projectRoot);
  useEffect(() => {
    if (projectRoot) return;
    let active = true;
    void bridge().call<{ root: string }>('project.inspect', { profileId:workspace.profileId, cwd:workspace.cwd })
      .then(project => { if (active) setRoot(project.root); }, () => { if (active) setRoot(workspace.cwd); });
    return () => { active = false; };
  }, [projectRoot, workspace.profileId, workspace.cwd]);
  if (!root) return <Modal title={t('Команды проекта')} onClose={onClose}><p role="status">{t('Определяем каталог проекта…')}</p></Modal>;
  const key = `winmux.commands.${JSON.stringify([workspace.profileId, workspace.profileId.startsWith('wsl:') ? root : root.toLowerCase()])}`;
  return <CommandEditor key={key} {...props} storageKey={key} />;
}

function CommandEditor({ workspace, pane, storageKey, onClose }: Props & {storageKey:string}) {
  const [commands, setCommands] = useState<Command[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      return Array.isArray(saved) ? saved.filter(item => typeof item?.name === 'string' && typeof item?.template === 'string').slice(0, 40) : [];
    } catch { return []; }
  });
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const placeholders = [...new Set([...template.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)].map(match => match[1]))];
  const linux = pane.profileId.startsWith('wsl:');
  const quote = (value: string) => `'${linux ? value.replaceAll("'", "'\\''") : value.replace(/[‘’']/g, mark => mark + mark)}'`;
  const preview = template.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, field: string) => quote(values[field] ?? ''));
  const valid = Boolean(name.trim() && template.trim() && !/[\r\n\x00-\x1f\x7f]/.test(preview) && preview.length <= 4096);
  const sameDirectory = linux ? pane.cwd === workspace.cwd : pane.cwd.toLowerCase() === workspace.cwd.toLowerCase();
  const ready = sameDirectory && pane.profileId === workspace.profileId && pane.status === 'running' && !pane.agentId;
  function save(next: Command[]) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setCommands(next);
      setError('');
    } catch (failure) { setError(errorMessage(failure)); }
  }
  async function run() {
    if (!valid || !ready || busy) return;
    setBusy(true);
    setError('');
    try {
      await bridge().call('pane.input', { paneId: pane.id, data: `${preview}\r` });
      onClose();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <Modal title={t('Команды проекта')} onClose={onClose} busy={busy}>
    <div className="form-fields">
      <label>{t('Сохранённая команда')}<select value={commands.some(command => command.name === name) ? name : ''} onChange={event => {
        const command = commands.find(item => item.name === event.target.value);
        setName(command?.name ?? '');
        setTemplate(command?.template ?? '');
        setValues({});
      }}><option value="">{t('Новая команда')}</option>{commands.map(command => <option key={command.name}>{command.name}</option>)}</select></label>
      <label>{t('Название')}<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label>
      <label>{t('Шаблон команды')}<input value={template} maxLength={2048} placeholder="npm test -- {{filter}}" onChange={event => setTemplate(event.target.value)} /></label>
      {placeholders.map(field => <label key={field}>{field}<input value={values[field] ?? ''} maxLength={512} onChange={event => setValues({ ...values, [field]: event.target.value })} /></label>)}
      <label>{t('Итоговая команда')}<input readOnly value={preview} /></label>
      <p className="field-hint">{t('Панель')}: {pane.title} · {pane.cwd}</p>
      <p className="field-hint">{t('Перед запуском убедитесь, что панель ждёт команду и строка ввода пуста.')}</p>
      {!ready && <p role="status">{t('Выберите обычный терминал в стартовом каталоге рабочей области.')}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
    <div className="dialog-actions">
      <button className="button" disabled={!commands.some(command => command.name === name) || busy} onClick={() => save(commands.filter(command => command.name !== name))}>{t('Удалить')}</button>
      <button className="button" disabled={!valid || busy || (commands.length >= 40 && !commands.some(command => command.name === name.trim()))} onClick={() => save([...commands.filter(command => command.name !== name.trim()), {name:name.trim(),template}])}>{t('Сохранить')}</button>
      <button className="button primary" disabled={!valid || !ready || busy} onClick={() => void run()}>{t('Выполнить команду')}</button>
    </div>
  </Modal>;
}
