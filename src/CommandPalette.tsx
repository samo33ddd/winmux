import { useState } from 'react';
import { Modal } from './Dialogs';
import { t } from './i18n';

export interface PaletteAction {
  id: string;
  label: string;
  detail?: string;
  run(): void;
}

export function CommandPalette({ actions, onClose }: { actions: PaletteAction[]; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const words = query.toLocaleLowerCase().trim().split(/\s+/);
  const results = actions.filter(({ label, detail }) => {
    const text = `${label} ${detail ?? ''}`.toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
  const active = Math.min(selected, results.length - 1);
  const run = (action?: PaletteAction) => {
    if (!action) return;
    onClose();
    action.run();
  };
  return <Modal title={t('Палитра команд')} onClose={onClose}>
    <input aria-label={t('Поиск команд')} value={query} onChange={event => { setQuery(event.target.value); setSelected(0); }} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); run(results[active]); }
      if (results.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const index = (active + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        setSelected(index);
        document.getElementById(`palette-result-${index}`)?.scrollIntoView({ block: 'nearest' });
      }
    }} />
    <div className="notification-list" style={{maxHeight:'50vh',overflow:'auto'}}>
      {results.map((action, index) => <button key={action.id} id={`palette-result-${index}`} className="notification-item" aria-current={index === active || undefined} onClick={() => run(action)}>
        <strong>{index === active ? '› ' : ''}{action.label}</strong>{action.detail && <span className="notification-source">{action.detail}</span>}
      </button>)}
      {!results.length && <p role="status">{t('Команды не найдены')}</p>}
    </div>
  </Modal>;
}
