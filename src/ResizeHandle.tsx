import { useEffect, useRef, useState } from 'react';

export function ResizeHandle({value, min, max, reverse = false, label, testId, onChange}: {
  value:number; min:number; max:number; reverse?:boolean; label:string; testId:string; onChange(value:number):void;
}) {
  const drag = useRef<{x:number; value:number} | null>(null);
  const [dragging,setDragging] = useState(false);
  const clamp = (next:number) => Math.round(Math.max(min,Math.min(max,next)));
  useEffect(() => () => { document.body.classList.remove('panel-resizing'); }, []);
  function end() { drag.current=null; setDragging(false); document.body.classList.remove('panel-resizing'); }
  return <><div role="separator" aria-orientation="vertical" aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)} tabIndex={0} data-testid={testId} className="panel-resize-handle"
    onPointerDown={event => { if(event.button!==0)return; event.preventDefault(); drag.current={x:event.clientX,value}; event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); document.body.classList.add('panel-resizing'); }}
    onPointerMove={event => { if(drag.current)onChange(clamp(drag.current.value+(event.clientX-drag.current.x)*(reverse?-1:1))); }}
    onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onKeyDown={event => { if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return; event.preventDefault(); onChange(event.key==='Home'?min:event.key==='End'?max:clamp(value+(event.key==='ArrowRight'?20:-20)*(reverse?-1:1))); }}
    onDoubleClick={() => onChange(clamp(reverse?400:224))} />{dragging && <div className="panel-resize-shield" />}</>;
}

export function usePanelWidth(key:string, fallback:number, min:number, max:number) {
  const [width,setWidth] = useState(() => {
    try { const raw=localStorage.getItem(key), n=raw===null?fallback:Number(raw); return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback; } catch { return fallback; }
  });
  useEffect(() => { try { localStorage.setItem(key,String(width)); } catch { /* Resizing remains available without storage. */ } }, [key,width]);
  return [width,setWidth] as const;
}
