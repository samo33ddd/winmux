import { useRef, useState, useSyncExternalStore } from 'react';
import Markdown from 'react-markdown';
import { bridge } from './types';
import { getLanguage } from './i18n';
import { getFileDraft, hasUnsavedFiles, saveFileDraft, setFileDraft, subscribeFileDrafts } from './fileDrafts';
import { fileLanguage, HighlightedCode } from './HighlightedCode';

window.addEventListener('beforeunload', event => { if (hasUnsavedFiles()) { event.preventDefault(); event.returnValue = ''; } });
const lineEndings = (text: string) => text.replace(/\r\n/g, '\n');
const label = (ru: string, en: string) => getLanguage() === 'ru' ? ru : en;

export function FileEditor({ content, workspaceId, paneId, cwd, onReload }: { content: { path: string; text?: string; truncated?: boolean }; workspaceId: string; paneId?: string; cwd: string; onReload(): void }) {
  const key = JSON.stringify([workspaceId, paneId, cwd, content.path]);
  const draft = useSyncExternalStore(subscribeFileDrafts, () => getFileDraft(key));
  const original = draft?.expectedText ?? content.text ?? '';
  const value = draft?.text ?? content.text ?? '';
  const [preview, setPreview] = useState(/\.(md|markdown)$/i.test(content.path));
  const saving = Boolean(draft?.saving), error = draft?.error;
  const language = fileLanguage(content.path);
  const overlay = useRef<HTMLPreElement>(null);
  const dirty = lineEndings(value) !== lineEndings(original);
  async function save() {
    if (!dirty || saving || content.truncated) return;
    const text = original.includes('\r\n') ? value.replace(/\r?\n/g, '\r\n') : value;
    setFileDraft(key, { text, expectedText: original });
    await saveFileDraft(key, draft => bridge().call('files.write', { workspaceId, paneId, path: content.path, text: draft.text, expectedText: draft.expectedText }));
  }
  return <>
    <div className="file-editor-toolbar">
      <div className="diff-switch"><button aria-pressed={!preview} onClick={() => setPreview(false)}>{label('Текст', 'Text')}</button>{/\.(md|markdown)$/i.test(content.path) && <button aria-pressed={preview} onClick={() => setPreview(true)}>{label('Предпросмотр', 'Preview')}</button>}</div>
      <span role="status">{dirty ? label('Не сохранено', 'Unsaved') : ''}</span>
      <button disabled={saving} onClick={() => {
        if (dirty && !window.confirm(label('Отменить несохранённые изменения?', 'Discard unsaved changes?'))) return;
        setFileDraft(key); onReload();
      }}>{label('Перечитать', 'Reload')}</button>
      <button disabled={!dirty || saving || content.truncated} onClick={() => void save()}>{saving ? label('Сохранение…', 'Saving…') : label('Сохранить', 'Save')}</button>
    </div>
    {error && <div className="tool-message inline-error" role="alert">{error}</div>}
    {preview ? <div className="markdown-preview" data-testid="markdown-preview"><Markdown skipHtml components={{ a: ({ children }) => <span>{children}</span>, img: ({ alt }) => <span>{alt}</span>, code: ({ children, className }) => <HighlightedCode value={String(children)} language={className?.replace(/^language-/, '')} className={className} /> }}>{value}</Markdown></div> : <div className={`file-editor-surface ${language ? 'has-highlighting' : ''}`}>
      {language && <pre ref={overlay} className="text-preview syntax-overlay" aria-hidden="true"><HighlightedCode value={value + '\n'} language={language} /></pre>}
      <textarea className="text-preview file-editor" data-testid="text-preview" aria-label={label('Содержимое файла', 'File content')} spellCheck={false} readOnly={Boolean(content.truncated) || saving} value={value} onChange={event => {
        if (!saving) setFileDraft(key, { text: event.target.value, expectedText: original });
      }} onScroll={event => { if (overlay.current) { overlay.current.scrollTop = event.currentTarget.scrollTop; overlay.current.scrollLeft = event.currentTarget.scrollLeft; } }} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); } }} />
    </div>}
  </>;
}
