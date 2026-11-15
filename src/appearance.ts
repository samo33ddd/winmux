import type { ITheme } from '@xterm/xterm';
export type ThemeId = 'dark' | 'midnight' | 'nord' | 'dracula' | 'light' | 'sand' | `custom-${string}`;
export interface Palette {
  id: ThemeId; name: string; scheme: 'dark' | 'light';
  bg: string; surface: string; raised: string; border: string; text: string;
  muted: string; accent: string; selection: string; hover: string;
}
export const palettes: Palette[] = [
  { id:'dark', name:'Graphite', scheme:'dark', bg:'#0d0f10', surface:'#141719', raised:'#1a1e20', border:'#292e30', text:'#dfe5e1', muted:'#8e9993', accent:'#91bea6', selection:'#1d2b24', hover:'#1a1e20' },
  { id:'midnight', name:'Midnight', scheme:'dark', bg:'#101523', surface:'#171f31', raised:'#222d43', border:'#35435d', text:'#e1e9fa', muted:'#a3b4d2', accent:'#99bbff', selection:'#263c61', hover:'#222f49' },
  { id:'nord', name:'Nord', scheme:'dark', bg:'#252c38', surface:'#2e3440', raised:'#3b4252', border:'#4c566a', text:'#eceff4', muted:'#b4c1d4', accent:'#88c0d0', selection:'#3c5261', hover:'#384353' },
  { id:'dracula', name:'Dracula', scheme:'dark', bg:'#20212b', surface:'#282a36', raised:'#343746', border:'#505368', text:'#f8f8f2', muted:'#b8b8d0', accent:'#bd93f9', selection:'#493a60', hover:'#373747' },
  { id:'light', name:'Paper', scheme:'light', bg:'#ebece9', surface:'#f8f9f6', raised:'#ffffff', border:'#d6dad5', text:'#1f2421', muted:'#626b66', accent:'#477b60', selection:'#dfe9e2', hover:'#e3e6e2' },
  { id:'sand', name:'Sand', scheme:'light', bg:'#eee8dc', surface:'#faf6ed', raised:'#fffbf4', border:'#d5cbb9', text:'#3a3328', muted:'#736551', accent:'#865321', selection:'#e9d8bb', hover:'#e8e0d1' },
];
export const colorKeys = ['bg','surface','raised','border','text','muted','accent','selection','hover'] as const;
export function validatePalette(value: unknown): Palette {
  const p = value as Palette;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^custom-[a-z0-9-]{1,64}$/.test(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 40 || !['dark','light'].includes(p.scheme) || colorKeys.some(key => typeof p[key] !== 'string' || !/^#[a-f0-9]{6}$/i.test(p[key]))) throw new Error('Invalid theme: a name, light/dark scheme and six-digit hex colors are required.');
  return {id:p.id,name:p.name.trim(),scheme:p.scheme,...Object.fromEntries(colorKeys.map(key => [key,p[key]]))} as Palette;
}
export function allPalettes() { return [...palettes,...preferences.customThemes]; }
export function paletteFor(id: ThemeId) { return allPalettes().find(item => item.id === id) ?? palettes[0]; }
export function terminalTheme(id: ThemeId): ITheme {
  const p = paletteFor(id), light = p.scheme === 'light';
  return {
    background:p.surface, foreground:p.text, cursor:p.accent, cursorAccent:p.surface,
    selectionBackground:p.selection, black:light?'#26332c':'#222629',
    red:light?'#a53232':'#f099a3', green:light?'#317045':'#a3d9ad', yellow:light?'#8c681b':'#e8cc91',
    blue:light?'#2b6095':'#9cbfee', magenta:light?'#825494':'#cbb0ef', cyan:light?'#267479':'#95d5d2', white:p.text,
    brightBlack:p.muted, brightRed:light?'#bc4141':'#ffb1b8', brightGreen:light?'#3a8252':'#bee9c4',
    brightYellow:light?'#99741f':'#f6dfae', brightBlue:light?'#3576b0':'#bed6ff',
    brightMagenta:light?'#9562a9':'#e0c9ff', brightCyan:light?'#28858b':'#b5edeb', brightWhite:light?'#ffffff':'#ffffff',
  };
}
export interface Preferences {
  customThemes: Palette[];
  theme?: ThemeId; fontFamily: 'Cascadia Code' | 'Consolas' | 'Courier New';
  lineHeight: number; cursorStyle: 'bar' | 'block' | 'underline'; cursorBlink: boolean;
  copyOnSelect: boolean; scrollback: number; showWorkspacePaths: boolean;
}
export const defaults: Preferences = {
  customThemes: [],
  fontFamily:'Cascadia Code', lineHeight:1.14, cursorStyle:'bar', cursorBlink:true,
  copyOnSelect:true, scrollback:10000, showWorkspacePaths:false,
};
const storageKey = 'winmux.appearance';
function readPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    const customThemes: Palette[] = [];
    for (const value of (Array.isArray(saved.customThemes) ? saved.customThemes : []).slice(0,20)) {
      try { const p=validatePalette(value); if (!customThemes.some(item => item.id === p.id)) customThemes.push(p); } catch { /* Ignore malformed custom themes without losing valid preferences. */ }
    }
    return {
      ...defaults,
      customThemes,
      ...([...palettes,...customThemes].some(p => p.id === saved.theme) ? {theme:saved.theme} : {}),
      ...(['Cascadia Code','Consolas','Courier New'].includes(saved.fontFamily) ? {fontFamily:saved.fontFamily} : {}),
      ...([1,1.14,1.3,1.5].includes(saved.lineHeight) ? {lineHeight:saved.lineHeight} : {}),
      ...(['bar','block','underline'].includes(saved.cursorStyle) ? {cursorStyle:saved.cursorStyle} : {}),
      ...([1000,5000,10000].includes(saved.scrollback) ? {scrollback:saved.scrollback} : {}),
      ...(typeof saved.cursorBlink === 'boolean' ? {cursorBlink:saved.cursorBlink} : {}),
      ...(typeof saved.copyOnSelect === 'boolean' ? {copyOnSelect:saved.copyOnSelect} : {}),
      ...(typeof saved.showWorkspacePaths === 'boolean' ? {showWorkspacePaths:saved.showWorkspacePaths} : {}),
    };
  } catch { return {...defaults}; }
}
let preferences = readPreferences();
const listeners = new Set<() => void>();
export const getPreferences = () => preferences;
export function subscribePreferences(listener: () => void) { listeners.add(listener); return () => {listeners.delete(listener);}; }
export function savePreferences(values: Partial<Preferences>) {
  const next = {...preferences,...values};
  localStorage.setItem(storageKey,JSON.stringify(next));
  preferences = next; listeners.forEach(listener => listener());
}
export function saveCustomTheme(value: Palette) {
  const theme = validatePalette(value), others = preferences.customThemes.filter(item => item.id !== theme.id);
  if (others.length >= 20) throw new Error('You can save up to 20 custom themes.');
  savePreferences({customThemes:[...others,theme],theme:theme.id});
}
window.addEventListener('storage',event => {
  if (event.key === storageKey || event.key === null) { preferences = readPreferences(); listeners.forEach(listener => listener()); }
});
