import { t } from './i18n';
import { AgentStatus } from './AgentStatus';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { terminalTheme } from './appearance';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ArrowDown, ArrowUp, Copy, Maximize2, Minimize2, Search, SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react';
import { bridge, errorMessage, readClipboard, writeClipboard, type BackendEvent, type Direction, type Pane, type Settings, type Snapshot } from './types';

export interface TerminalHandle { focus(): void; search(): void; copy(): Promise<void>; paste(): Promise<void> }
interface Props {
  pane: Pane; settings: Settings; visible: boolean; active: boolean; zoomed: boolean; unread: boolean;
  style: React.CSSProperties; register(id: string, handle: TerminalHandle | null): void;
  onFocus(id: string): void; onSplit(id: string, direction: Direction): void; onClose(id: string): void;
  onZoom(id: string): void; onError(message: string): void;
}

export function TerminalPane(props: Props) {
  const { pane, settings, visible, active, zoomed, style } = props;
  const current = useRef(props); current.current = props;
  const mount = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const fitNow = useRef<() => void>(() => {});
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [match, setMatch] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [ready, setReady] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!mount.current) return;
    let disposed = false, hydrated = false, failed = false, seq = -1, frame = 0;
    let pending: Extract<BackendEvent, { type: 'output' }>[] = [];
    let lastSize = '';
    setReady(false); setLoadError('');
    const term = new Terminal({
      cols: current.current.pane.cols || 80, rows: current.current.pane.rows || 24,
      fontFamily: `"${current.current.settings.fontFamily}", Consolas, monospace`,
      fontSize: current.current.settings.fontSize, lineHeight: current.current.settings.lineHeight,
      theme: terminalTheme(current.current.settings.theme), cursorBlink: current.current.settings.cursorBlink,
      cursorStyle: current.current.settings.cursorStyle,
      scrollback: current.current.settings.scrollback, allowProposedApi: true, convertEol: false,
    });
    // The daemon's headless terminal answers device/status queries. A second
    // response from this display would be injected into the shell as input.
    const queryGuards = [
      term.parser.registerCsiHandler({final:'c'}, () => true),
      term.parser.registerCsiHandler({prefix:'>',final:'c'}, () => true),
      term.parser.registerCsiHandler({final:'n'}, () => true),
      term.parser.registerCsiHandler({prefix:'?',final:'n'}, () => true),
    ];
    const fitAddon = new FitAddon(); const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon); term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon((_event, url) => {
      if (/^https?:\/\//i.test(url)) void bridge().openExternal(url).catch(error => current.current.onError(errorMessage(error)));
    }));
    term.open(mount.current); terminal.current = term; fit.current = fitAddon; search.current = searchAddon;
    const resize = () => {
      if (disposed || !hydrated || !mount.current || !current.current.visible || mount.current.clientWidth < 2 || mount.current.clientHeight < 2) return;
      try {
        fitAddon.fit();
        const size = `${term.cols}:${term.rows}`;
        if (lastSize !== size && current.current.pane.status === 'running') {
          lastSize = size;
          void bridge().call('pane.resize', { paneId: pane.id, cols: term.cols, rows: term.rows }).catch(error => {
            lastSize = ''; if (!disposed) current.current.onError(errorMessage(error));
          });
        }
      } catch (error) { if (!disposed) current.current.onError(errorMessage(error)); }
    };
    const scheduleFit = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(resize); };
    fitNow.current = scheduleFit;
    const observer = new ResizeObserver(scheduleFit); observer.observe(mount.current);
    const writeOutput = (event: Extract<BackendEvent, { type: 'output' }>) => {
      if (event.seq <= seq) return;
      seq = event.seq; term.write(event.data);
    };
    // Subscribe before requesting the snapshot: output may arrive while serialization is in flight.
    const unsubscribe = bridge().onEvent(event => {
      // A CLI or another window may close the pane before React unmounts it.
      // Retire pending input/resize callbacks as soon as removal is observed.
      if (event.type === 'state' && !event.state.workspaces.some(workspace => workspace.panes.some(item => item.id === pane.id))) { disposed = true; return; }
      if (event.type !== 'output' || event.paneId !== pane.id || disposed || failed) return;
      if (!hydrated) pending.push(event); else writeOutput(event);
    });
    const input = term.onData(data => {
      if (hydrated && current.current.pane.status === 'running') {
        void bridge().call('pane.input', { paneId: pane.id, data }).catch(error => {
          if (!disposed) current.current.onError(errorMessage(error));
        });
      }
    });
    let selecting = false;
    const selectionStart = (event: PointerEvent) => { selecting = event.button === 0; };
    const selectionEnd = () => {
      if (!selecting) return; selecting = false;
      requestAnimationFrame(() => {
        if (disposed || !current.current.settings.copyOnSelect) return;
        const text = term.getSelection();
        if (text) void writeClipboard(text).catch(error => current.current.onError(errorMessage(error)));
      });
    };
    mount.current.addEventListener('pointerdown', selectionStart);
    document.addEventListener('pointerup', selectionEnd);
    const onFocus = () => current.current.onFocus(pane.id);
    mount.current.addEventListener('focusin', onFocus);
    term.attachCustomKeyEventHandler(event => {
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && ['d', 'e', 'w', 'f', 'n', 'u', 'enter', 'c', 'v'].includes(key)) return false;
      if (event.altKey && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) return false;
      if (event.ctrlKey && key === ',') return false;
      if (event.ctrlKey && (key === 't' || key === 'tab')) return false;
      return true;
    });
    current.current.register(pane.id, {
      focus: () => term.focus(),
      search: () => { setSearchOpen(true); requestAnimationFrame(() => searchInput.current?.focus()); },
      copy: async () => { const text = term.getSelection(); if (text) await writeClipboard(text); },
      paste: async () => { if (hydrated && current.current.pane.status === 'running') term.paste(await readClipboard()); },
    });
    void bridge().call<Snapshot>('pane.snapshot', { paneId: pane.id }).then(snapshot => {
      if (disposed) return;
      term.resize(snapshot.cols, snapshot.rows);
      term.write(snapshot.data, () => {
        if (disposed) return;
        seq = snapshot.seq;
        pending.sort((a, b) => a.seq - b.seq).forEach(writeOutput);
        pending = []; hydrated = true; setReady(true); scheduleFit();
        if (current.current.visible && current.current.active && !document.querySelector('[role="dialog"]')) term.focus();
      });
    }).catch(error => { if (!disposed) { failed = true; setLoadError(errorMessage(error)); pending = []; } });
    return () => {
      disposed = true; unsubscribe(); observer.disconnect(); cancelAnimationFrame(frame); input.dispose();
      mount.current?.removeEventListener('focusin', onFocus);
      mount.current?.removeEventListener('pointerdown', selectionStart);
      document.removeEventListener('pointerup', selectionEnd);
      current.current.register(pane.id, null); term.dispose(); terminal.current = null; fit.current = null; search.current = null;
      queryGuards.forEach(guard => guard.dispose());
    };
  }, [pane.id, retry]);
  useEffect(() => {
    if (!terminal.current) return;
    terminal.current.options.theme = terminalTheme(settings.theme);
    terminal.current.options.fontSize = settings.fontSize;
    terminal.current.options.fontFamily = `"${settings.fontFamily}", Consolas, monospace`;
    terminal.current.options.lineHeight = settings.lineHeight;
    terminal.current.options.cursorStyle = settings.cursorStyle;
    terminal.current.options.cursorBlink = settings.cursorBlink;
    terminal.current.options.scrollback = settings.scrollback;
    fitNow.current();
  }, [settings.theme, settings.customThemes, settings.fontSize, settings.fontFamily, settings.lineHeight, settings.cursorStyle, settings.cursorBlink, settings.scrollback]);
  useEffect(() => { if (visible) fitNow.current(); else setContextMenu(null); }, [visible]);
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  function find(previous = false) {
    if (!query) { search.current?.clearDecorations(); setMatch(null); return; }
    setMatch((previous ? search.current?.findPrevious(query, { incremental: true }) : search.current?.findNext(query, { incremental: true })) ?? false);
  }
  function closeSearch() { setSearchOpen(false); search.current?.clearDecorations(); setMatch(null); terminal.current?.focus(); }
  return <section className={`terminal-pane ${active ? 'is-active' : ''} ${props.unread ? 'has-attention' : ''}`} style={{ ...style, display: visible ? undefined : 'none' }} data-pane-id={pane.id} data-testid="terminal-pane" aria-label={t("Терминал {0}", pane.title)} onPointerDown={() => props.onFocus(pane.id)}>
    <div className="pane-header">
      <span className={`process-dot ${pane.status}`} title={pane.status === 'running' ? t("Процесс запущен{0}", pane.pid ? ` · PID ${pane.pid}` : '') : t("Процесс завершён · код {0}", pane.exitCode ?? t("неизвестен"))} />
      <span className="pane-title" title={t("{0}\nСтартовый каталог: {1}", pane.title, pane.cwd)}>{pane.title}</span>
      <AgentStatus pane={pane} />
      {props.unread && <span className="unread-dot" aria-label={t("Непрочитанное уведомление")} title={t("Есть непрочитанное уведомление")} />}
      <div className="pane-tools">
        <button className="icon-button" title={t("Поиск в терминале (Ctrl+Shift+F)")} aria-label={t("Поиск в терминале")} onClick={() => setSearchOpen(value => !value)}><Search /></button>
        <button className="icon-button secondary-tool" title={t("Копировать выделенное (Ctrl+Shift+C)")} aria-label={t("Копировать выделенное")} onClick={() => { const text = terminal.current?.getSelection(); if (text) void writeClipboard(text).catch(error => props.onError(errorMessage(error))); }}><Copy /></button>
        <button className="icon-button" title={t("Разделить слева направо (Ctrl+Shift+D)")} aria-label={t("Разделить слева направо")} onClick={() => props.onSplit(pane.id, 'horizontal')}><SplitSquareHorizontal /></button>
        <button className="icon-button secondary-tool" title={t("Разделить сверху вниз (Ctrl+Shift+E)")} aria-label={t("Разделить сверху вниз")} onClick={() => props.onSplit(pane.id, 'vertical')}><SplitSquareVertical /></button>
        <button className="icon-button" title={t("Развернуть панель (Ctrl+Shift+Enter)")} aria-label={zoomed ? t("Вернуть раскладку") : t("Развернуть панель")} onClick={() => props.onZoom(pane.id)}>{zoomed ? <Minimize2 /> : <Maximize2 />}</button>
        <button className="icon-button close-tool" title={t("Закрыть панель (Ctrl+Shift+W)")} aria-label={t("Закрыть панель")} onClick={() => props.onClose(pane.id)}><X /></button>
      </div>
    </div>
    {searchOpen && <div className="terminal-search" role="search">
      <Search /><input ref={searchInput} aria-label={t("Найти в выводе терминала")} placeholder={t("Найти в терминале")} value={query} onChange={event => { const value = event.target.value; setQuery(value); setMatch(value ? search.current?.findNext(value, { incremental: true }) ?? false : null); if (!value) search.current?.clearDecorations(); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey); } if (event.key === 'Escape') { event.stopPropagation(); closeSearch(); } }} />
      {match === false && <span className="search-miss" role="status">{t("Не найдено")}</span>}
      <button className="icon-button" aria-label={t("Предыдущее совпадение")} title={t("Предыдущее (Shift+Enter)")} onClick={() => find(true)}><ArrowUp /></button>
      <button className="icon-button" aria-label={t("Следующее совпадение")} title={t("Следующее (Enter)")} onClick={() => find()}><ArrowDown /></button>
      <button className="icon-button" aria-label={t("Закрыть поиск")} onClick={closeSearch}><X /></button>
    </div>}
    <div className="terminal-body" ref={mount} onContextMenu={event => { event.preventDefault(); setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 210), y: Math.min(event.clientY, window.innerHeight - 100) }); }} />
    {contextMenu && <div className="context-menu-backdrop" onPointerDown={() => setContextMenu(null)} onKeyDown={event => { if (event.key === 'Escape') { setContextMenu(null); terminal.current?.focus(); } }}><div role="menu" aria-label={t("Буфер обмена терминала")} className="terminal-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={event => event.stopPropagation()}>
      <button role="menuitem" disabled={!terminal.current?.hasSelection()} onClick={() => { const text = terminal.current?.getSelection(); if (text) void writeClipboard(text).catch(error => props.onError(errorMessage(error))); setContextMenu(null); }}>{t("Копировать")} <span>Ctrl+Shift+C</span></button>
      <button role="menuitem" disabled={!ready || pane.status !== 'running'} autoFocus onClick={() => { void readClipboard().then(text => terminal.current?.paste(text)).catch(error => props.onError(errorMessage(error))); setContextMenu(null); terminal.current?.focus(); }}>{t("Вставить")} <span>Ctrl+Shift+V</span></button>
    </div></div>}
    {!ready && <div className="terminal-loading" role="status">{loadError ? <><span>{loadError}</span><button className="button" onClick={() => setRetry(value => value + 1)}>{t("Повторить подключение")}</button></> : <span>{t("Подключение к терминалу…")}</span>}</div>}
  </section>;
}
