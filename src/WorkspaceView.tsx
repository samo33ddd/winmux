import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';
import { TerminalPane, type TerminalHandle } from './TerminalPane';
import type { Direction, LayoutNode, Settings, Workspace } from './types';
import { activeTab } from './workspaceTabs';

type Rect = { left: number; top: number; width: number; height: number };
type Divider = Rect & { id: string; direction: Direction; ratio: number; bounds: Rect };
export function measureLayout(node: LayoutNode, bounds: Rect, panes: Map<string, Rect>, dividers: Divider[]) {
  if (node.type === 'leaf') { panes.set(node.paneId, bounds); return; }
  const horizontal = node.direction === 'horizontal';
  const length = horizontal ? bounds.width : bounds.height;
  const gap = Math.min(8, length);
  const available = Math.max(0, length - gap);
  const first = available * Math.max(0.1, Math.min(0.9, node.ratio));
  const second = available - first;
  const a = { ...bounds, ...(horizontal ? { width: first } : { height: first }) };
  const b = { ...bounds, ...(horizontal ? { left: bounds.left + first + gap, width: second } : { top: bounds.top + first + gap, height: second }) };
  dividers.push({ id: node.id, direction: node.direction, ratio: node.ratio, bounds, ...bounds, ...(horizontal ? { left: bounds.left + first, width: gap } : { top: bounds.top + first, height: gap }) });
  measureLayout(node.first, a, panes, dividers); measureLayout(node.second, b, panes, dividers);
}
function minimumSize(node: LayoutNode): { width: number; height: number } {
  if (node.type === 'leaf') return { width: 300, height: 160 };
  const a = minimumSize(node.first), b = minimumSize(node.second);
  const ratio = Math.max(0.1, Math.min(0.9, node.ratio));
  return node.direction === 'horizontal'
    ? { width: Math.ceil(Math.max(a.width / ratio, b.width / (1 - ratio)) + 8), height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: Math.ceil(Math.max(a.height / ratio, b.height / (1 - ratio)) + 8) };
}
function withRatio(node: LayoutNode, id: string, ratio: number): LayoutNode {
  if (node.type === 'leaf') return node;
  return { ...node, ratio: node.id === id ? ratio : node.ratio, first: withRatio(node.first, id, ratio), second: withRatio(node.second, id, ratio) };
}
interface Props {
  workspace: Workspace; settings: Settings; visible: boolean; activePane?: string; zoomed?: string; unreadPaneIds: string[];
  register(id: string, handle: TerminalHandle | null): void; onFocus(id: string): void;
  onSplit(id: string, direction: Direction): void; onClose(id: string): void; onZoom(id: string): void;
  onRatio(workspaceId: string, splitId: string, ratio: number): Promise<void>; onError(message: string): void;
}
export function WorkspaceView(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<{ id: string; ratio: number } | null>(null);
  const dragRef = useRef<{ divider: Divider; ratio: number } | null>(null);
  useEffect(() => {
    const element = container.current; if (!element) return;
    const update = () => { if (element.clientWidth && element.clientHeight) setSize({ width: element.clientWidth, height: element.clientHeight }); };
    const observer = new ResizeObserver(update); observer.observe(element); update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!props.visible) { dragRef.current = null; setDrag(null); } }, [props.visible]);
  const rects = new Map<string, Rect>(); const dividers: Divider[] = [];
  const tab = activeTab(props.workspace);
  const root = drag ? withRatio(tab.root, drag.id, drag.ratio) : tab.root;
  measureLayout(root, { left: 0, top: 0, ...size }, rects, dividers);
  const zoomed = props.zoomed && rects.has(props.zoomed) ? props.zoomed : undefined;
  const minimum = zoomed ? { width: 300, height: 160 } : minimumSize(tab.root);
  return <div className="workspace-viewport" id={`terminal-panel-${props.workspace.id}`} role="tabpanel" aria-labelledby={`terminal-tab-${tab.id}`} style={{ display: props.visible ? undefined : 'none' }}><div ref={container} className="workspace-canvas" style={{ minWidth: minimum.width, minHeight: minimum.height }} aria-label={props.workspace.name}>
    {props.workspace.panes.map(pane => <TerminalPane key={pane.id} pane={pane} settings={props.settings}
      unread={props.unreadPaneIds.includes(pane.id)} active={props.activePane === pane.id} zoomed={zoomed === pane.id} visible={props.visible && rects.has(pane.id) && (!zoomed || zoomed === pane.id)}
      style={zoomed === pane.id ? { left: 0, top: 0, width: size.width, height: size.height } : rects.get(pane.id) ?? { left: 0, top: 0, width: 0, height: 0 }}
      register={props.register} onFocus={props.onFocus} onSplit={props.onSplit} onClose={props.onClose} onZoom={props.onZoom} onError={props.onError} />)}
    {!zoomed && dividers.map(divider => <div key={divider.id} className={`split-divider ${divider.direction} ${drag?.id === divider.id ? 'dragging' : ''}`}
      style={{ left: divider.left, top: divider.top, width: divider.width, height: divider.height }}
      role="separator" tabIndex={0} aria-label={t("Размер панелей")} aria-orientation={divider.direction === 'horizontal' ? 'vertical' : 'horizontal'} aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(divider.ratio * 100)}
      onDoubleClick={() => void props.onRatio(props.workspace.id, divider.id, 0.5)}
      onKeyDown={event => {
        const increase = divider.direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
        const decrease = divider.direction === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
        if (event.key !== increase && event.key !== decrease && event.key !== 'Home') return;
        event.preventDefault(); event.stopPropagation();
        const ratio = event.key === 'Home' ? 0.5 : Math.max(0.1, Math.min(0.9, divider.ratio + (event.key === increase ? 0.05 : -0.05)));
        void props.onRatio(props.workspace.id, divider.id, ratio);
      }}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { divider, ratio: divider.ratio }; setDrag({ id: divider.id, ratio: divider.ratio }); }}
      onPointerMove={event => {
        const session = dragRef.current; const box = container.current?.getBoundingClientRect(); if (!session || !box) return;
        const { bounds, direction } = session.divider;
        const extent = direction === 'horizontal' ? bounds.width : bounds.height;
        const position = direction === 'horizontal' ? event.clientX - box.left - bounds.left : event.clientY - box.top - bounds.top;
        const ratio = Math.max(0.1, Math.min(0.9, position / Math.max(1, extent - 8)));
        session.ratio = ratio; setDrag({ id: session.divider.id, ratio });
      }}
      onPointerUp={event => {
        const session = dragRef.current; if (!session) return; dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        void props.onRatio(props.workspace.id, session.divider.id, session.ratio).finally(() => setDrag(null));
      }}
      onPointerCancel={() => { dragRef.current = null; setDrag(null); }} />)}
  </div></div>;
}
