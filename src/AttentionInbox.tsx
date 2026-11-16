import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { getLanguage, subscribeLanguage, t } from './i18n';
import { bridge, type State } from './types';
import { deliveryLabel } from './ProjectTasks';
import { attentionSections, type AttentionEntry, type AttentionGroup } from './attentionGrouping';
import './attention-inbox.css';

const groupLabels: Record<AttentionGroup, string> = {
  waiting: '\u041e\u0436\u0438\u0434\u0430\u0435\u0442 \u0432\u0432\u043e\u0434\u0430',
  failed: '\u041e\u0448\u0438\u0431\u043a\u0430',
  completed: '\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u043e',
  active: '\u0420\u0430\u0431\u043e\u0442\u0430\u0435\u0442',
  idle: '\u041e\u0436\u0438\u0434\u0430\u0435\u0442',
  unknown: '\u041d\u0435\u0442 \u0434\u0430\u043d\u043d\u044b\u0445 \u043e\u0431 \u0430\u043a\u0442\u0438\u0432\u043d\u043e\u0441\u0442\u0438',
};

function elapsedLabel(entry: AttentionEntry): string {
  if (entry.elapsedMs === null) return '';
  const seconds = Math.floor(entry.elapsedMs / 1000);
  if (seconds < 60) return t('{0} \u0441', seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('{0} \u043c\u0438\u043d', minutes);
  const hours = Math.floor(minutes / 60);
  return t('{0} \u0447 {1} \u043c\u0438\u043d', hours, minutes % 60);
}

export function AttentionInbox({
  state, onSelect, onOpenTask, onClose,
}: {
  state: State | null;
  onSelect(workspaceId: string, paneId: string): void;
  onOpenTask(taskId: string): void;
  onClose(): void;
}) {
  useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  const heading = useId();
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [now, setNow] = useState(() => Date.now());
  const sections = attentionSections(state, now);
  const detachedTasks = state?.tasks?.filter(task => !task.archived && !task.workspaceId && task.delivery && task.delivery.code !== 'NOT_FOUND') ?? [];

  useEffect(() => {
    const panel = root.current;
    const previous = document.activeElement as HTMLElement | null;
    panel?.querySelector<HTMLElement>('button')?.focus();
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    document.addEventListener('keydown', handler, true);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('keydown', handler, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return <section className="attention-inbox" ref={root} aria-labelledby={heading} data-testid="attention-inbox">
    <div className="attention-heading">
      <h2 id={heading}>{t('\u0412\u043d\u0438\u043c\u0430\u043d\u0438\u0435')}</h2>
      <button type="button" className="icon-button" aria-label={t('\u0417\u0430\u043a\u0440\u044b\u0442\u044c \u0432\u043d\u0438\u043c\u0430\u043d\u0438\u0435')} onClick={onClose}><X /></button>
    </div>
    <div className="attention-list">
      {sections.length || detachedTasks.length ? <>{sections.map(section => <section className="attention-group" key={section.group} aria-label={t(groupLabels[section.group])}>
        <h3>{t(groupLabels[section.group])}</h3>
        {section.entries.map(entry => {
          const duration = elapsedLabel(entry);
          return <button type="button" className="attention-item" key={`${entry.workspaceId}:${entry.paneId}`} data-testid="attention-item" data-attention-group={entry.group} data-workspace-id={entry.workspaceId} data-pane-id={entry.paneId} onClick={() => onSelect(entry.workspaceId, entry.paneId)}>
            <span className="attention-item-title">
              <span className={`activity-dot activity-${entry.state}`} aria-hidden="true" />
              <strong>{entry.agentName}</strong>
              {duration && <time dateTime={entry.stateSince === undefined ? undefined : new Date(entry.stateSince).toISOString()}>{duration}</time>}
            </span>
            {entry.title !== entry.agentName && entry.title !== entry.workspaceName && <span className="attention-item-meta">{entry.title}</span>}
            <span className="attention-item-source">{entry.workspaceName}</span>
            {entry.delivery && <span className="attention-item-source">{deliveryLabel(entry.delivery)}</span>}
          </button>;
        })}
      </section>)}{detachedTasks.length > 0 && <section className="attention-group"><h3>{t('Задачи без терминала')}</h3>{detachedTasks.map(task => <div key={task.id}><button className="attention-item" onClick={() => onOpenTask(task.id)}><strong>{task.name}</strong><span>{deliveryLabel(task.delivery!)}</span></button>{task.delivery?.url && <button className="button" onClick={() => void bridge().openExternal(task.delivery!.url!)}>{t('Открыть PR')}</button>}</div>)}</section>}</> : <div className="attention-empty"><p>{t('\u041d\u0435\u0442 \u0430\u0433\u0435\u043d\u0442\u043e\u0432')}</p><span>{t('\u041e\u0431\u044b\u0447\u043d\u044b\u0435 \u0442\u0435\u0440\u043c\u0438\u043d\u0430\u043b\u044b \u0437\u0434\u0435\u0441\u044c \u043d\u0435 \u043f\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u044e\u0442\u0441\u044f. \u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u0438\u0435 \u0430\u0433\u0435\u043d\u0442\u0430 \u043d\u0435 \u043e\u0437\u043d\u0430\u0447\u0430\u0435\u0442, \u0447\u0442\u043e \u0437\u0430\u0434\u0430\u0447\u0430 \u0441\u0434\u0430\u043d\u0430.')}</span></div>}
    </div>
  </section>;
}
