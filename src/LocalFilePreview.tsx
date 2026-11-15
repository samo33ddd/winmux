import { useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Modal } from './Dialogs';
import { t } from './i18n';
import { bridge, type FilePreviewEvent } from './types';
import { previewPresented } from './previewCoordinator';

function sizeLabel(size: number) {
  if (size < 1024) return t('{0} Б', size);
  if (size < 1024 * 1024) return t('{0} КБ', (size / 1024).toFixed(1));
  return t('{0} МБ', (size / (1024 * 1024)).toFixed(1));
}

export function LocalFilePreview() {
  const [preview, setPreview] = useState<FilePreviewEvent | null>(null);
  const [actualSize, setActualSize] = useState(false);

  useEffect(() => {
    const unsubscribe = bridge().onEvent(event => {
      if (event.type !== 'file-preview') return;
      previewPresented();
      setActualSize(false);
      setPreview(event);
    });
    return unsubscribe;
  }, []);

  if (!preview) return null;
  return <Modal title={preview.name} className="local-file-preview-modal" onClose={() => setPreview(null)}>
    <div className="local-file-preview-meta">
      <code title={preview.path}>{preview.path}</code>
      <span>{sizeLabel(preview.size)}</span>
      {preview.kind === 'image' && <button className="icon-button" aria-label={actualSize ? t('Вписать изображение') : t('Показать изображение в масштабе 100%')} title={actualSize ? t('Вписать изображение') : t('Показать изображение в масштабе 100%')} onClick={() => setActualSize(value => !value)}>{actualSize ? <Minimize2 /> : <Maximize2 />}</button>}
    </div>
    {preview.kind === 'image' && <div className={`local-file-image ${actualSize ? 'is-actual-size' : ''}`}><img src={preview.dataUrl} alt={preview.name} data-testid="local-file-image" /></div>}
    {preview.kind === 'text' && <><pre className="local-file-text" data-testid="local-file-text">{preview.text || t('Пустой файл')}</pre>{preview.truncated && <p className="local-file-note">{t('Предпросмотр ограничен 512 КБ.')}</p>}</>}
    {preview.kind === 'binary' && <p className="local-file-binary" data-testid="local-file-binary">{t('Двоичный файл ({0}). Предпросмотр в приложении недоступен.', sizeLabel(preview.size))}</p>}
  </Modal>;
}
