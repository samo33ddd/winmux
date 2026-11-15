import { t } from './i18n';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { bridge, errorMessage, type Environment, type Profile } from './types';

export function Modal({ title, children, onClose, busy = false, className = '' }: { title: string; children: ReactNode; onClose(): void; busy?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null); const heading = useId();
  const close = useRef(onClose); close.current = onClose;
  const pending = useRef(busy); pending.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    (root?.querySelector<HTMLElement>('input, select') ?? root?.querySelector<HTMLElement>('button, [tabindex="0"]'))?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!pending.current) close.current(); }
      if (event.key !== 'Tab' || !root) return;
      const elements = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')).filter(element => element.getClientRects().length > 0);
      const first = elements[0], last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handler, true);
    return () => { document.removeEventListener('keydown', handler, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className={`modal ${className}`} ref={ref} role="dialog" aria-modal="true" aria-labelledby={heading}>
      <div className="modal-heading"><h2 id={heading}>{title}</h2><button className="icon-button" aria-label={t("Закрыть диалог")} disabled={busy} onClick={onClose}><X /></button></div>
      {children}
    </div>
  </div>;
}
export function CreateWorkspace({ environment, defaultAgentHooks = true, onCreate, onClose }: { environment: Environment; defaultAgentHooks?: boolean; onCreate(values: { name?: string; cwd: string; profileId: string; agentId?: string; agentHooks?: boolean }): Promise<void>; onClose(): void }) {
  const initial = environment.profiles.find(profile => profile.available !== false);
  const [profileId, setProfile] = useState(initial?.id ?? '');
  const [agentId, setAgentId] = useState('');
  const [agentHooks, setAgentHooks] = useState(defaultAgentHooks);
  const [cwd, setCwd] = useState(initial?.cwd ?? (initial?.environment === 'wsl' ? '~' : environment.defaultCwd));
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const profile = environment.profiles.find(item => item.id === profileId);
  const agent = environment.agents?.find(item => item.id === agentId);
  const hooksAvailable = environment.capabilities?.sessionAgentHooks && Boolean(agent?.hookAdapter);
  function selectProfile(id: string) {
    const next = environment.profiles.find(item => item.id === id); setProfile(id); setAgentId('');
    setCwd(next?.cwd ?? (next?.environment === 'wsl' ? '~' : environment.defaultCwd));
  }
  async function pick() {
    try { const directory = await bridge().pickDirectory(); if (directory) setCwd(directory); }
    catch (error) { setError(errorMessage(error)); }
  }
  return <Modal title={t("Новое рабочее пространство")} onClose={onClose} busy={busy}>
    <form data-testid="create-workspace-form" onSubmit={async event => {
      event.preventDefault(); if (!profile || profile.available === false || !cwd.trim()) return;
      setBusy(true); setError('');
      try { await onCreate({ name: name.trim() || undefined, cwd: cwd.trim(), profileId, ...(agentId ? {agentId, agentHooks: Boolean(agentHooks && hooksAvailable)} : {}) }); onClose(); }
      catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
    }}>
      <div className="form-fields">
        <label>{t("Название")} <span className="optional">{t("необязательно")}</span><input data-testid="workspace-name-input" autoFocus value={name} maxLength={120} placeholder={t("Например, мой проект")} onChange={event => setName(event.target.value)} disabled={busy} /></label>
        <label>{t("Среда запуска")}<select data-testid="workspace-profile-select" value={profileId} onChange={event => selectProfile(event.target.value)} disabled={busy || !environment.profiles.length}>
          {!environment.profiles.length && <option value="">{t("Нет доступных сред")}</option>}
          {(['windows', 'wsl'] as const).map(environmentName => <optgroup key={environmentName} label={environmentName === 'windows' ? 'Windows' : 'WSL'}>{environment.profiles.filter(item => item.environment === environmentName).map(item => <option key={item.id} value={item.id} disabled={item.available === false}>{item.label}{item.available === false ? t(" — недоступен") : ''}</option>)}</optgroup>)}
        </select></label>
        <label>{t('Агент')}<select data-testid="workspace-agent-select" value={agentId} disabled={busy || environment.capabilities?.terminalTabs !== true} onChange={event => setAgentId(event.target.value)}><option value="">{t('Только терминал')}</option>{environment.agents?.filter(agent => agent.profileId === profileId).map(agent => <option key={agent.id} value={agent.id} disabled={agent.available === false}>{agent.label}{agent.available === null ? t(' — проверка при запуске') : agent.available ? '' : t(' — не установлен')}</option>)}</select></label>
        {hooksAvailable && <><label className="agent-hooks-control"><input type="checkbox" checked={agentHooks} disabled={busy} onChange={event => setAgentHooks(event.target.checked)} />{t('Хуки статуса агента')}</label><p className="field-hint">{t('Хуки только для этого запуска поддерживаемого агента. Глобальные настройки не изменяются.')}</p></>}
        <label>{t("Стартовый каталог")}<div className="input-with-button"><input data-testid="workspace-cwd-input" value={cwd} onChange={event => setCwd(event.target.value)} required placeholder={profile?.environment === 'wsl' ? '/home/user/project' : 'C:\\Projects\\my-project'} disabled={busy} spellCheck={false} /><button type="button" className="button folder-button" aria-label={t("Выбрать папку")} title={profile?.environment === 'wsl' ? t("Для WSL укажите Linux-путь вручную") : t("Выбрать папку")} disabled={busy || profile?.environment === 'wsl'} onClick={() => void pick()}><FolderOpen /></button></div></label>
        <p className="field-hint">{profile?.environment === 'wsl' ? t("Путь внутри выбранного WSL-дистрибутива. ~ открывает домашний каталог.") : t("Новый терминал откроется в этой папке.")}</p>
        {!environment.profiles.some(item => item.environment === 'wsl') && <p className="field-hint">{t("WSL-дистрибутивы не обнаружены.")}</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
      </div>
      <div className="modal-actions"><button type="button" className="button" onClick={onClose} disabled={busy}>{t("Отмена")}</button><button data-testid="create-workspace-submit" className="button primary" type="submit" disabled={busy || !profile || profile.available === false || !cwd.trim()}>{busy ? t("Открытие…") : t("Создать пространство")}</button></div>
    </form>
  </Modal>;
}
export function RenameWorkspace({ name: initial, onSave, onClose }: { name: string; onSave(name: string): Promise<void>; onClose(): void }) {
  const [name, setName] = useState(initial); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <Modal title={t("Переименовать пространство")} onClose={onClose} busy={busy}><form onSubmit={async event => { event.preventDefault(); if (!name.trim()) return; setBusy(true); try { await onSave(name.trim()); onClose(); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); } }}>
    <div className="form-fields"><label>{t("Название")}<input data-testid="rename-workspace-input" value={name} maxLength={120} autoFocus onChange={event => setName(event.target.value)} onFocus={event => event.target.select()} disabled={busy} /></label>{error && <p role="alert" className="inline-error">{error}</p>}</div>
    <div className="modal-actions"><button type="button" className="button" onClick={onClose} disabled={busy}>{t("Отмена")}</button><button className="button primary" type="submit" disabled={busy || !name.trim()}>{t("Сохранить")}</button></div>
  </form></Modal>;
}
export function ConfirmClose({ title, description, onConfirm, onClose }: { title: string; description: string; onConfirm(): Promise<void>; onClose(): void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <Modal title={title} onClose={onClose} busy={busy}><div className="form-fields"><p className="dialog-description">{description}</p>{error && <p className="inline-error" role="alert">{error}</p>}</div><div className="modal-actions"><button className="button" disabled={busy} onClick={onClose}>{t("Отмена")}</button><button className="button danger" data-testid="confirm-close" disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); } }}>{busy ? t("Завершение…") : t("Завершить и закрыть")}</button></div></Modal>;
}
export function profileLabel(profiles: Profile[], profileId: string) { return profiles.find(item => item.id === profileId)?.label ?? profileId; }
