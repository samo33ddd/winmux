import { getLanguage } from './i18n';

export function filePreviewErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = raw
    .replace(/^Error invoking remote method ['"]winmux:call['"]:\s*/i, '')
    .replace(/^(?:Error:\s*)+/i, '')
    .trim();
  const missing = /^File not found:\s*(.+)$/i.exec(detail);
  if (missing) {
    return getLanguage() === 'ru'
      ? `Файл не найден: ${missing[1]}`
      : `File not found: ${missing[1]}`;
  }
  if (getLanguage() === 'ru') {
    return detail ? `Не удалось открыть файл: ${detail}` : 'Не удалось открыть файл.';
  }
  return detail ? `Could not open file: ${detail}` : 'Could not open file.';
}
