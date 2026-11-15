import { useState, type CSSProperties, type ReactNode } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import { Modal } from './Dialogs';
import { getLanguage, setLanguage, t } from './i18n';
import { allPalettes, type ThemeId } from './appearance';
import { ThemeEditor, BrowserSettings } from './ThemeEditor';
import type { Profile, Settings, Workspace } from './types';
import { SkillsSettings } from './SkillsSettings';

function Row({title, detail, children}: {title:string; detail?:string; children:ReactNode}) {
  return <div className="preference-row"><div><strong>{title}</strong>{detail && <p>{detail}</p>}</div>{children}</div>;
}
function Toggle({label, checked, onChange, testId, disabled=false}: {label:string; checked:boolean; onChange(value:boolean):void; testId:string; disabled?:boolean}) {
  return <button className="preference-switch" role="switch" aria-label={label} aria-checked={checked} data-testid={testId} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}
export function SettingsDialog({settings, profiles, workspaces, activeWorkspaceId, agentHooks, agentHooksAvailable, onAgentHooksChange, onSkillStarted, onChange, onClose}: {settings:Settings; profiles:Profile[]; workspaces:Workspace[]; activeWorkspaceId?:string; agentHooks:boolean; agentHooksAvailable:boolean; onAgentHooksChange(value:boolean):void; onSkillStarted(workspaceId:string,paneId:string):void; onChange(values:Partial<Settings>):Promise<void>; onClose():void}) {
  const [tab,setTab] = useState<'appearance'|'terminal'|'behavior'|'browser'|'skills'>('appearance');
  const change = (values:Partial<Settings>) => { void onChange(values); };
  return <Modal title={t('Настройки')} className="preferences-modal" onClose={onClose}>
    <div className="preferences-tabs" role="group" aria-label={t('Раздел настроек')}>
      {(['appearance','terminal','behavior','browser','skills'] as const).map((id,index) => <button key={id} aria-pressed={tab === id} data-testid={`settings-tab-${id}`} onClick={() => setTab(id)}>{[t('Оформление'),t('Терминал'),t('Поведение'),t('Браузер'),t('Навыки')][index]}</button>)}
    </div>
    <div className="preferences-body">
      {tab === 'appearance' && <>
        <h3>{t('Цветовая тема')}</h3><p className="preference-intro">{t('Одна палитра для окна и терминалов.')}</p>
        <div className="theme-grid" role="group" aria-label={t('Цветовая тема')}>
          {allPalettes().map(p => <button key={p.id} data-testid={`theme-${p.id}`} className="theme-choice" aria-pressed={settings.theme === p.id} onClick={() => change({theme:p.id as ThemeId})} style={{'--sample-bg':p.bg,'--sample-surface':p.surface,'--sample-text':p.text,'--sample-accent':p.accent} as CSSProperties}>
            <span className="theme-sample" aria-hidden="true"><span className="theme-sample-rail" /><span className="theme-sample-terminal"><span>~ / winmux</span><i /><i /></span></span>
            <span className="theme-caption">{p.name}{settings.theme === p.id && <Check />}</span>
          </button>)}
        </div>
        <ThemeEditor theme={settings.theme} />
        <Row title={t('Язык')}><div className="segmented"><button data-testid="language-en" aria-pressed={getLanguage() === 'en'} onClick={() => setLanguage('en')}>English</button><button data-testid="language-ru" aria-pressed={getLanguage() === 'ru'} onClick={() => setLanguage('ru')}>Русский</button></div></Row>
        <Row title={t('Пути в списке проектов')} detail={t('Показывать стартовый каталог под названием.')}><Toggle label={t('Пути в списке проектов')} testId="workspace-paths" checked={settings.showWorkspacePaths} onChange={showWorkspacePaths => change({showWorkspacePaths})} /></Row>
      </>}
      {tab === 'terminal' && <>
        <Row title={t('Шрифт терминала')} detail={t('Cascadia Code использует Consolas, если шрифт не установлен.')}><select aria-label={t('Шрифт терминала')} data-testid="font-family" value={settings.fontFamily} onChange={e => change({fontFamily:e.target.value as Settings['fontFamily']})}>{['Cascadia Code','Consolas','Courier New'].map(font => <option key={font}>{font}</option>)}</select></Row>
        <Row title={t('Размер шрифта')}><div className="font-stepper"><button className="icon-button" aria-label={t('Уменьшить шрифт')} disabled={settings.fontSize <= 10} onClick={() => change({fontSize:settings.fontSize-1})}><Minus /></button><output data-testid="font-size">{settings.fontSize} px</output><button className="icon-button" aria-label={t('Увеличить шрифт')} disabled={settings.fontSize >= 28} onClick={() => change({fontSize:settings.fontSize+1})}><Plus /></button></div></Row>
        <Row title={t('Межстрочный интервал')}><select aria-label={t('Межстрочный интервал')} data-testid="line-height" value={settings.lineHeight} onChange={e => change({lineHeight:Number(e.target.value)})}>{[1,1.14,1.3,1.5].map(value => <option key={value} value={value}>{value}</option>)}</select></Row>
        <Row title={t('Форма курсора')}><select aria-label={t('Форма курсора')} data-testid="cursor-style" value={settings.cursorStyle} onChange={e => change({cursorStyle:e.target.value as Settings['cursorStyle']})}><option value="bar">{t('Вертикальная линия')}</option><option value="block">{t('Блок')}</option><option value="underline">{t('Подчёркивание')}</option></select></Row>
        <Row title={t('Мигание курсора')}><Toggle label={t('Мигание курсора')} testId="cursor-blink" checked={settings.cursorBlink} onChange={cursorBlink => change({cursorBlink})} /></Row>
        <div className="font-preview" aria-label={t('Пример шрифта')} style={{fontFamily:`"${settings.fontFamily}", Consolas, monospace`,fontSize:settings.fontSize,lineHeight:settings.lineHeight}}><span>PS ~/winmux&gt;</span> echo "Hello, Winmux"<br />Hello, Winmux <span>▏</span></div>
      </>}
      {tab === 'behavior' && <>
        <Row title={t('Хуки статуса агента')} detail={t('Хуки только для этого запуска поддерживаемого агента. Глобальные настройки не изменяются.')}><Toggle label={t('Хуки статуса агента')} testId="agent-status-hooks" checked={agentHooks} disabled={!agentHooksAvailable} onChange={onAgentHooksChange} /></Row>
        <Row title={t('Копировать при выделении')} detail={t('Выделенный мышью текст сразу попадает в буфер обмена.')}><Toggle label={t('Копировать при выделении')} testId="copy-on-select" checked={settings.copyOnSelect} onChange={copyOnSelect => change({copyOnSelect})} /></Row>
        <Row title={t('История прокрутки')} detail={t('Количество строк в окне терминала. Уменьшение удаляет старые строки из просмотра.')}><select aria-label={t('История прокрутки')} data-testid="scrollback" value={settings.scrollback} onChange={e => change({scrollback:Number(e.target.value)})}>{[1000,5000,10000].map(value => <option key={value} value={value}>{value}</option>)}</select></Row>
        <div className="profile-settings"><h3>{t('Среды запуска')}</h3>{profiles.map(profile => <div className="profile-status" key={profile.id}><span>{profile.label}<small>{profile.environment === 'wsl' ? profile.distro ?? 'WSL' : 'Windows'}</small></span><span className={profile.available === false ? 'muted' : 'available'}>{profile.available === false ? t('Недоступен') : t('Доступен')}</span></div>)}</div>
        <p className="preference-intro">{t('Закрытие окна оставляет терминалы работать в фоне. Закрытие панели или пространства завершает их процессы.')}</p>
      </>}
      {tab === 'browser' && <BrowserSettings />}
      {tab === 'skills' && <SkillsSettings workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onStarted={onSkillStarted} />}
    </div>
    <div className="preferences-footer">{t('Изменения применяются сразу и сохраняются автоматически.')}</div>
  </Modal>;
}
