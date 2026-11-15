import { useRef, useState } from 'react';
import { getLanguage } from './i18n';
import { bridge, errorMessage } from './types';
import { colorKeys, getPreferences, paletteFor, saveCustomTheme, savePreferences, validatePalette, type Palette, type ThemeId } from './appearance';
const label = (ru:string,en:string) => getLanguage() === 'ru' ? ru : en;
export function ThemeEditor({theme}: {theme:ThemeId}) {
  const [draft,setDraft] = useState<Palette|null>(null), [error,setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const labels = [label('Фон окна','Window'),label('Терминал','Terminal'),label('Поверхности','Panels'),label('Разделители','Borders'),label('Текст','Text'),label('Вторичный текст','Secondary text'),label('Акцент','Accent'),label('Выделение','Selection'),label('Наведение','Hover')];
  function edit() { const p=paletteFor(theme); setError(''); setDraft({...p,id:theme.startsWith('custom-')?theme:`custom-${crypto.randomUUID()}`,name:theme.startsWith('custom-')?p.name:`${p.name} Custom`}); }
  async function importFile(selected?: File) {
    if (!selected) return;
    try {
      if (selected.size > 32768) throw new Error(label('Файл темы слишком большой.','Theme file is too large.'));
      const json = JSON.parse(await selected.text());
      if (json.version !== 1 || !json.theme) throw new Error(label('Неизвестный формат темы Winmux.','Unknown Winmux theme format.'));
      const imported=validatePalette({...json.theme,id:`custom-${crypto.randomUUID()}`});
      setDraft(imported); setError('');
    } catch(e) {setError(errorMessage(e));}
  }
  return <div className="custom-theme-tools">
    <div className="theme-actions"><button className="button" data-testid="theme-create" onClick={edit}>{theme.startsWith('custom-')?label('Редактировать тему','Edit theme'):label('Создать свою тему','Create a theme')}</button><button className="text-button" data-testid="theme-import" onClick={() => file.current?.click()}>{label('Импорт JSON','Import JSON')}</button><button className="text-button" data-testid="theme-export" onClick={() => {void bridge().call('theme.export',{json:JSON.stringify({version:1,theme:paletteFor(theme)},null,2)}).catch(e => setError(errorMessage(e)));}}>{label('Экспорт','Export')}</button><input hidden ref={file} type="file" accept=".json,application/json" data-testid="theme-file" onChange={e => {void importFile(e.target.files?.[0]);e.target.value='';}} /></div>
    {draft && <form className="theme-editor" data-testid="theme-editor" onSubmit={e => {e.preventDefault();try {saveCustomTheme(draft);setDraft(null);setError('');}catch(error){setError(errorMessage(error));}}}>
      <div className="theme-editor-heading"><label>{label('Название темы','Theme name')}<input required maxLength={40} data-testid="theme-name" value={draft.name} onChange={e => setDraft({...draft,name:e.target.value})} /></label><label>{label('Режим','Mode')}<select value={draft.scheme} onChange={e => setDraft({...draft,scheme:e.target.value as Palette['scheme']})}><option value="dark">{label('Тёмный','Dark')}</option><option value="light">{label('Светлый','Light')}</option></select></label></div>
      <div className="theme-color-grid">{colorKeys.map((key,index) => <label key={key}>{labels[index]}<input type="color" data-testid={`theme-color-${key}`} value={draft[key]} onChange={e => setDraft({...draft,[key]:e.target.value})} /></label>)}</div>
      <div className="custom-theme-preview" style={{background:draft.bg,color:draft.text,borderColor:draft.border}}><span style={{color:draft.muted}}>winmux</span><pre style={{background:draft.surface,color:draft.text}}><span style={{color:draft.accent}}>~/project $ </span>echo Hello<br />Hello</pre></div>
      <div className="theme-actions"><button className="button primary" data-testid="theme-save" type="submit">{label('Сохранить и применить','Save and apply')}</button><button className="text-button" type="button" onClick={() => setDraft(null)}>{label('Отмена','Cancel')}</button>{getPreferences().customThemes.some(p => p.id === draft.id) && <button className="text-button" type="button" onClick={() => {try {savePreferences({customThemes:getPreferences().customThemes.filter(p => p.id !== draft.id),theme:'dark'});setDraft(null);}catch(e){setError(errorMessage(e));}}}>{label('Удалить тему','Delete theme')}</button>}</div>
    </form>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
export function BrowserSettings() {
  const [url,setUrl] = useState(''),[busy,setBusy] = useState(false),[message,setMessage] = useState('');
  return <section className="browser-preferences"><h3>{label('Сессия встроенного браузера','Embedded browser session')}</h3><p className="preference-intro">{label('Импортируйте JSON, экспортированный из вашего браузера. Будут перенесены только cookies указанного сайта. Значения не отображаются.','Import a JSON export from your browser. Only cookies matching the specified site are imported. Cookie values are never displayed.')}</p>
    <form className="cookie-import-form" onSubmit={async e => {e.preventDefault();setBusy(true);setMessage('');try {const result=await bridge().call<{canceled?:boolean;imported:number;failed:number;skipped:number;persisted:boolean}>('cookies.import',{url});if (!result.canceled) setMessage(label(`Импортировано: ${result.imported}. Пропущено: ${result.skipped}. Ошибок: ${result.failed}. Обновите страницу браузера.${result.persisted === false?' Не удалось записать cookies на диск.':''}`,`Imported: ${result.imported}. Skipped: ${result.skipped}. Failed: ${result.failed}. Reload the browser page.${result.persisted === false?' Cookies could not be flushed to disk.':''}`));}catch(error){setMessage(errorMessage(error));}finally{setBusy(false);}}}>
      <label>{label('Адрес сайта','Site address')}<input data-testid="cookie-site" type="url" required placeholder="https://example.com" value={url} onChange={e => setUrl(e.target.value)} disabled={busy} /></label><button className="button" data-testid="cookie-import" disabled={busy}>{busy?label('Импорт…','Importing…'):label('Выбрать файл cookies','Choose cookie export')}</button>
    </form><p className="preference-intro">{label('Поддерживаются JSON-экспорты Cookie-Editor и Playwright storageState. Зашифрованные базы Chrome и Edge напрямую не читаются; некоторые сайты всё равно попросят войти снова.','Accepts Cookie-Editor JSON and Playwright storageState exports. Encrypted Chrome and Edge databases are not read directly; some sites may still require signing in again.')}</p>{message && <p className="preference-intro" role="status">{message}</p>}
  </section>;
}
