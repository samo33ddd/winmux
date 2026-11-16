import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';
import { useMemo } from 'react';

hljs.registerLanguage('powershell', powershell);
const extensions: Record<string, string> = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', cs: 'csharp', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', java: 'java', kt: 'kotlin', go: 'go', swift: 'swift', sh: 'bash', bash: 'bash', ps1: 'powershell', psm1: 'powershell', html: 'xml', htm: 'xml', svg: 'xml', xml: 'xml', css: 'css', scss: 'scss', json: 'json', yaml: 'yaml', yml: 'yaml', sql: 'sql', ini: 'ini', toml: 'ini', php: 'php', lua: 'lua' };
export function fileLanguage(path: string) { const language = extensions[path.split('.').pop()?.toLowerCase() ?? '']; return language && hljs.getLanguage(language) ? language : undefined; }
export function HighlightedCode({ value, language, className }: { value: string; language?: string; className?: string }) {
  const html = useMemo(() => language && hljs.getLanguage(language) ? hljs.highlight(value, { language, ignoreIllegals: true }).value : undefined, [value, language]);
  // Only highlight.js output is HTML; the library escapes the source text.
  return html === undefined ? <code className={className}>{value}</code> : <code className={`hljs ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
