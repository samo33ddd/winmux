import { t } from './i18n';
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
    case 'completed': return t('Завершено');
    case 'failed': return t('Ошибка');
    default: return t('Активность неизвестна');
  }
}

export function AgentStatus({ pane, showName = true }: { pane: Pane; showName?: boolean }) {
  const name = agentName(pane), state = name ? pane.agentState ?? 'unknown' : pane.status;
  const label = activityLabel(pane), code = name ? pane.agentExitCode : pane.exitCode;
  const details = [name, label, code !== undefined ? t('Код выхода: {0}', code) : '',
    name && state === 'unknown' ? t('Состояние оболочки не определяет активность агента.') : ''].filter(Boolean).join(' · ');
  return <span className="agent-metadata" data-testid="agent-metadata" data-agent-id={pane.agentId} data-agent-state={state} title={details}>
    <span className={`activity-dot activity-${state}`} aria-hidden="true" />
    {showName && name && <span className="agent-name">{name}</span>}
    <span className="agent-state">{label}{code !== undefined ? ` (${code})` : ''}</span>
  </span>;
}
