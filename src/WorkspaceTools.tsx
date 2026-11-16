import { getLanguage, t } from './i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, CircleAlert, File, FileImage, FileText, Folder, FolderOpen, GitBranch, Globe, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react';
import { BrowserPanel } from './BrowserTabs';
import { bridge, errorMessage, type Workspace } from './types';
import { selectedPane } from './workspaceTabs';
import { beginPreviewIntent, previewPresented } from './previewCoordinator';
import { FileEditor } from './FileEditor';
import { getFileDraft, setFileDraft } from './fileDrafts';

export type ToolTab = 'files' | 'git' | 'browser';
interface Entry { name: string; path: string; type: 'directory' | 'file' | 'symlink'; size: number }
interface Directory { path: string; entries: Entry[]; truncated?: boolean }
interface FileContent { path: string; kind: 'text' | 'image' | 'binary'; text?: string; dataUrl?: string; size: number; truncated?: boolean }
interface GitState { available: boolean; branch: string; entries: { path: string; index: string; worktree: string }[]; error?: string }
const text = (en: string, ru: string) => getLanguage() === 'ru' ? ru : en;
function sizeLabel(size: number) { return size < 1024 ? t("{0} Б", size) : size < 1048576 ? t("{0} КБ", (size / 1024).toFixed(1)) : t("{0} МБ", (size / 1048576).toFixed(1)); }
function Message({ children, error = false }: { children: ReactNode; error?: boolean }) { return <div className={`tool-message ${error ? 'inline-error' : ''}`} role={error ? 'alert' : 'status'}>{error && <CircleAlert />}{children}</div>; }
function ToolSplit({ first, second, label, testId, horizontal = false }: { first: ReactNode; second?: ReactNode; label: string; testId: string; horizontal?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; offset: number } | null>(null);
  const [ratio, setRatio] = useState(38);
  const [dragging, setDragging] = useState(false);
  function clamp(value: number) {
    const bounds = container.current?.getBoundingClientRect();
    const height = ((horizontal ? bounds?.width : bounds?.height) || 400) - 6;
    const minimum = Math.min(30, 64 / Math.max(1, height) * 100);
    return Math.min(100 - minimum, Math.max(minimum, value));
  }
  return <div ref={container} className={`tool-split ${horizontal ? 'horizontal' : ''} ${second ? 'has-preview' : ''} ${dragging ? 'dragging' : ''}`} style={second ? { [horizontal ? 'gridTemplateColumns' : 'gridTemplateRows']: `minmax(0, ${horizontal ? 100 - ratio : ratio}fr) 6px minmax(0, ${horizontal ? ratio : 100 - ratio}fr)` } : undefined}>
    {first}
    {second && <><div className="tool-content-resizer" role="separator" aria-orientation={horizontal ? 'vertical' : 'horizontal'} aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(horizontal ? 100 - ratio : ratio)} tabIndex={0} data-testid={testId} title={text('Drag to resize · Arrow keys to adjust', 'Потяните для изменения размера · Клавиши со стрелками')} onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      const bounds = event.currentTarget.getBoundingClientRect();
      drag.current = { pointer: event.pointerId, offset: horizontal ? event.clientX - bounds.left : event.clientY - bounds.top };
      setDragging(true);
    }} onPointerMove={event => {
      if (drag.current?.pointer !== event.pointerId || !container.current) return;
      const bounds = container.current.getBoundingClientRect();
      const position = horizontal ? event.clientX - bounds.left : event.clientY - bounds.top;
      const value = (position - drag.current.offset) / Math.max(1, (horizontal ? bounds.width : bounds.height) - 6) * 100;
      setRatio(clamp(horizontal ? 100 - value : value));
    }} onPointerUp={event => { if (drag.current?.pointer === event.pointerId) { drag.current = null; setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId); } }} onLostPointerCapture={() => { drag.current = null; setDragging(false); }} onPointerCancel={() => { drag.current = null; setDragging(false); }} onDoubleClick={() => setRatio(38)} onKeyDown={event => {
      if (!(horizontal ? ['ArrowLeft', 'ArrowRight', 'Home', 'End'] : ['ArrowUp', 'ArrowDown', 'Home', 'End']).includes(event.key)) return;
      event.preventDefault();
      setRatio(previous => clamp(event.key === 'Home' ? (horizontal ? 100 : 0) : event.key === 'End' ? (horizontal ? 0 : 100) : previous + (horizontal ? (event.key === 'ArrowLeft' ? 1 : -1) : (event.key === 'ArrowDown' ? 1 : -1)) * (event.shiftKey ? 10 : 2)));
    }} />{second}</>}
  </div>;
}
function FilesPanel({ workspace, active, paneId, cwd }: { workspace: Workspace; active: boolean; paneId?: string; cwd: string }) {
  const [directories, setDirectories] = useState<Record<string, Directory>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState(''); const [content, setContent] = useState<FileContent | null>(null);
  const [selected, setSelected] = useState(''); const [reading, setReading] = useState(false);
  const latestRead = useRef(0); const initialized = useRef(false); const alive = useRef(true);
  const generation = useRef(0); const listRequests = useRef(new Map<string, number>());
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; latestRead.current++; }; }, []);
  async function load(path = '') {
    const epoch = generation.current, request = (listRequests.current.get(path) ?? 0) + 1;
    listRequests.current.set(path, request);
    const valid = () => alive.current && epoch === generation.current && request === listRequests.current.get(path);
    setLoading(previous => new Set(previous).add(path)); setError('');
    try { const result = await bridge().call<Directory>('files.list', { workspaceId: workspace.id, paneId, path }); if (valid()) setDirectories(previous => ({ ...previous, [path]: result })); }
    catch (error) { if (valid()) setError(errorMessage(error)); }
    finally { if (valid()) setLoading(previous => { const next = new Set(previous); next.delete(path); return next; }); }
  }
  useEffect(() => { if (active && !initialized.current) { initialized.current = true; void load(); } }, [active]);
  async function open(entry: Entry) {
    if (entry.type === 'directory') {
      const isExpanded = expanded.has(entry.path);
      setExpanded(previous => { const next = new Set(previous); if (isExpanded) next.delete(entry.path); else next.add(entry.path); return next; });
      if (!isExpanded && !directories[entry.path] && !loading.has(entry.path)) void load(entry.path);
      return;
    }
    const request = ++latestRead.current, epoch = generation.current;
    const key = JSON.stringify([workspace.id, paneId, cwd, entry.path]), draft = getFileDraft(key);
    if (draft && !draft.saving && draft.text === draft.expectedText) setFileDraft(key);
    const valid = () => alive.current && epoch === generation.current && request === latestRead.current;
    const previewIntent = beginPreviewIntent(`files:${workspace.id}:${paneId ?? 'workspace'}`, epoch);
    setSelected(entry.path); setReading(true); setContent(null); setError('');
    try {
      const result = await bridge().call<FileContent>('files.read', { workspaceId: workspace.id, paneId, path: entry.path });
      if (valid()) {
        setContent(result);
        previewPresented(previewIntent);
      }
    }
    catch (error) { if (valid()) setError(errorMessage(error)); }
    finally { if (valid()) setReading(false); }
  }
  function entries(path: string, depth = 0): ReactNode {
    const directory = directories[path];
    if (!directory) return loading.has(path) ? <div className="tree-note" style={{ paddingLeft: 14 + depth * 14 }}>{t("Загрузка…")}</div> : null;
    return <>{directory.entries.map(entry => <div key={entry.path}>
      <button data-testid="file-entry" data-path={entry.path} className={`file-entry ${selected === entry.path ? 'selected' : ''}`} style={{ paddingLeft: 12 + depth * 14 }} title={entry.path} aria-expanded={entry.type === 'directory' ? expanded.has(entry.path) : undefined} onClick={() => void open(entry)}>
        {entry.type === 'directory' ? <>{expanded.has(entry.path) ? <ChevronDown className="tree-chevron" /> : <ChevronRight className="tree-chevron" />}{expanded.has(entry.path) ? <FolderOpen /> : <Folder />}</> : <><span className="tree-chevron" />{ /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(entry.name) ? <FileImage /> : <FileText />}</>}
        <span>{entry.name}</span>{entry.type === 'symlink' && <small>{t("ссылка")}</small>}
      </button>{entry.type === 'directory' && expanded.has(entry.path) && entries(entry.path, depth + 1)}
    </div>)}{!directory.entries.length && <div className="tree-note" style={{ paddingLeft: 30 + depth * 14 }}>{t("Папка пуста")}</div>}{directory.truncated && <div className="tree-note">{t("Показаны первые 2000 записей.")}</div>}</>;
  }
  return <div className="tool-tab-content files-panel" hidden={!active}>
    <div className="tool-subheader" data-testid="files-root" data-pane-id={paneId} data-cwd={cwd}><Folder /><span title={cwd}>{cwd}</span><button className="icon-button" aria-label={t("Обновить файлы")} title={t("Обновить файлы")} disabled={loading.size > 0} onClick={() => { generation.current++; latestRead.current++; setDirectories({}); setLoading(new Set()); setExpanded(new Set([''])); setSelected(''); setContent(null); setReading(false); void load(); }}><RefreshCw /></button></div>
    {error && <Message error>{error}</Message>}
    <ToolSplit horizontal label={text('Resize file tree and preview', 'Изменить размер дерева файлов и предпросмотра')} testId="files-content-resizer" first={<div className="file-tree" aria-label={t("Файлы проекта")}>{entries('')}</div>}
    second={selected ? <div className="file-preview" data-testid="file-preview"><div className="preview-heading"><File /><span title={selected}>{selected}</span>{content && <small>{sizeLabel(content.size)}</small>}<button className="icon-button" aria-label={t("Закрыть просмотр файла")} onClick={() => { latestRead.current++; setSelected(''); setContent(null); setReading(false); }}><X /></button></div>
      {reading ? <Message>{t("Чтение файла…")}</Message> : content?.kind === 'image' ? <div className="image-preview"><img src={content.dataUrl} alt={content.path} data-testid="image-preview" /></div> : content?.kind === 'text' ? <><FileEditor key={selected} content={content} workspaceId={workspace.id} paneId={paneId} cwd={cwd} onReload={() => void open({ name: selected, path: selected, type: 'file', size: 0 })} />{content.truncated && <div className="preview-note">{t("Предпросмотр ограничен 512 КБ.")}</div>}</> : content?.kind === 'binary' ? <Message>{t("Двоичный файл ·")} {sizeLabel(content.size)}{t(". Предпросмотр недоступен.")}</Message> : null}
    </div> : undefined} />
  </div>;
}
function GitPanel({ workspace, active, paneId }: { workspace: Workspace; active: boolean; paneId?: string }) {
  const [status, setStatus] = useState<GitState | null>(null); const [loading, setLoading] = useState(false);
  const [error, setError] = useState(''); const [selected, setSelected] = useState<string>();
  const [diff, setDiff] = useState(''); const [staged, setStaged] = useState(false); const [reading, setReading] = useState(false);
  const request = useRef(0); const statusRequest = useRef(0); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; statusRequest.current++; }; }, []);
  async function refresh() {
    const id = ++statusRequest.current;
    setLoading(true); setError('');
    try { const result = await bridge().call<GitState>('git.status', { workspaceId: workspace.id, paneId }); if (alive.current && id === statusRequest.current) setStatus(result); }
    catch (error) { if (alive.current && id === statusRequest.current) setError(errorMessage(error)); }
    finally { if (alive.current && id === statusRequest.current) setLoading(false); }
  }
  useEffect(() => { if (active) void refresh(); }, [active]);
  async function showDiff(path: string, cached = false) {
    const id = ++request.current; setSelected(path); setStaged(cached); setReading(true); setError(''); setDiff('');
    try { const result = await bridge().call<{ text: string }>('git.diff', { workspaceId: workspace.id, paneId, path, staged: cached }); if (alive.current && id === request.current) setDiff(result.text); }
    catch (error) { if (alive.current && id === request.current) setError(errorMessage(error)); }
    finally { if (alive.current && id === request.current) setReading(false); }
  }
  return <div className="tool-tab-content git-panel" hidden={!active}>
    <div className="tool-subheader"><GitBranch /><span title={status?.branch}>{status?.branch || 'Git'}</span><button className="icon-button" aria-label={t("Обновить Git")} title={t("Обновить Git")} disabled={loading} onClick={() => { void refresh(); if (selected) void showDiff(selected, staged); }}><RefreshCw /></button></div>
    {error && <Message error>{error}</Message>}{loading && !status && <Message>{t("Проверка репозитория…")}</Message>}
    {status && !status.available && <Message>{status.error || t("В стартовом каталоге нет доступного Git-репозитория.")}</Message>}
    {status?.available && <ToolSplit label={text('Resize Git files and diff', 'Изменить размер списка Git и изменений')} testId="git-content-resizer" first={<div className="git-files" data-testid="git-status">{status.entries.length ? status.entries.map(entry => <button key={entry.path} className={`git-file ${selected === entry.path ? 'selected' : ''}`} data-testid="git-entry" data-path={entry.path} title={entry.path} onClick={() => void showDiff(entry.path, entry.worktree.trim() === '' && entry.index.trim() !== '')}><FileText /><span>{entry.path}</span><code title={t("Индекс: {0}; рабочее дерево: {1}", entry.index || t("без изменений"), entry.worktree || t("без изменений"))}>{`${entry.index || ' '}${entry.worktree || ' '}`}</code></button>) : <Message>{t("Рабочее дерево чистое.")}</Message>}</div>}
      second={selected ? <div className="git-preview"><div className="preview-heading"><span title={selected}>{selected}</span><div className="diff-switch" role="group" aria-label={t("Источник изменений")}><button aria-pressed={!staged} onClick={() => void showDiff(selected, false)}>{t("Рабочая копия")}</button><button aria-pressed={staged} onClick={() => void showDiff(selected, true)}>{t("Индекс")}</button></div></div>{reading ? <Message>{t("Чтение изменений…")}</Message> : diff ? <pre className="diff-preview" data-testid="git-diff">{diff.split('\n').map((line, index) => <span key={index} className={line.startsWith('+++') || line.startsWith('---') ? 'diff-meta' : line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line}{'\n'}</span>)}</pre> : <Message>{t("В выбранном источнике нет текстовых изменений.")}</Message>}</div> : undefined} />}
    <div className="tool-footer-note">{t("Просмотр изменений. Команды Git выполняются в терминале.")}</div>
  </div>;
}
export function WorkspaceTools({ workspace, activePaneId, requestedBrowser, tab, visible, expanded, onTab, onExpand, onClose }: { workspace: Workspace; activePaneId?: string; requestedBrowser?: { url: string; serial: number }; tab: ToolTab | null; visible: boolean; expanded: boolean; onTab(tab: ToolTab): void; onExpand(): void; onClose(): void }) {
  const [visited, setVisited] = useState<Set<ToolTab>>(new Set());
  const pane = workspace.panes.find(item => item.id === activePaneId) ?? selectedPane(workspace, {});
  const cwd = pane?.cwd || workspace.cwd;
  // Remount each filesystem view on pane/cwd changes, with a view prefix to keep sibling keys unique.
  const rootKey = JSON.stringify([workspace.id, pane?.id, cwd]);
  useEffect(() => { if (visible && tab) setVisited(previous => previous.has(tab) ? previous : new Set(previous).add(tab)); }, [visible, tab]);
  return <aside className={`workspace-tools ${expanded ? 'expanded' : ''}`} hidden={!visible || !tab} aria-label={t("Инструменты проекта")} data-testid="workspace-tools" data-workspace-id={workspace.id}><div className="tools-heading"><div className="tool-tabs" role="tablist" aria-label={t("Инструменты проекта")}>{([{ id: 'files', label: t("Файлы"), Icon: Folder }, { id: 'git', label: 'Git', Icon: GitBranch }, { id: 'browser', label: t("Браузер"), Icon: Globe }] as const).map(({ id, label, Icon }) => <button key={id} role="tab" aria-selected={tab === id} data-testid={`tool-tab-${id}`} onClick={() => onTab(id)}><Icon />{label}</button>)}</div><button className="icon-button" aria-label={expanded ? t("Уменьшить инструменты") : t("Расширить инструменты")} title={expanded ? t("Уменьшить") : t("Расширить")} onClick={onExpand}>{expanded ? <Minimize2 /> : <Maximize2 />}</button><button className="icon-button" aria-label={t("Закрыть инструменты")} onClick={onClose}><X /></button></div>
    {visited.has('files') && <FilesPanel key={`files:${rootKey}`} workspace={workspace} paneId={pane?.id} cwd={cwd} active={visible && tab === 'files'} /> }
    {visited.has('git') && <GitPanel key={`git:${rootKey}`} workspace={workspace} paneId={pane?.id} active={visible && tab === 'git'} /> }
    {visited.has('browser') && <BrowserPanel active={visible && tab === 'browser'} requested={requestedBrowser} />}
  </aside>;
}
