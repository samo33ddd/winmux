import { createElement, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CircleAlert, ExternalLink, Globe, Plus, RefreshCw, X } from 'lucide-react';
import { getLanguage, t } from './i18n';
import { bridge, errorMessage } from './types';

const text = (en: string, ru: string) => getLanguage() === 'ru' ? ru : en;
const MAX_TABS = 12;
interface BrowserElement extends HTMLElement {
  loadURL(url: string): Promise<void>; getURL(): string; getTitle(): string;
  canGoBack(): boolean; canGoForward(): boolean; goBack(): void; goForward(): void; reload(): void;
}
interface BrowserTab { id: string; title: string; url: string }
interface BrowserRequest { url: string; serial: number }
const newTab = (): BrowserTab => ({ id: crypto.randomUUID(), title: '', url: '' });

export function BrowserPanel({ active, requested }: { active: boolean; requested?: BrowserRequest }) {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [newTab()]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ?? tabs[0].id;
  const [navigation, setNavigation] = useState<(BrowserRequest & { tabId: string }) | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  // A CLI request belongs to the tab selected when it arrives; switching tabs must not replay it.
  useEffect(() => { if (requested) setNavigation({ ...requested, tabId: selected }); }, [requested?.serial]);
  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);
  function add() {
    if (tabs.length >= MAX_TABS) return;
    const tab = newTab(); setTabs(previous => [...previous, tab]); setSelectedId(tab.id);
  }
  function close(id: string) {
    const index = tabs.findIndex(tab => tab.id === id);
    const remaining = tabs.filter(tab => tab.id !== id);
    if (!remaining.length) remaining.push(newTab());
    setTabs(remaining);
    if (id === selected) setSelectedId(remaining[Math.min(index, remaining.length - 1)].id);
  }
  function update(id: string, title: string, url: string) {
    setTabs(previous => previous.map(tab => tab.id === id && (tab.title !== title || tab.url !== url) ? { ...tab, title, url } : tab));
  }
  return <div className="tool-tab-content browser-panel" hidden={!active}>
    <div className="browser-tabs-heading">
      <div ref={strip} className="browser-tabs" role="tablist" aria-label={text('Browser tabs', 'Вкладки браузера')}>
        {tabs.map((tab, index) => {
          const label = tab.title || tab.url || text('New tab', 'Новая вкладка');
          return <div key={tab.id} className={`browser-tab ${selected === tab.id ? 'selected' : ''}`} role="presentation">
            <button type="button" role="tab" id={`browser-tab-${tab.id}`} aria-controls={`browser-page-${tab.id}`} aria-selected={selected === tab.id} tabIndex={selected === tab.id ? 0 : -1} data-testid="browser-tab" data-browser-tab-id={tab.id} title={tab.url ? `${label}\n${tab.url}` : label} onClick={() => setSelectedId(tab.id)} onKeyDown={event => {
              let next = index;
              if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
              else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = tabs.length - 1;
              else return;
              event.preventDefault(); setSelectedId(tabs[next].id);
              document.getElementById(`browser-tab-${tabs[next].id}`)?.focus();
            }}><Globe /><span>{label}</span></button>
            <button type="button" className="browser-tab-close" data-testid="browser-tab-close" aria-label={`${text('Close tab', 'Закрыть вкладку')}: ${label}`} title={text('Close tab', 'Закрыть вкладку')} onClick={() => close(tab.id)}><X /></button>
          </div>;
        })}
      </div>
      <button type="button" className="icon-button browser-tab-add" data-testid="browser-tab-add" aria-label={text('New browser tab', 'Новая вкладка браузера')} title={tabs.length >= MAX_TABS ? text('Tab limit reached (12)', 'Достигнут лимит вкладок (12)') : text('New browser tab', 'Новая вкладка браузера')} disabled={tabs.length >= MAX_TABS} onClick={add}><Plus /></button>
    </div>
    {tabs.map(tab => <BrowserPage key={tab.id} id={tab.id} selected={selected === tab.id} active={active && selected === tab.id} requested={navigation?.tabId === tab.id ? navigation : undefined} onMetadata={update} />)}
  </div>;
}

function BrowserPage({ id, selected, active, requested, onMetadata }: { id: string; selected: boolean; active: boolean; requested?: BrowserRequest; onMetadata(id: string, title: string, url: string): void }) {
  const view = useRef<BrowserElement | null>(null);
  const [source, setSource] = useState(''); const [address, setAddress] = useState('');
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false); const [history, setHistory] = useState({ back: false, forward: false });
  const metadata = useRef(onMetadata); metadata.current = onMetadata;
  const latestNavigation = useRef(0);
  const mounted = Boolean(source);
  useEffect(() => {
    const element = view.current; if (!element) return;
    let alive = true;
    function sync() {
      try {
        const url = element!.getURL(); const title = element!.getTitle();
        setAddress(url); metadata.current(id, title, url);
        setHistory({ back: element!.canGoBack(), forward: element!.canGoForward() });
      } catch (error) { if (alive) setError(errorMessage(error)); }
    }
    const onReady = () => { setReady(true); sync(); };
    const start = () => { setLoading(true); setError(''); };
    const stop = () => { setLoading(false); sync(); };
    const fail = (event: Event) => {
      const detail = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
      if (detail.errorCode === -3 || detail.isMainFrame === false) return;
      setLoading(false); setError(detail.errorDescription ? t('Страница не загрузилась: {0}', detail.errorDescription) : t('Страница не загрузилась. Проверьте адрес и запущен ли сервер.'));
    };
    const events: [string, EventListener][] = [['dom-ready', onReady], ['did-start-loading', start], ['did-stop-loading', stop], ['did-navigate', sync], ['did-navigate-in-page', sync], ['page-title-updated', sync], ['did-fail-load', fail]];
    events.forEach(([name, callback]) => element.addEventListener(name, callback));
    return () => { alive = false; latestNavigation.current++; events.forEach(([name, callback]) => element.removeEventListener(name, callback)); };
  }, [mounted, id]);
  useEffect(() => { if (requested) navigate(requested.url); }, [requested?.serial]);
  function navigate(requestedAddress = address) {
    try {
      let input = requestedAddress.trim(); if (!input) return;
      if (!/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
        if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(input)) input = `http://${input}`;
        else if (/^[a-z][a-z\d+.-]*:/i.test(input)) throw new Error(t('Разрешены только адреса HTTP и HTTPS.'));
        else input = `https://${input}`;
      }
      const url = new URL(input);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(t('Укажите адрес HTTP или HTTPS без логина и пароля.'));
      setError(''); setAddress(url.href); setLoading(true);
      const request = ++latestNavigation.current;
      if (view.current && ready) void view.current.loadURL(url.href).catch(error => {
        if (request === latestNavigation.current && (error as { code?: string }).code !== 'ERR_ABORTED') { setLoading(false); setError(errorMessage(error)); }
      });
      else { setSource(url.href); metadata.current(id, '', url.href); }
    } catch (error) { setLoading(false); setError(errorMessage(error)); }
  }
  function control(action: (element: BrowserElement) => void) {
    try { if (view.current && ready) action(view.current); } catch (error) { setError(errorMessage(error)); }
  }
  return <div id={`browser-page-${id}`} className="browser-page" role="tabpanel" aria-labelledby={`browser-tab-${id}`} hidden={!selected} data-browser-tab-id={id} data-browser-tab-active={selected}>
    <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); navigate(); }}>
      <button type="button" className="icon-button" aria-label={t('Назад в браузере')} title={t('Назад в браузере')} disabled={!ready || !history.back} onClick={() => control(element => element.goBack())}><ArrowLeft /></button>
      <button type="button" className="icon-button" aria-label={t('Вперёд в браузере')} title={t('Вперёд в браузере')} disabled={!ready || !history.forward} onClick={() => control(element => element.goForward())}><ArrowRight /></button>
      <button type="button" className="icon-button" aria-label={t('Обновить страницу')} title={t('Обновить страницу')} disabled={!ready} onClick={() => control(element => element.reload())}><RefreshCw className={loading ? 'browser-loading' : ''} /></button>
      <input data-testid={active ? 'browser-url' : 'browser-url-inactive'} aria-label={t('Адрес страницы')} placeholder="localhost:3000" value={address} onChange={event => setAddress(event.target.value)} spellCheck={false} />
      <button className="icon-button" type="submit" aria-label={t('Открыть страницу')} title={t('Открыть страницу')} data-testid={active ? 'browser-go' : 'browser-go-inactive'} disabled={!address.trim()}><ArrowRight /></button>
      <button className="icon-button" type="button" aria-label={t('Открыть во внешнем браузере')} title={t('Открыть во внешнем браузере')} disabled={!ready} onClick={() => control(element => { const url = element.getURL(); if (/^https?:\/\//i.test(url)) void bridge().openExternal(url).catch(error => setError(errorMessage(error))); })}><ExternalLink /></button>
    </form>
    {error && <div className="tool-message inline-error" role="alert"><CircleAlert />{error}</div>}
    {mounted ? createElement('webview', { ref: view, src: source, partition: 'persist:winmux-browser', webpreferences: 'contextIsolation=yes,sandbox=yes', className: 'embedded-browser', 'data-testid': active ? 'embedded-browser' : 'embedded-browser-inactive', 'data-browser-tab-id': id, 'data-browser-tab-active': selected, 'data-browser-active': active, 'aria-label': t('Встроенный браузер') }) : <div className="browser-empty"><Globe /><h3>{t('Приложение рядом с кодом')}</h3><p>{t('Запустите сервер в терминале и введите его адрес сверху. Можно открыть любой HTTP- или HTTPS-сайт.')}</p><label>{t('Адрес для предпросмотра')}<input aria-label={t('Адрес для предпросмотра')} placeholder="http://localhost:3000" value={address} onChange={event => setAddress(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') navigate(); }} /></label><button className="button" disabled={!address.trim()} onClick={() => navigate()}>{t('Открыть страницу')}</button></div>}
  </div>;
}
