import { useState } from 'react';
import { t } from './i18n';
import { bridge, type TaskDelivery } from './types';
import './tasks.css';

export function deliveryLabel(delivery: TaskDelivery): string {
  if (delivery.state === 'MERGED') return t('PR слит');
  if (delivery.action === 'submit' && delivery.code === null) return t('PR создан — проверьте статус');
  switch (delivery.code) {
    case 'NOT_FOUND': return t('PR ещё не создан');
    case 'NO_INDEPENDENT_APPROVAL': return t('Ожидается независимое ревью');
    case 'CHECKS_PENDING': return t('CI выполняется');
    case 'CHECKS_FAILED': return t('CI завершился ошибкой');
    case 'STALE_HEAD': return t('Изменилась версия PR');
    case 'MERGE_BLOCKED': return t('Слияние заблокировано');
    case null: return t('PR готов к слиянию');
    default: return t('Не удалось подтвердить состояние PR');
  }
}

export interface TaskWorkspaceLink { id: string; name: string }

export interface ProjectTaskEntry {
  id: string;
  name: string;
  branch: string;
  path: string;
  archived?: boolean;
  workspace?: TaskWorkspaceLink;
  error?: string;
  archiveReason?: string;
  deliverySupport?: string;
  delivery?: TaskDelivery;
}

export interface ProjectTaskGroup {
  id: string;
  name: string;
  root: string;
  tasks: ProjectTaskEntry[];
}

export interface ProjectTasksProps {
  projects: ProjectTaskGroup[];
  onOpen(task: ProjectTaskEntry, project: ProjectTaskGroup): void;
  onArchive(task: ProjectTaskEntry, project: ProjectTaskGroup): void;
  onRefresh(task: ProjectTaskEntry): void;
}

export function ProjectTasks({ projects, onOpen, onArchive, onRefresh }: ProjectTasksProps) {
  const [showArchived, setShowArchived] = useState(false);
  return <section className="task-projects" aria-label={t('Проекты и задачи')} data-testid="project-tasks">
    <label className="task-archive-filter"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} /> {t('Показать архив')}</label>
    {projects.map(project => {
      const tasks = project.tasks.filter(task => showArchived || !task.archived);
      return <section className="task-project" key={project.id} aria-labelledby={`project-${project.id}`}>
        <div className="task-project-heading"><strong id={`project-${project.id}`}>{project.name}</strong><code>{project.root}</code></div>
        {tasks.length ? <ul>{tasks.map(task => <li className="task-row" key={task.id} data-archived={task.archived ? 'true' : 'false'}>
          <button className="task-identity" aria-label={t('Открыть задачу {0}', task.name)} onClick={() => onOpen(task, project)}><strong>{task.name}</strong><span>{task.branch}{task.workspace ? ` · ${t('Пространство: {0}', task.workspace.name)}` : ''}{task.archived ? ` · ${t('Архивная')}` : ''}</span>{task.deliverySupport === 'unsupported' && <span role="status">{t('Автоматическая доставка этим агентом пока недоступна.')}</span>}{(task.error || task.archiveReason) && <span role="status">{task.error || task.archiveReason}</span>}</button>
          {task.delivery && <span role="status">{deliveryLabel(task.delivery)}{task.delivery.number ? ` · #${task.delivery.number}` : ''}{task.delivery.url && <button className="text-button" onClick={() => void bridge().openExternal(task.delivery!.url!)}>{t('Открыть PR')}</button>}</span>}
          {task.deliverySupport === 'hooks' && <span role="status">{t('Для инструкции доставки включите и разрешите Winmux UserPromptSubmit в Codex /hooks.')}</span>}
          <div className="task-actions"><button className="button" onClick={() => onOpen(task, project)}>{t('Открыть')}</button>{!task.archived && <><button className="button" onClick={() => onRefresh(task)}>{t('Проверить PR')}</button><button className="button" aria-label={t('Архивировать задачу {0}', task.name)} onClick={() => onArchive(task, project)}>{t('Архив')}</button></>}</div>
        </li>)}</ul> : <p className="task-empty">{t('Задач нет.')}</p>}
      </section>;
    })}
  </section>;
}
