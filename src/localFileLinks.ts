import type { IBufferRange, ILinkProvider, Terminal } from '@xterm/xterm';

export interface LocalFileMatch {
  text: string;
  path: string;
  start: number;
  end: number;
}

export type TerminalLinkTarget = { kind:'file'; value:string } | { kind:'external'; value:string };

export function classifyTerminalLink(raw: string): TerminalLinkTarget | null {
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) return { kind:'external', value };
  const filePath = normalizeLocalFileLink(value);
  return filePath ? { kind:'file', value:filePath } : null;
}

function trimToken(value: string) {
  let end = value.length;
  while (end && /[.,;:!?]+$/.test(value.slice(0, end))) end--;
  while (end && /[)\]}]/.test(value[end - 1])) end--;
  return value.slice(0, end);
}

export function normalizeLocalFileLink(raw: string): string | null {
  let value = trimToken(raw.trim().replace(/^["']|["']$/g, ''));
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return null;
  if (/^(?:javascript|data|https?):/i.test(value)) return null;
  const remotePath = (candidate: string) => candidate.replace(/\\/g, '/').startsWith('//');
  if (remotePath(value)) return null;

  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'file:' || !['', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) return null;
      value = decodeURIComponent(url.pathname);
      if (/[\x00-\x1f\x7f]/.test(value) || remotePath(value)) return null;
      if (/^\/[A-Za-z]:[\\/]/.test(value)) value = value.slice(1).replace(/\//g, '\\');
    } catch {
      return null;
    }
  }

  value = value.replace(/(?::\d+){1,2}$/, '');
  if (!value || /^(?:javascript|data|https?):/i.test(value)) return null;
  return value;
}

function looksLikeFile(value: string) {
  return /^(?:file:|[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)/i.test(value)
    || (/[\\/]/.test(value) && /\.[A-Za-z0-9]{1,12}(?::\d+(?::\d+)?)?$/.test(value))
    || /\b[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|webp|bmp|ico|avif|svg|txt|md|json|js|mjs|cjs|ts|tsx|jsx|css|html|ya?ml|xml|log|py|rs|go|java|cs|cpp|c|h|sh|ps1)(?::\d+(?::\d+)?)?$/i.test(value);
}

export function findLocalFileLinks(line: string): LocalFileMatch[] {
  const found: Array<{ start:number; end:number; text:string; path:string }> = [];
  const protectedSpans = Array.from(line.matchAll(/https?:\/\/[^\s"'<>]+/gi), match => ({
    start:match.index || 0,
    end:(match.index || 0) + match[0].length,
  }));
  const add = (start:number, end:number, raw:string, allowProtected = false) => {
    const text = trimToken(raw);
    end = start + text.length;
    if (!text || !looksLikeFile(text)) return;
    if (!allowProtected && protectedSpans.some(span => start < span.end && end > span.start)) return;
    const filePath = normalizeLocalFileLink(text);
    if (filePath) found.push({ start, end, text, path:filePath });
  };

  for (const match of line.matchAll(/(["'])(.*?)\1/g)) {
    const start = (match.index || 0) + 1;
    add(start, start + match[2].length, match[2]);
  }
  for (const match of line.matchAll(/\bfile:\/\/[^\s"'<>]+/gi)) {
    const start = match.index || 0, end = start + match[0].length;
    protectedSpans.push({ start, end });
    add(start, end, match[0], true);
  }
  for (const match of line.matchAll(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|?*]+/g)) {
    add(match.index || 0, (match.index || 0) + match[0].length, match[0]);
  }
  for (const match of line.matchAll(/(?<![A-Za-z0-9+.-])(?:\.{1,2}[\\/]|[A-Za-z0-9_.-]+[\\/])[^\s"'<>|?*]+/g)) {
    add(match.index || 0, (match.index || 0) + match[0].length, match[0]);
  }
  for (const match of line.matchAll(/(?<![A-Za-z0-9])\/(?![/])[^\s"'<>]+/g)) {
    add(match.index || 0, (match.index || 0) + match[0].length, match[0]);
  }
  for (const match of line.matchAll(/\b[A-Za-z0-9_.-]+\.(?:png|jpe?g|gif|webp|bmp|ico|avif|svg|txt|md|json|js|mjs|cjs|ts|tsx|jsx|css|html|ya?ml|xml|log|py|rs|go|java|cs|cpp|c|h|sh|ps1)(?::\d+(?::\d+)?)?\b/gi)) {
    add(match.index || 0, (match.index || 0) + match[0].length, match[0]);
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end);
  return found.filter((item, index) => !found.slice(0, index).some(previous => item.start < previous.end && item.end > previous.start))
    .map(item => ({ ...item }));
}

interface CellUnit {
  x:number;
  y:number;
  width:number;
}

function range(match: LocalFileMatch, units: CellUnit[]): IBufferRange {
  const start = units[match.start];
  const end = units[Math.max(0, match.end - 1)];
  if (!start || !end) return { start:{ x:1, y:1 }, end:{ x:1, y:1 } };
  return {
    start:{ x:start.x + 1, y:start.y },
    end:{ x:end.x + end.width, y:end.y },
  };
}

export function showFileLinkTooltip(container: HTMLElement, event: MouseEvent, label: string) {
  container.querySelector('.local-file-link-tooltip')?.remove();
  const tooltip = document.createElement('div');
  tooltip.className = 'local-file-link-tooltip xterm-hover';
  tooltip.textContent = label;
  const bounds = container.getBoundingClientRect();
  tooltip.style.left = `${Math.max(8, event.clientX - bounds.left + 10)}px`;
  tooltip.style.top = `${Math.max(8, event.clientY - bounds.top + 14)}px`;
  container.appendChild(tooltip);
}

export function hideFileLinkTooltip(container: HTMLElement) {
  container.querySelector('.local-file-link-tooltip')?.remove();
}

export function createLocalFileLinkProvider(terminal: Pick<Terminal, 'buffer' | 'element'>, open: (path:string) => void, tooltip = (path:string) => `Open in Winmux: ${path}`): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      let startLine = bufferLineNumber - 1;
      while (startLine > 0 && terminal.buffer.active.getLine(startLine)?.isWrapped) startLine--;
      let endLine = startLine;
      while (terminal.buffer.active.getLine(endLine + 1)?.isWrapped) endLine++;
      const rows = Array.from({ length:endLine - startLine + 1 }, (_, index) => terminal.buffer.active.getLine(startLine + index));
      if (rows.some(row => !row)) { callback(undefined); return; }
      let text = '';
      const units: CellUnit[] = [];
      rows.forEach((row, rowIndex) => {
        const trimRight = rowIndex === rows.length - 1;
        let lastNonSpace = -1;
        for (let x = 0; x < row!.length; x++) if (row!.getCell(x)?.getChars().trim()) lastNonSpace = x;
        const columns = trimRight ? Math.min(row!.length, lastNonSpace + 1) : row!.length;
        for (let x = 0; x < columns; x++) {
          const cell = row!.getCell(x);
          if (!cell || cell.getWidth() === 0) continue;
          const chars = cell.getChars() || ' ';
          text += chars;
          for (let index = 0; index < chars.length; index++) units.push({ x, y:startLine + rowIndex + 1, width:cell.getWidth() });
        }
      });
      const links = findLocalFileLinks(text).map(match => ({
        range:range(match, units),
        text:match.text,
        activate:(event: MouseEvent) => { if (event.ctrlKey && event.button === 0) { event.preventDefault(); open(match.path); } },
        hover:(event: MouseEvent) => terminal.element && showFileLinkTooltip(terminal.element, event, tooltip(match.path)),
        leave:() => terminal.element && hideFileLinkTooltip(terminal.element),
      }));
      callback(links.length ? links : undefined);
    },
  };
}
