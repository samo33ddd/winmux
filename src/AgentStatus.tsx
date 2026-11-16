import { t } from './i18n';
import { BookOpen, FilePenLine, TerminalSquare, Search, Globe, Network, Sparkles } from 'lucide-react';
import type { Pane } from './types';

export function agentName(pane: Pane): string | undefined {
  return pane.agentLabel || pane.agentId;
}

export function activityLabel(pane: Pane): string {
  if (!agentName(pane)) return pane.status === 'running' ? t('Оболочка запущена') : t('Оболочка завершена');
  switch (pane.agentState) {
    case 'starting': return t('Запускается');
    case 'running': return t('Работает');
    case 'waiting': return t('Ожидает ввода');
    case 'idle': return t('Ожидает');
    case 'completed': return t('Завершено');
    case 'failed': return t('Ошибка');
    default: return t('Нет данных об активности');
  }
}

const actions = {
  thinking: { label: 'Обрабатывает задачу', icon: Sparkles },
  reading: { label: 'Читает файлы', icon: BookOpen },
  editing: { label: 'Изменяет файлы', icon: FilePenLine },
  command: { label: 'Выполняет команду', icon: TerminalSquare },
  searching: { label: 'Ищет информацию', icon: Search },
  browser: { label: 'Работает с браузером', icon: Globe },
  delegating: { label: 'Работает с агентами', icon: Network },
};

export function agentActionLabel(pane: Pane): string {
  const action = actions[pane.agentActivity ?? 'thinking'];
  return agentName(pane) && pane.agentState === 'running' && action ? t(action.label) : '';
}

export function AgentStatus({ pane, showName = true }: { pane: Pane; showName?: boolean }) {
  const name = agentName(pane), state = name ? pane.agentState ?? 'unknown' : pane.status;
  const label = activityLabel(pane);
  const code = name ? (state === 'completed' || state === 'failed' ? pane.agentExitCode : undefined) : (pane.status === 'exited' ? pane.exitCode : undefined);
  const actionLabel = agentActionLabel(pane);
  const ActionIcon = actions[pane.agentActivity ?? 'thinking'].icon;
  const details = [name, label, actionLabel, code !== undefined ? t('Код выхода: {0}', code) : '',
    name && state === 'unknown' ? t('Состояние оболочки не определяет активность агента.') : ''].filter(Boolean).join(' · ');
  return <span className="agent-metadata" data-testid="agent-metadata" data-agent-id={pane.agentId} data-agent-state={state} title={details}>
    <span className="agent-status-line"><span className={`activity-dot activity-${state}`} aria-hidden="true" />
      {showName && name && <span className="agent-name">{name}</span>}
      <span className="agent-state">{label}{code !== undefined ? ` (${code})` : ''}</span>
    </span>
    {actionLabel && ActionIcon && <span className="agent-action" data-testid="agent-action"><ActionIcon aria-hidden="true" /><span>{actionLabel}</span></span>}
  </span>;
}
